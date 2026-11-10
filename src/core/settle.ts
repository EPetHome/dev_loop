import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lock, BusyError } from "../infra/files.ts";
import { git, head, tree, changes } from "../infra/git.ts";
import { taskOf, statusOf, update, transition, inputs, checked, appendCheck, checksOf, summary, fail, type Check, type Task } from "./store.ts";
import { operationPath, run } from "./run.ts";
import { executeStaticReview } from "./review-call.ts";
export interface SettleResult { continue: boolean; reason: string }
const quiet = (reason = ""): SettleResult => ({ continue: false, reason });
const retry = (reason: string): SettleResult => ({ continue: true, reason });
function returnToDeveloper(dir: string, kind: "test" | "review", reason: string): SettleResult {
  const s = update(dir, (s) => { if (kind === "test") s.loop.testReturns++; else s.loop.reviewReturns++; });
  const count = kind === "test" ? s.loop.testReturns : s.loop.reviewReturns;
  const max = kind === "test" ? s.loop.testAllowance : s.loop.reviewAllowance;
  if (count >= max) {
    transition(dir, "input_required", "等你", (kind === "test" ? "复测" : "评审必修") + "退回 " + count + " 次，已到上限。可选：再给一轮（bin/loop 续跑）/ 停止 / 接受未验证（本步只记录决定，不执行合入）。\n" + reason, "inputMs");
    return quiet(reason);
  }
  transition(dir, "working", "开发中", reason, "developmentMs");
  return retry(reason);
}
/** 三家宿主共用的唯一推进点；聊天、忽略文件、日志丢失均不参与通过资格判断。 */
export async function settle(dir: string, lastReply = "", signal?: AbortSignal): Promise<SettleResult> {
  let release: (() => void) | undefined, task: Task | undefined, ownStart = 0, selfBefore = 0;
  let hashes = { promptHash: "", acceptanceHash: "" };
  const selfTime = () => update(dir, (s) => { if (s.state === "working" || s.state === "completed") { s.loop.bucket = "selfMs"; s.timeLimitSec = null; } });
  try {
    try { release = lock(operationPath(dir)); }
    catch (e) { if (e instanceof BusyError) return quiet("该任务的交付/检查正在处理中"); throw e; }
    const t = taskOf(dir), initial = statusOf(dir);
    if (["cancelled", "input_required", "failed"].includes(initial.state)) return quiet(initial.message);
    if (!initial.loop.ready) return quiet("工作区正在准备");
    task = t; ownStart = Date.now(); selfBefore = initial.loop.durations.selfMs; selfTime();
    const delivery = initial.loop.delivery, dirty = changes(t.worktree);
    if (!delivery) {
      if (dirty.length && !initial.loop.warned) {
        update(dir, (s) => { s.loop.warned = true; s.loop.bucket = "developmentMs"; });
        return retry("尚未交付；做完后请运行 bin/loop 交付。");
      }
      transition(dir, "input_required", "等你", lastReply || "开发方未交付；可续跑开发或停止。", "inputMs");
      return quiet(lastReply);
    }
    if (tree(t.worktree) !== delivery.tree || dirty.length) {
      transition(dir, "working", "开发中", "交付后又改了，做完请重新运行 bin/loop 交付。", "developmentMs");
      return retry("交付后又改了，做完请重新运行 bin/loop 交付。");
    }
    const commit = head(t.worktree);
    // HEAD 即使有内容相同的额外提交，也不拿旧 commit 的结论冒充新提交。
    if (commit !== delivery.commit) return retry("HEAD 与登记交付不同，请重新运行 bin/loop 交付。");
    const h = inputs(t); hashes = { promptHash: h.promptHash, acceptanceHash: h.acceptanceHash };
    if (checked(dir, commit, h)) {
      update(dir, (s) => { s.loop.reused = true; });
      transition(dir, "completed", "完成", "沿用此 commit 的复测与评审通过记录", null);
      return quiet("沿用");
    }
    const record = (step: string, result: string, start: number, evidence: string[], detail = "") => {
      const c: Check = { commit, tree: delivery.tree, step, result, startedAt: new Date(start).toISOString(),
        endedAt: new Date().toISOString(), durationMs: Date.now() - start, evidence,
        promptHash: h.promptHash, acceptanceHash: h.acceptanceHash, ...(detail ? { detail } : {}) };
      appendCheck(dir, c);
    };
    transition(dir, "working", "复测中", "正在复测：" + t.test, "testMs", t.limits.测试.timeoutMin * 60);
    const testStart = Date.now(), log = join(dir, "test-" + commit + ".log");
    let testResult = "", output = "";
    if (/^无\s*[:：]/.test(t.test)) {
      testResult = "没验证"; output = t.test; writeFileSync(log, output + "\n");
    } else {
      const result = await run(t, "sh", ["-c", t.test], t.limits.测试.timeoutMin * 60000, signal);
      selfTime();
      output = result.output; testResult = result.code === 0 && !result.killed ? "通过" : "失败";
      writeFileSync(log, output + (result.killed ? "\n复测超时或取消\n" : ""));
      if (statusOf(dir).state === "cancelled") { record("复测", "已停止", testStart, [log]); return quiet("已停止"); }
      if (testResult === "失败") {
        const lines = output.trimEnd().split(/\r?\n/);
        const reason = ["复测失败" + (result.killed ? "（超时或取消）" : "") + "，请修复后重新交付。", "命令：" + t.test,
          "输出最后 60 行：", ...lines.slice(-60), "error/fail 行：", ...lines.filter((s) => /error|fail/i.test(s))].join("\n");
        record("复测", "失败", testStart, [log], reason);
        return returnToDeveloper(dir, "test", reason);
      }
    }
    selfTime();
    record("复测", testResult, testStart, [log], "命令：" + t.test);
    if (statusOf(dir).state === "cancelled") return quiet("已停止");
    const previous = statusOf(dir).loop, round = previous.reviewRounds + 1;
    update(dir, (s) => { s.loop.reviewRounds = round; });
    const lastReview = checksOf(dir).filter((c) => c.step === "评审" && c.commit === previous.previousReviewCommit && ["通过", "必修"].includes(c.result)).at(-1);
    const sameRequirement = lastReview?.promptHash === h.promptHash && lastReview?.acceptanceHash === h.acceptanceHash;
    const base = sameRequirement && previous.previousReviewCommit ? previous.previousReviewCommit : t.baseCommit;
    const diff = git(t.worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, commit, "--"]);
    const added = git(t.worktree, ["diff", "--name-only", "--diff-filter=A", "-z", base, commit, "--"]).split("\0").filter(Boolean);
    const material = ["## 提示词原文", h.prompt, ...(h.acceptance ? ["## 验收标准", h.acceptance] : []),
      "## 本轮改动", !sameRequirement && previous.previousReviewCommit ? "需求已变化，以下为起点至本次交付的完整 diff。" : "", diff || "（无改动）", "## 新增文件", added.join("\n") || "无",
      "## 开发方交付说明", delivery.note || lastReply || "（无）", "## 复测结果", "命令：" + t.test, "结果：" + testResult, output,
      ...(previous.previousReviewCommit ? ["## 上一轮必修", previous.previousMustFix.join("\n") || "无", "## 开发方回复", lastReply || delivery.note || "（无）"] : [])].join("\n\n");
    transition(dir, "working", "评审中", "正在评审第 " + round + " 轮", "reviewMs", t.limits.开发评审.timeoutMin * 60);
    const reviewStart = Date.now(), outcome = await executeStaticReview(t, round, material, t.limits.开发评审.timeoutMin * 60000, signal);
    selfTime();
    if (statusOf(dir).state === "cancelled") { record("评审", "已停止", reviewStart, outcome.evidence); return quiet("已停止"); }
    if (!outcome.review) {
      record("评审", "失败", reviewStart, outcome.evidence, outcome.error);
      fail(dir, outcome.error || "评审调用失败", "临时故障"); return quiet(outcome.error);
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
    transition(dir, "completed", "完成", "此 commit 复测" + (testResult === "没验证" ? "没验证（" + t.test + "）" : "通过") + "，评审通过", null);
    return quiet("完成");
  } catch (e) {
    if (release) fail(dir, e);
    return quiet(e instanceof Error ? e.message : String(e));
  } finally {
    try {
      if (task && ownStart) {
        const s = update(dir, (s) => { if (s.loop.bucket === "selfMs") s.loop.bucket = s.state === "working" ? "developmentMs" : null; });
        appendCheck(dir, { commit: s.loop.commit || task.baseCommit, tree: s.loop.delivery?.tree || "", step: "dev-loop 自身",
          result: s.loop.reused ? "沿用" : s.state === "failed" ? "失败" : "推进", startedAt: new Date(ownStart).toISOString(), endedAt: new Date().toISOString(),
          durationMs: Math.max(0, s.loop.durations.selfMs - selfBefore), evidence: [], ...hashes });
        summary(dir, s);
      }
    } finally { release?.(); }
  }
}
