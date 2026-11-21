import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lock, BusyError, digest, optionalJson, writeJson } from "../infra/files.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { alive } from "../infra/exec.ts";
import { git, gitText, changes } from "../infra/git.ts";
import { taskOf, statusOf, update, move, transition, waitFor, inputs, checked, appendCheck, checksOf, answersOf, fail, PHASES, type Task } from "./store.ts";
import { checkAttempt, checkWorktree, clearCheck, operationPath, run } from "./run.ts";
import { copyLocalFiles, heartbeat, retryReview, setup } from "./lifecycle.ts";
import { executeStaticReview } from "./review-call.ts";
import { onTaskBranch, undeliveredCommit } from "./deliver.ts";
import { testLogSummary } from "./test-summary.ts";
import { snapshot, differences } from "./snapshot.ts";
export interface SettleResult { continue: boolean; reason: string }
interface SettleOptions { signal?: AbortSignal; reviewOnly?: boolean; confirmedCommit?: string; ending?: {stopReason?: string; errorMessage?: string} }
const quiet = (reason = ""): SettleResult => ({continue:false, reason});
function backToDevelopment(dir: string, reason: string): SettleResult {
  transition(dir,"working","开发中",reason,"developmentMs"); return {continue:true, reason};
}
function returnToDeveloper(dir: string, kind: "test" | "review", reason: string): SettleResult {
  const s = update(dir, (s) => { if (kind === "test") s.loop.testReturns++; else s.loop.reviewReturns++; });
  const [count, max, label, cause] = kind === "test" ? [s.loop.testReturns, s.loop.testAllowance, "复测", "复测退回到上限"] as const
    : [s.loop.reviewReturns, s.loop.reviewAllowance, "评审必修", "评审必修到上限"] as const;
  if (count >= max) {
    waitFor(dir, cause, label + "退回 " + count + " 次，已到上限。可选：再给一轮（bin/loop 续跑）/ 停止 / 接受未验证（bin/loop 合入 " + taskOf(dir).executionId + " --接受未验证）。\n" + reason); return quiet(reason);
  }
  return backToDevelopment(dir, reason);
}
/** 三家宿主共用的唯一推进点；聊天、忽略文件、日志丢失均不参与通过资格判断。 */
export async function settle(dir: string, lastReply = "", {signal, reviewOnly, confirmedCommit, ending}: SettleOptions = {}): Promise<SettleResult> {
  let release: (() => void) | undefined, remove = () => {}, pulse: ReturnType<typeof setInterval> | undefined, task: Task | undefined, ownStart = 0, selfBefore = 0;
  let hashes = { promptHash: "", acceptanceHash: "" };
  const selfTime = () => update(dir, (s) => { if (s.state === "working" || s.state === "completed") { s.loop.bucket = "selfMs"; s.timeLimitSec = null; } });
  try {
    try { release = lock(operationPath(dir), confirmedCommit ? 2000 : 0); }
    catch (e) { if (e instanceof BusyError) return quiet("该任务的交付/检查正在处理中"); throw e; }
    const t = taskOf(dir), initial = statusOf(dir);
    if (confirmedCommit && (initial.state !== "working" || initial.loop.phase !== "已交付" || initial.loop.delivery?.commit !== confirmedCommit)) return quiet();
    if (initial.loop.released || initial.loop.releasePending) return quiet(initial.loop.released ? "工作区已释放" : "等待释放工作区");
    if (alive(initial.loop.finisher)) return quiet("正在收尾");
    if (initial.state === "working" && initial.loop.finisher) { waitFor(dir,"收尾没走完","收尾进程已退出，可运行 bin/loop 收尾 " + t.executionId + " 手工接手。"); return quiet("等你"); }
    if (["cancelled", "input_required", "failed"].includes(initial.state)) return quiet(initial.message);
    if (!initial.loop.ready) return quiet("工作区正在准备");
    pulse = setInterval(() => heartbeat(dir), 60000); pulse.unref();
    task = t; ownStart = Date.now(); selfBefore = initial.loop.durations.selfMs; selfTime();
    const [commit,currentTree] = gitText(t.worktree,["rev-parse","HEAD","HEAD^{tree}"]).split("\n"), delivery = initial.loop.delivery, dirty = changes(t.worktree);
    if (dirty.length || !delivery || commit !== delivery.commit || currentTree !== delivery.tree || (confirmedCommit && !onTaskBranch(t))) {
      const candidate = dirty.length || undeliveredCommit(t, initial, commit) ? digest(JSON.stringify([commit, dirty.sort()])) : "";
      const scene = "当前提交：" + commit + "\n上次登记：" + (delivery?.commit || "还没登记");
      if (candidate && !initial.loop.remindedCandidates?.includes(candidate)) {
        const reason = (delivery ? "交付后又改了，尚未交付。" : "尚未交付。") + "\n" + scene +
          "\n做完请" + (delivery ? "重新" : "") + "运行 " + APP_ROOT + "/bin/loop 交付。";
        const s = update(dir,s => { if (move(s,"working","开发中",reason,"developmentMs")) (s.loop.remindedCandidates ||= []).push(candidate); });
        return s.state === "cancelled" ? quiet(s.message) : {continue:true, reason};
      }
      const error = ending?.stopReason === "error" ? ending.errorMessage || lastReply || "（无出错详情）" : "";
      const reason = candidate ? ["候选仍未交付；可查询执行、续跑开发或停止。",scene,error||lastReply].filter(Boolean).join("\n")
        : error ? "模型出错；可续跑开发或停止。\n"+error : delivery ? "工作区与登记的交付不符；请检查任务分支和 HEAD。\n"+scene
        : lastReply || "开发方未交付；可续跑开发或停止。";
      waitFor(dir, !candidate && error ? "模型出错" : "停下没交付", reason); return quiet(reason);
    }
    const {prompt, acceptance, ...requirements} = inputs(t); hashes = requirements;
    const complete = (testResult?: string) => {
      const reused = testResult === undefined;
      if (t.after?.length || t.next) {
        if (initial.loop.afterCommit !== commit) {
          update(dir, s => { if (move(s,"working","收尾中","复测、评审通过，等待收尾","selfMs")) s.loop.afterCommit = commit; });
          return quiet("收尾");
        }
        const needsManual = reused ? ["开发中","已交付"].includes(initial.loop.phase) : initial.state !== "completed";
        if (needsManual) waitFor(dir,"收尾没走完","同一 commit 不重复自动收尾；请修改后交付或运行 bin/loop 收尾 " + t.executionId);
        else if (!reused) transition(dir,"completed",initial.loop.phase,"沿用此 commit 已走完的收尾",null);
        return quiet(needsManual && reused ? "等你" : "沿用");
      }
      if (reused && PHASES.indexOf(initial.loop.phase) > PHASES.indexOf("完成")) return quiet("沿用");
      const message = reused ? "沿用此 commit 的复测与评审通过记录" : "此 commit 复测" + (testResult === "没验证" ? "没验证（" + t.test + "）" : "通过") + "，评审通过";
      update(dir, s => { if (move(s,"completed","完成",message,null) && reused) s.loop.reused = true; });
      return quiet(reused ? "沿用" : "完成");
    };
    if (checked(dir, commit, hashes)) return complete();
    const reviewTest = reviewOnly ? retryReview(dir) : undefined;
    if (reviewOnly && !reviewTest) return backToDevelopment(dir,"评审续跑条件已变化，请重新交付。");
    const record = (step: string, result: string, start: number, evidence: string[], detail?: string) => appendCheck(dir, {
      commit, tree: delivery.tree, step, result, startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString(),
      durationMs: Date.now() - start, evidence, ...hashes, detail: detail || undefined,
    });
    const cwd = checkWorktree(dir), attempt = checkAttempt(dir), timeout = t.limits.测试.timeoutMin * 60;
    const attemptKey = (startedAt: string) => digest(JSON.stringify([commit,hashes,startedAt]));
    const reuse = reviewTest && existsSync(join(cwd,".git")) && optionalJson<string>(attempt) === attemptKey(reviewTest.startedAt);
    let keep = false; remove = () => { if (!keep) clearCheck(t); };
    const pinned = {...t, worktree:cwd}, log = join(dir,"test-"+commit+".log"), deadline = ownStart + timeout * 1000;
    if (!reuse) { clearCheck(t); gitText(t.repo,["worktree","add","--detach","--force",cwd,commit]); copyLocalFiles(pinned); }
    const verifyPin = () => {
      const state = git(cwd,["--no-optional-locks","status","--porcelain=v2","--branch","--untracked-files=no"]);
      if (!state.startsWith("# branch.oid " + commit + "\n") || /^[^#\r\n]/m.test(state)) throw new Error("隔离检出偏离交付 " + commit + "；未登记本步骤通过");
    };
    if (!reviewTest) transition(dir,"working","复测中","正在复测："+t.test,"testMs",timeout);
    verifyPin();
    if (!reuse && t.config.setup) { await setup(pinned,"check-setup-"+commit+".log",signal,deadline-Date.now()); verifyPin(); }
    let testResult = reviewTest?.result || "没验证";
    if (!reviewTest) {
      const start = Date.now(), result = /^无\s*[:：]/.test(t.test) ? undefined : await run(pinned,"sh",["-c",t.test],deadline-Date.now(),signal);
      selfTime();
      writeFileSync(log, result ? result.output + (result.killed ? "\n复测超时或取消\n" : "") : t.test + "\n");
      if (statusOf(dir).state === "cancelled") { record("复测", "已停止", start, [log]); return quiet("已停止"); }
      if (result && (result.code !== 0 || result.killed)) {
        const lines = result.output.trimEnd().split(/\r?\n/);
        const reason = ["复测失败" + (result.killed ? "（超时或取消）" : "") + "，请修复后重新交付。", "命令：" + t.test,
          "输出最后 60 行：", ...lines.slice(-60), "error/fail 行：", ...lines.filter(s => /error|fail/i.test(s))].join("\n");
        record("复测", "失败", start, [log], reason);
        return returnToDeveloper(dir, "test", reason);
      }
      verifyPin(); writeJson(attempt,attemptKey(new Date(start).toISOString()));
      record("复测",testResult = result ? "通过" : "没验证",start,[log],"命令："+t.test);
    }
    const runtime = join(dir,"snapshot-"+commit+".json");
    if (!reviewTest && statusOf(dir).state !== "cancelled") await snapshot(pinned,cwd,commit,runtime,"scenario",{deadline,signal});
    const afterTest = statusOf(dir); if (afterTest.state === "cancelled") return quiet("已停止");
    const previous = afterTest.loop, round = previous.reviewRounds + 1, reviewSeconds = t.limits.开发评审.timeoutMin * 60;
    const lastReview = checksOf(dir).findLast(c => c.step === "评审" && c.commit === previous.previousReviewCommit && ["通过", "必修"].includes(c.result));
    const sameRequirement = lastReview?.promptHash === hashes.promptHash && lastReview?.acceptanceHash === hashes.acceptanceHash;
    const base = sameRequirement && previous.previousReviewCommit ? previous.previousReviewCommit : t.baseCommit;
    const diff = (...flags: string[]) => git(cwd,["diff","--no-ext-diff","--no-textconv",...flags,base,commit,"--"]);
    const deleted = diff("--no-renames","--numstat","--diff-filter=D","-z").split("\0").filter(Boolean).map(entry => {
      const [, lines, ...path] = entry.split("\t"); return path.join("\t") + "（" + (lines === "-" ? "二进制，行数不适用" : "原 " + lines + " 行") + "）";
    });
    const material = ["## 提示词原文", prompt, ...(acceptance ? ["## 验收标准", acceptance] : []),
      "## 本轮改动", !sameRequirement && previous.previousReviewCommit ? "需求已变化，以下为起点至本次交付的完整 diff。" : "", diff("--no-renames","--diff-filter=d") || "（无改动）",
      "## 删除的文件", deleted.join("\n") || "无", "## 新增文件", diff("--name-only","--diff-filter=A","-z").split("\0").filter(Boolean).join("\n") || "无",
      "## 运行差异", git(cwd,["diff","--name-only",t.baseCommit,commit,"--"]), differences(join(dir,"snapshot-base.json"),runtime),
      "## 开发方交付说明", delivery.note || lastReply || "（无）", "## 本人答复", answersOf(dir).map(a => a.at + "\n" + a.text).join("\n\n") || "无", "## 复测结果", testLogSummary(t.test, testResult, log),
      ...(previous.previousReviewCommit ? ["## 上一轮必修", previous.previousMustFix.join("\n") || "无", "## 开发方回复", lastReply || delivery.note || "（无）"] : [])].join("\n\n");
    update(dir, s => { if (move(s,"working","评审中","正在评审第 " + round + " 轮","reviewMs",reviewSeconds)) s.loop.reviewRounds = round; });
    const reviewStart = Date.now(), budget = reviewSeconds * 1000 + Math.min(0,deadline-reviewStart);
    const outcome = await executeStaticReview(pinned,round,material,budget,signal); selfTime();
    if (statusOf(dir).state === "cancelled") { record("评审", "已停止", reviewStart, outcome.evidence); return quiet("已停止"); }
    verifyPin();
    if (!outcome.review) {
      keep = !outcome.contextOverflow && (!reviewTest || Boolean(reuse));
      record("评审","失败",reviewStart,outcome.evidence,outcome.error);
      fail(dir,outcome.error || "评审调用失败",outcome.contextOverflow ? "评审上下文超限" : "临时故障"); return quiet(outcome.error);
    }
    const mustFix = outcome.review.mustFix;
    record("评审", mustFix.length ? "必修" : "通过", reviewStart, outcome.evidence, mustFix.join("\n"));
    update(dir, (s) => { s.loop.previousMustFix = mustFix; s.loop.previousReviewCommit = commit; });
    const latest = inputs(t);
    if (latest.promptHash !== hashes.promptHash || latest.acceptanceHash !== hashes.acceptanceHash) return backToDevelopment(dir,"提示词或验收标准在检查期间变化，请重新交付后检查。");
    return mustFix.length ? returnToDeveloper(dir,"review","评审必修：\n" + mustFix.map((s,i) => (i+1) + ". " + s).join("\n") + "\n修好后重新运行 bin/loop 交付；请逐条回复。") : complete(testResult);
  } catch (e) {
    if (release) fail(dir, e); return quiet(e instanceof Error ? e.message : String(e));
  } finally {
    try { clearInterval(pulse);
      if (task && ownStart) update(dir, s => {
        if (s.loop.bucket === "selfMs") s.loop.bucket = s.state === "working" ? s.loop.phase === "收尾中" ? "selfMs" : "developmentMs" : null;
        appendCheck(dir, { commit: s.loop.commit || task!.baseCommit, tree: s.loop.delivery?.tree || "", step: "dev-loop 自身",
          result: s.loop.reused ? "沿用" : s.state === "failed" ? "失败" : "推进", startedAt: new Date(ownStart).toISOString(), endedAt: new Date().toISOString(),
          durationMs: Math.max(0, s.loop.durations.selfMs - selfBefore), evidence: [], ...hashes });
      });
    } finally { try { remove(); } finally { release?.(); } }
  }
}
