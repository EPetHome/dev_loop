import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lock, BusyError, digest } from "../infra/files.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { alive } from "../infra/exec.ts";
import { git, head, tree, changes } from "../infra/git.ts";
import { taskOf, statusOf, update, transition, waitFor, inputs, checked, appendCheck, checksOf, answersOf, summary, fail, PHASES, type Check, type Task } from "./store.ts";
import { operationPath, run } from "./run.ts";
import { heartbeat, retryReview } from "./lifecycle.ts";
import { executeStaticReview } from "./review-call.ts";
import { onTaskBranch, undeliveredCommit } from "./deliver.ts";
import { testLogSummary } from "./test-summary.ts";
import { snapshot, differences } from "./snapshot.ts";
export interface SettleResult { continue: boolean; reason: string }
interface SettleOptions {
  signal?: AbortSignal; reviewOnly?: boolean; confirmedCommit?: string;
  ending?: {stopReason?: string; errorMessage?: string};
}
const quiet = (reason = ""): SettleResult => ({ continue: false, reason });
const retry = (reason: string): SettleResult => ({ continue: true, reason });
function returnToDeveloper(dir: string, kind: "test" | "review", reason: string): SettleResult {
  const s = update(dir, (s) => { if (kind === "test") s.loop.testReturns++; else s.loop.reviewReturns++; });
  const count = kind === "test" ? s.loop.testReturns : s.loop.reviewReturns;
  const max = kind === "test" ? s.loop.testAllowance : s.loop.reviewAllowance;
  if (count >= max) {
    waitFor(dir, kind === "test" ? "复测退回到上限" : "评审必修到上限", (kind === "test" ? "复测" : "评审必修") + "退回 " + count + " 次，已到上限。可选：再给一轮（bin/loop 续跑）/ 停止 / 接受未验证（bin/loop 合入 " + taskOf(dir).executionId + " --接受未验证）。\n" + reason);
    return quiet(reason);
  }
  transition(dir, "working", "开发中", reason, "developmentMs");
  return retry(reason);
}
/** 三家宿主共用的唯一推进点；聊天、忽略文件、日志丢失均不参与通过资格判断。 */
export async function settle(dir: string, lastReply = "", {signal, reviewOnly, confirmedCommit, ending}: SettleOptions = {}): Promise<SettleResult> {
  let release: (() => void) | undefined, pulse: ReturnType<typeof setInterval> | undefined, task: Task | undefined, ownStart = 0, selfBefore = 0;
  let hashes = { promptHash: "", acceptanceHash: "" };
  const selfTime = () => update(dir, (s) => { if (s.state === "working" || s.state === "completed") { s.loop.bucket = "selfMs"; s.timeLimitSec = null; } });
  try {
    try { release = lock(operationPath(dir), confirmedCommit ? 2000 : 0); }
    catch (e) { if (e instanceof BusyError) return quiet("该任务的交付/检查正在处理中"); throw e; }
    const t = taskOf(dir), initial = statusOf(dir);
    if (confirmedCommit && (initial.state !== "working" || initial.loop.phase !== "已交付" || initial.loop.delivery?.commit !== confirmedCommit)) return quiet();
    if (initial.loop.released) return quiet("工作区已释放");
    if (alive(initial.loop.finisher)) return quiet("正在收尾");
    if (initial.state === "working" && initial.loop.finisher) { waitFor(dir,"收尾没走完","收尾进程已退出，可运行 bin/loop 收尾 " + t.executionId + " 手工接手。"); return quiet("等你"); }
    if (["cancelled", "input_required", "failed"].includes(initial.state)) return quiet(initial.message);
    if (!initial.loop.ready) return quiet("工作区正在准备");
    pulse = setInterval(() => heartbeat(dir), 60000); pulse.unref();
    task = t; ownStart = Date.now(); selfBefore = initial.loop.durations.selfMs; selfTime();
    const delivery = initial.loop.delivery, commit = head(t.worktree), dirty = changes(t.worktree);
    const modelError = ending?.stopReason === "error" ? ending.errorMessage || lastReply || "（无出错详情）" : "";
    const scene = "当前提交：" + commit + "\n上次登记：" + (delivery?.commit || "还没登记");
    if (dirty.length || undeliveredCommit(t, initial, commit)) {
      const candidate = digest(JSON.stringify([commit, dirty.sort()]));
      if (!initial.loop.remindedCandidates?.includes(candidate)) {
        const reason = "尚未交付。\n" + scene + "\n做完请" + (delivery ? "重新" : "") + "运行 " + APP_ROOT + "/bin/loop 交付。";
        const s = update(dir, s => {
          if (s.state === "cancelled") return;
          (s.loop.remindedCandidates ||= []).push(candidate);
          s.state = "working"; s.loop.phase = "开发中"; s.loop.wait = null;
          s.loop.bucket = "developmentMs"; s.timeLimitSec = null; s.error = null; s.message = reason;
        });
        return s.state === "cancelled" ? quiet(s.message) : retry(reason);
      }
      const reason = ["候选仍未交付；可查询执行、续跑开发或停止。", scene, modelError || lastReply].filter(Boolean).join("\n");
      waitFor(dir, "停下没交付", reason); return quiet(reason);
    }
    // 不用旧 commit 的检查放行回退、分叉或内容相同的新 HEAD。
    if (!delivery || commit !== delivery.commit || tree(t.worktree, commit) !== delivery.tree || (confirmedCommit && !onTaskBranch(t))) {
      if (modelError) {
        const reason = "模型出错；可续跑开发或停止。\n" + modelError;
        waitFor(dir, "模型出错", reason); return quiet(reason);
      }
      const reason = delivery ? "工作区与登记的交付不符；请检查任务分支和 HEAD。\n" + scene : lastReply || "开发方未交付；可续跑开发或停止。";
      waitFor(dir, "停下没交付", reason); return quiet(reason);
    }
    const h = inputs(t); hashes = { promptHash: h.promptHash, acceptanceHash: h.acceptanceHash };
    const finishing = () => {
      update(dir, s => { s.loop.afterCommit = commit; });
      transition(dir, "working", "收尾中", "复测、评审通过，等待收尾", "selfMs");
      return quiet("收尾");
    };
    if (checked(dir, commit, h)) {
      if (t.after?.length || t.next) {
        if (initial.loop.afterCommit !== commit) return finishing();
        if (["开发中", "已交付"].includes(initial.loop.phase)) {
          waitFor(dir, "收尾没走完", "代码没有改动。可运行 bin/loop 收尾 " + t.executionId + " 重试，或修改后重新交付。");
          return quiet("等你");
        }
        return quiet("沿用");
      }
      if (PHASES.indexOf(initial.loop.phase) > PHASES.indexOf("完成")) return quiet("沿用");
      update(dir, (s) => { s.loop.reused = true; });
      transition(dir, "completed", "完成", "沿用此 commit 的复测与评审通过记录", null);
      return quiet("沿用");
    }
    const reviewTest = reviewOnly ? retryReview(dir) : undefined;
    if (reviewOnly && !reviewTest) {
      transition(dir, "working", "开发中", "评审续跑条件已变化，请重新交付。", "developmentMs");
      return retry("评审续跑条件已变化，请重新交付。");
    }
    const record = (step: string, result: string, start: number, evidence: string[], detail = "") => {
      const c: Check = { commit, tree: delivery.tree, step, result, startedAt: new Date(start).toISOString(),
        endedAt: new Date().toISOString(), durationMs: Date.now() - start, evidence,
        promptHash: h.promptHash, acceptanceHash: h.acceptanceHash, ...(detail ? { detail } : {}) };
      appendCheck(dir, c);
    };
    const testStart = Date.now(), log = join(dir, "test-" + commit + ".log");
    let testResult = reviewTest?.result || "";
    if (!reviewTest) {
      transition(dir, "working", "复测中", "正在复测：" + t.test, "testMs", t.limits.测试.timeoutMin * 60);
      if (/^无\s*[:：]/.test(t.test)) {
        testResult = "没验证"; writeFileSync(log, t.test + "\n");
      } else {
        const result = await run(t, "sh", ["-c", t.test], t.limits.测试.timeoutMin * 60000, signal);
        selfTime();
        testResult = result.code === 0 && !result.killed ? "通过" : "失败";
        writeFileSync(log, result.output + (result.killed ? "\n复测超时或取消\n" : ""));
        if (statusOf(dir).state === "cancelled") { record("复测", "已停止", testStart, [log]); return quiet("已停止"); }
        if (testResult === "失败") {
          const lines = result.output.trimEnd().split(/\r?\n/);
          const reason = ["复测失败" + (result.killed ? "（超时或取消）" : "") + "，请修复后重新交付。", "命令：" + t.test,
            "输出最后 60 行：", ...lines.slice(-60), "error/fail 行：", ...lines.filter((s) => /error|fail/i.test(s))].join("\n");
          record("复测", "失败", testStart, [log], reason);
          return returnToDeveloper(dir, "test", reason);
        }
      }
      selfTime();
      record("复测", testResult, testStart, [log], "命令：" + t.test);
    }
    if (statusOf(dir).state === "cancelled") return quiet("已停止");
    const runtime = join(dir,"snapshot-"+commit+".json");
    if (!reviewTest) await snapshot(t,t.worktree,commit,runtime,"scenario",true,signal);
    if (statusOf(dir).state === "cancelled") return quiet("已停止");
    const previous = statusOf(dir).loop, round = previous.reviewRounds + 1;
    update(dir, (s) => { s.loop.reviewRounds = round; });
    const lastReview = checksOf(dir).filter((c) => c.step === "评审" && c.commit === previous.previousReviewCommit && ["通过", "必修"].includes(c.result)).at(-1);
    const sameRequirement = lastReview?.promptHash === h.promptHash && lastReview?.acceptanceHash === h.acceptanceHash;
    const base = sameRequirement && previous.previousReviewCommit ? previous.previousReviewCommit : t.baseCommit;
    const diff = git(t.worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--diff-filter=d", base, commit, "--"]);
    const deleted = git(t.worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "--diff-filter=D", "-z", base, commit, "--"]).split("\0").filter(Boolean).map(entry => {
      const [, lines, ...path] = entry.split("\t"); return path.join("\t") + "（" + (lines === "-" ? "二进制，行数不适用" : "原 " + lines + " 行") + "）";
    });
    const added = git(t.worktree, ["diff", "--name-only", "--diff-filter=A", "-z", base, commit, "--"]).split("\0").filter(Boolean);
    const material = ["## 提示词原文", h.prompt, ...(h.acceptance ? ["## 验收标准", h.acceptance] : []),
      "## 本轮改动", !sameRequirement && previous.previousReviewCommit ? "需求已变化，以下为起点至本次交付的完整 diff。" : "", diff || "（无改动）", "## 删除的文件", deleted.join("\n") || "无", "## 新增文件", added.join("\n") || "无",
      "## 运行差异", git(t.worktree,["diff","--name-only",t.baseCommit,commit,"--"]), differences(join(dir,"snapshot-base.json"),runtime),
      "## 开发方交付说明", delivery.note || lastReply || "（无）", "## 本人答复", answersOf(dir).map(a => a.at + "\n" + a.text).join("\n\n") || "无", "## 复测结果", testLogSummary(t.test, testResult, log),
      ...(previous.previousReviewCommit ? ["## 上一轮必修", previous.previousMustFix.join("\n") || "无", "## 开发方回复", lastReply || delivery.note || "（无）"] : [])].join("\n\n");
    transition(dir, "working", "评审中", "正在评审第 " + round + " 轮", "reviewMs", t.limits.开发评审.timeoutMin * 60);
    const reviewStart = Date.now(), outcome = await executeStaticReview(t, round, material, t.limits.开发评审.timeoutMin * 60000, signal);
    selfTime();
    if (statusOf(dir).state === "cancelled") { record("评审", "已停止", reviewStart, outcome.evidence); return quiet("已停止"); }
    if (!outcome.review) {
      record("评审", "失败", reviewStart, outcome.evidence, outcome.error);
      fail(dir, outcome.error || "评审调用失败", outcome.contextOverflow ? "评审上下文超限" : "临时故障"); return quiet(outcome.error);
    }
    const mustFix = outcome.review.mustFix;
    record("评审", mustFix.length ? "必修" : "通过", reviewStart, outcome.evidence, mustFix.join("\n"));
    update(dir, (s) => { s.loop.previousMustFix = mustFix; s.loop.previousReviewCommit = commit; });
    const latest = inputs(t);
    if (latest.promptHash !== h.promptHash || latest.acceptanceHash !== h.acceptanceHash) {
      transition(dir, "working", "开发中", "提示词或验收标准在检查期间变化，请重新交付后检查。", "developmentMs");
      return retry("提示词或验收标准在检查期间变化，请重新交付后检查。");
    }
    if (mustFix.length) return returnToDeveloper(dir, "review", "评审必修：\n" + mustFix.map((s, i) => (i + 1) + ". " + s).join("\n") + "\n修好后重新运行 bin/loop 交付；请逐条回复。");
    if (t.after?.length || t.next) {
      if (initial.loop.afterCommit !== commit) return finishing();
      if (initial.state === "completed") transition(dir,"completed",initial.loop.phase,"沿用此 commit 已走完的收尾",null);
      else waitFor(dir,"收尾没走完","同一 commit 不重复自动收尾；请修改后交付或手工运行 bin/loop 收尾 " + t.executionId);
      return quiet("沿用");
    }
    transition(dir, "completed", "完成", "此 commit 复测" + (testResult === "没验证" ? "没验证（" + t.test + "）" : "通过") + "，评审通过", null);
    return quiet("完成");
  } catch (e) {
    if (release) fail(dir, e);
    return quiet(e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(pulse);
    try {
      if (task && ownStart) {
        const s = update(dir, (s) => { if (s.loop.bucket === "selfMs") s.loop.bucket = s.state === "working" ? s.loop.phase === "收尾中" ? "selfMs" : "developmentMs" : null; });
        appendCheck(dir, { commit: s.loop.commit || task.baseCommit, tree: s.loop.delivery?.tree || "", step: "dev-loop 自身",
          result: s.loop.reused ? "沿用" : s.state === "failed" ? "失败" : "推进", startedAt: new Date(ownStart).toISOString(), endedAt: new Date().toISOString(),
          durationMs: Math.max(0, s.loop.durations.selfMs - selfBefore), evidence: [], ...hashes });
        summary(dir, s);
      }
    } finally { release?.(); }
  }
}
