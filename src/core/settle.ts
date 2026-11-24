import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lock, BusyError, digest, optionalJson, writeJson, span, withLock, errorText, iso } from "../infra/files.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { alive, retireGroup } from "../infra/exec.ts";
import { git, gitText, changes, checkPin } from "../infra/git.ts";
import { taskOf, statusOf, update, move, waitFor, waiting, inputs, sameInputs, checked, reviewFor, matchesReviewRequest, appendCheck, checksOf, answersOf, fail, PHASES, ENV_WAIT, type Check, type Hashes, type Task, type WaitReason } from "./store.ts";
import { checkAttempt, checkWorktree, clearCheck, operationPath, projectCommand } from "./run.ts";
import { copyLocalFiles, heartbeat, retryReview, recordedAttempt, environmentMessage, environmentAcceptable } from "./lifecycle.ts";
import { planE2e, e2eResult } from "./e2e.ts";
import { executeStaticReview, projectReviewMaterial, windowNoteMaterial } from "./review-call.ts";
import { onTaskBranch, undeliveredCommit } from "./deliver.ts";
import { reviewTestSummary, clip, legacyResult } from "./test-summary.ts";
import { snapshot, differences } from "./snapshot.ts";
export interface SettleResult { continue: boolean; reason: string; retained?: boolean }
interface SettleOptions { signal?: AbortSignal; reviewRequest?: string; confirmedCommit?: string; retest?: string; ending?: {stopReason?: string; errorMessage?: string} }
const quiet = (reason = ""): SettleResult => ({continue:false,reason});
const park = (dir: string, cause: WaitReason, reason: string) => { waitFor(dir,cause,reason); return quiet(reason); };
function backToDevelopment(dir: string, problem: string | Check, test = false, retained = false): SettleResult {
  const review = typeof problem === "string" ? undefined : problem, items = review?.detail?.split("\n") || [];
  const reason = typeof problem === "string" ? problem : `评审必修：\n${items.map((s,i)=>`${i+1}. ${s}`).join("\n")}\n修好后重新运行 bin/loop 交付；请逐条回复。`;
  const s = update(dir,s => {
    if (s.state === "cancelled") return; if (!test && !review) return void move(s,"working","开发中",reason,"developmentMs");
    delete s.loop.retestAttempt;
    if (review) Object.assign(s.loop,{previousReviewCommit:review.commit,previousMustFix:items});
    const [count,max,label,cause] = test ? [++s.loop.testReturns,s.loop.testAllowance,"复测","复测退回到上限"] as const
      : [++s.loop.reviewReturns,s.loop.reviewAllowance,"评审必修","评审必修到上限"] as const;
    if (count >= max) return waiting(s,cause,`${label}退回 ${count} 次，已到上限。可选：再给一轮（bin/loop 续跑）/ 停止 / 接受未验证（bin/loop 合入 ${s.executionId} --接受未验证）。\n${reason}`);
    if (move(s,"working","开发中",reason,"developmentMs") && retained) Object.assign(s.loop,{pendingReturn:reason,pendingOpening:false});
  });
  return {continue:s.state === "working",reason,retained};
}
/** 三家宿主共用的唯一推进点；聊天、忽略文件、日志丢失均不参与通过资格判断。 */
export async function settle(dir: string, lastReply = "", {signal, reviewRequest, confirmedCommit, retest, ending}: SettleOptions = {}): Promise<SettleResult> {
  let release: (() => void) | undefined, clean = () => {}, pulse: ReturnType<typeof setInterval> | undefined;
  let started: {at:number; selfMs:number; task:Task} | undefined, hashes: Hashes = {promptHash:"",acceptanceHash:""};
  const reviewOnly = reviewRequest !== undefined;
  const selfTime = () => update(dir, (s) => { if (s.state === "working" || s.state === "completed") { s.loop.bucket = "selfMs"; s.timeLimitSec = null; } });
  try {
    if (reviewOnly && !matchesReviewRequest(statusOf(dir),reviewRequest)) return quiet();
    try { release = lock(operationPath(dir), reviewOnly || confirmedCommit || retest ? 2000 : 0); }
    catch (e) { if (!(e instanceof BusyError)) throw e; return quiet("该任务的交付/检查正在处理中"); } // 等锁超时不消费请求。
    const initial = statusOf(dir), {loop,state,message} = initial;
    if (confirmedCommit && (state !== "working" || loop.phase !== "已交付" || loop.delivery?.commit !== confirmedCommit)) return quiet();
    if (reviewOnly ? !matchesReviewRequest(initial,reviewRequest) : retest ? state !== "working" || loop.phase !== "复测中" || loop.retestAttempt !== retest
      : loop.reviewRequest || loop.retestAttempt && ["复测中","评审中"].includes(loop.phase)) return quiet();
    if (loop.released || loop.releasePending || alive(loop.finisher)) return quiet(loop.released ? "工作区已释放" : loop.releasePending ? "等待释放工作区" : "正在收尾");
    if (state === "working" && loop.finisher) return park(dir,"收尾没走完",`收尾进程已退出，可运行 bin/loop 收尾 ${initial.executionId} 手工接手。`);
    if (["cancelled","input_required","failed"].includes(state)) return quiet(message); if (!loop.ready) return quiet("工作区正在准备");
    if ((retest || reviewOnly) && loop.activeProcess) {
      await retireGroup(loop.activeProcess); if (update(dir,s => { s.loop.activeProcess = null; }).state === "cancelled") return quiet("已停止");
    }
    const t = taskOf(dir), ownStart = Date.now(); started = {at:ownStart,selfMs:loop.durations.selfMs,task:t};
    pulse = setInterval(() => heartbeat(dir),60000); pulse.unref(); selfTime();
    const [commit,currentTree] = gitText(t.worktree,["rev-parse","HEAD","HEAD^{tree}"]).split("\n"), {delivery} = loop, dirty = changes(t.worktree);
    if (dirty.length || !delivery || commit !== delivery.commit || currentTree !== delivery.tree || ((confirmedCommit || retest) && !onTaskBranch(t))) {
      const candidate = dirty.length || undeliveredCommit(t,initial,commit) ? digest(JSON.stringify([commit,dirty.sort()])) : "";
      const scene = `当前提交：${commit}\n上次登记：${delivery?.commit || "还没登记"}`;
      if (candidate && !loop.remindedCandidates?.includes(candidate)) {
        const reason = `${delivery ? "交付后又改了，尚未交付。" : "尚未交付。"}\n${scene}\n做完请${delivery ? "重新" : ""}运行 ${APP_ROOT}/bin/loop 交付。`;
        const s = update(dir,s => { if (move(s,"working","开发中",reason,"developmentMs")) (s.loop.remindedCandidates ||= []).push(candidate); });
        return s.state === "cancelled" ? quiet(s.message) : {continue:true, reason};
      }
      const error = ending?.stopReason === "error" ? ending.errorMessage || lastReply || "（无出错详情）" : "";
      const reason = candidate ? ["候选仍未交付；可查询执行、续跑开发或停止。",scene,error||lastReply].filter(Boolean).join("\n")
        : error ? "模型出错；可续跑开发或停止。\n"+error : delivery ? "工作区与登记的交付不符；请检查任务分支和 HEAD。\n"+scene
        : lastReply || "开发方未交付；可续跑开发或停止。";
      return park(dir,!candidate && error ? "模型出错" : "停下没交付",reason);
    }
    const {prompt,acceptance,e2e,...requirements} = inputs(t), records = checksOf(dir), {phase} = loop; hashes = requirements;
    const complete = (result?: string) => {
      const reused = result === undefined;
      if (t.after?.length || t.next) {
        if (e2e && result === "没验证") return park(dir,"收尾没走完","评审通过，但接入卡没有执行复测命令，不能自动收尾或接力。");
        if (loop.afterCommit !== commit) {
          update(dir,s => { if (move(s,"working","收尾中","复测、评审通过，等待收尾","selfMs")) s.loop.afterCommit = commit; }); return quiet("收尾");
        }
        const manual = reused ? ["开发中","已交付"].includes(phase) : state !== "completed";
        if (manual) return park(dir,"收尾没走完",`同一 commit 不重复自动收尾；请修改后交付或运行 bin/loop 收尾 ${t.executionId}`);
        if (!reused) update(dir,s => move(s,"completed",phase,"沿用此 commit 已走完的收尾",null));
      } else if (!reused || PHASES.indexOf(phase) <= PHASES.indexOf("完成")) {
        const message = reused ? "沿用此 commit 的复测与评审通过记录" : `此 commit 复测${result === "没验证" ? `没验证（${t.test}）` : result}，评审通过`;
        update(dir,s => { if (move(s,"completed","完成",message,null) && reused) s.loop.reused = true; });
      }
      return quiet(reused ? "沿用" : "完成");
    };
    if (checked(dir, commit, hashes)) return complete();
    const saved = retest && recordedAttempt(initial,records); let test = reviewOnly ? retryReview(dir) : saved && sameInputs(saved,hashes) ? saved : undefined;
    if (reviewOnly && !test) return backToDevelopment(dir,"评审续跑条件已变化，请重新交付。");
    const record = (step: string, start: number, data: Pick<Check,"result"|"detail"|"evidence"|"attempt"|"missingScenarios"|"unit">) => withLock(join(dir,"status.lock"), () => {
      const c: Check = {commit,tree:delivery.tree,step,...span(start),...hashes,...data,result:statusOf(dir).state === "cancelled" ? "已停止" : data.result}; appendCheck(dir,c); return c;
    });
    const cwd = checkWorktree(t.dir), marker = checkAttempt(t.dir), timeout = t.limits.测试.timeoutMin*60, pinned = {...t,worktree:cwd}, deadline = ownStart+timeout*1000;
    const attemptKey = (c: Pick<Check,"attempt"|"startedAt">) => c.attempt || digest(JSON.stringify([commit,hashes,c.startedAt]));
    const reuse = test && existsSync(join(cwd,".git")) && optionalJson<string>(marker) === attemptKey(test);
    let keep = false; clean = () => { if (!keep) clearCheck(t); };
    const sendBack = (review: Check) => backToDevelopment(dir,review,false,!!(retest || reviewOnly || confirmedCommit)), restored = retest && test ? reviewFor(records,test) : undefined;
    if (restored?.result === "必修") return sendBack(restored);
    const verifyPin = () => checkPin(cwd,commit);
    const currentInputs = () => sameInputs(hashes,inputs(t)), changed = () => backToDevelopment(dir,"提示词、验收标准或 E2E 清单在检查期间变化，请重新交付后检查。");
    const attempt = !test && e2e ? retest && !existsSync(join(dir,"e2e",retest)) ? retest : randomUUID() : undefined;
    if (!test) update(dir,s => { if (move(s,"working","复测中","正在复测："+t.test,"testMs",timeout)) s.loop.retestAttempt = attempt; });
    if (statusOf(dir).state === "cancelled") return quiet("已停止"); const plan = e2e && attempt ? planE2e(t,commit,attempt,hashes,e2e) : undefined;
    if (!reuse && !["环境未验证","失败"].includes(test?.result || "")) {
      clearCheck(t); gitText(t.repo,["worktree","add","--detach","--force",cwd,commit]); copyLocalFiles(pinned); verifyPin();
      await projectCommand(pinned,"setup",plan ? join(plan.dir,"setup.log") : join(dir,"check-setup-"+commit+".log"),{deadline,signal});
    }
    if (!test) {
      const start = Date.now(), log = plan ? join(plan.dir,"test.log") : join(dir,"test-"+commit+".log");
      verifyPin();
      const result = await projectCommand(pinned,"test",log,{deadline,signal,planEnv:{LOOP_E2E_DIR:plan?.dir}});
      selfTime();
      if (statusOf(dir).state === "cancelled") { record("复测",start,{result:"已停止",attempt,evidence:[log,...(plan ? [join(plan.dir,"plan.json")] : [])]}); return quiet("已停止"); }
      if (plan && signal?.aborted) throw new Error("复测执行器已中断；可续跑本次交付。原文：" + log);
      const data = plan ? e2eResult(plan,t.test,result) : legacyResult(t.test,log,result);
      if (data.result !== "失败") verifyPin(); writeJson(marker,attemptKey({attempt,startedAt:iso(start)}));
      test = record("复测",start,data);
    }
    if (test.result === "已停止") return quiet("已停止"); if (e2e && !currentInputs()) return changed();
    if (test.result === "环境未验证") return park(dir,ENV_WAIT,environmentMessage(statusOf(dir),test,environmentAcceptable(test)) + "\n" + test.detail);
    if (test.result === "失败") return backToDevelopment(dir,test.attempt ? `复测失败，请修复后重新交付。\n${clip(test.detail || "",8192)}\n原文：${test.evidence[0]}` : test.detail!,true);
    const runtime = join(dir,`snapshot-${commit}.json`);
    if (!test.attempt && !reviewOnly && statusOf(dir).state !== "cancelled") await snapshot(pinned,cwd,commit,runtime,"scenario",{deadline,signal});
    const afterTest = statusOf(dir); if (afterTest.state === "cancelled") return quiet("已停止"); if (!currentInputs()) return changed();
    const {loop:previous} = afterTest, round = previous.reviewRounds+1, reviewSeconds = t.limits.开发评审.timeoutMin*60;
    const lastReview = records.findLast(c => c.step === "评审" && c.commit === previous.previousReviewCommit && ["通过","必修"].includes(c.result));
    const sameRequirement = lastReview && sameInputs(lastReview,hashes), base = sameRequirement && lastReview.commit !== commit ? lastReview.commit : t.baseCommit;
    const diff = (...flags: string[]) => git(cwd,["diff","--no-ext-diff","--no-textconv",...flags,base,commit,"--"]);
    const deleted = diff("--no-renames","--numstat","--diff-filter=D","-z").split("\0").filter(Boolean).map(entry => {
      const [,lines,...path] = entry.split("\t"); return `${path.join("\t")}（${lines === "-" ? "二进制，行数不适用" : `原 ${lines} 行`}）`;
    });
    const material = ["## 提示词原文", prompt, ...(acceptance ? ["## 验收标准", acceptance] : []),
      projectReviewMaterial(t.repo,t.baseCommit), "## 本轮改动", !sameRequirement && previous.previousReviewCommit ? "需求已变化，以下为起点至本次交付的完整 diff。" : "", diff("--no-renames","--diff-filter=d") || "（无改动）",
      "## 删除的文件", deleted.join("\n") || "无", "## 新增文件", diff("--name-only","--diff-filter=A","-z").split("\0").filter(Boolean).join("\n") || "无",
      "## 运行差异", git(cwd,["diff","--name-only",t.baseCommit,commit,"--"]), e2e ? "场景证据见复测摘要" : differences(join(dir,"snapshot-base.json"),runtime),
      "## 开发方交付说明", delivery.note || lastReply || "（无）", "## 本人答复", answersOf(dir).map(a => a.at + "\n" + a.text).join("\n\n") || "无",
      ...windowNoteMaterial(t), "## 复测结果", reviewTestSummary(t.test,test,records),
      ...(previous.previousReviewCommit ? ["## 上一轮必修", previous.previousMustFix.join("\n") || "无", "## 开发方回复", lastReply || delivery.note || "（无）"] : [])].join("\n\n");
    update(dir, s => { if (move(s,"working","评审中","正在评审第 " + round + " 轮","reviewMs",reviewSeconds)) s.loop.reviewRounds = round; });
    const reviewStart = Date.now(), budget = reviewSeconds * 1000 + Math.min(0,deadline-reviewStart);
    const outcome = await executeStaticReview(pinned,round,material,budget,signal), mustFix = outcome.review?.mustFix; selfTime();
    if (statusOf(dir).state !== "cancelled") verifyPin(); const reviewed = record("评审",reviewStart,{result:!mustFix ? "失败" : mustFix.length ? "必修" : "通过",attempt:test.attempt,evidence:outcome.evidence,detail:mustFix?.join("\n") || outcome.error});
    if (reviewed.result === "已停止") return quiet("已停止"); if (!mustFix) {
      keep = !outcome.contextOverflow && (!reviewOnly || Boolean(reuse));
      fail(dir,outcome.error || "评审调用失败",outcome.contextOverflow ? "评审上下文超限" : "临时故障"); return quiet(outcome.error);
    }
    if (!currentInputs()) return changed(); if (mustFix.length) return sendBack(reviewed);
    update(dir,s => { if (s.state !== "cancelled") Object.assign(s.loop,{previousMustFix:[],previousReviewCommit:commit}); });
    return complete(test.result);
  } catch (e) { if (release) fail(dir,e); return quiet(errorText(e)); } finally {
    try { clearInterval(pulse);
      if (started) update(dir,s => {
        const {loop,state} = s, {at,selfMs,task} = started!;
        if (loop.bucket === "selfMs" && loop.phase !== "收尾中") loop.bucket = state === "working" ? "developmentMs" : null;
        appendCheck(dir,{commit:loop.commit || task.baseCommit,tree:loop.delivery?.tree || "",step:"dev-loop 自身",...span(at),...hashes,
          result:loop.reused ? "沿用" : state === "failed" ? "失败" : "推进",durationMs:Math.max(0,loop.durations.selfMs-selfMs),evidence:[]});
      });
    } finally { try { clean(); } finally { release?.(); } }
  }
}
