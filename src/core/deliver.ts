import { gitText, head, tree, changes, changedSince, isAncestor } from "../infra/git.ts";
import { lock } from "../infra/files.ts";
import { alive } from "../infra/exec.ts";
import { inScope, InputError } from "./card.ts";
import { taskOf, statusOf, update, inputs, appendCheck, checked, fail, type Bucket, type Status, type Task } from "./store.ts";
import { operationPath } from "./run.ts";
export const onTaskBranch = (t: Task) => gitText(t.worktree, ["branch", "--show-current"]) === t.branch;
export const waitingForDelivery = (s: Status) => s.state === "input_required" && s.loop.phase === "等你" && s.loop.wait === "停下没交付" && s.loop.ready && !s.loop.released && !s.loop.abandoned;
export function undeliveredCommit(t: Task, s: Status, commit: string) {
  const base = s.loop.delivery?.commit || t.baseCommit;
  return commit !== base && isAncestor(t.worktree, base, commit);
}
function register(t: Task, before: Status, begin: number, note: string, expected?: string) {
  const {dir, worktree} = t, commit = expected || head(worktree), deliveredTree = tree(worktree, commit);
  const {promptHash, acceptanceHash} = inputs(t), reused = checked(dir, commit, {promptHash, acceptanceHash});
  const start = before.loop.stepStartedAt, at = new Date().toISOString();
  const record = (step: string, result: string, since: number, until = begin, timed = true) => appendCheck(dir, {
    commit, tree: deliveredTree, step, result, startedAt: new Date(since).toISOString(), endedAt: new Date(until).toISOString(),
    durationMs: timed ? Math.max(0, until - since) : 0, evidence: [], promptHash, acceptanceHash,
  });
  const status = update(dir, s => {
    if (expected) {
      if (!waitingForDelivery(s) || s.loop.stepStartedAt !== start) throw new InputError("等待现场已变化；请重新查询执行");
      record("等你", "已续跑", start); s.loop.facts!.resumes++;
    }
    record("开发", "已交付", expected ? begin : start, begin, before.loop.bucket === "developmentMs");
    s.loop.delivery = {commit, tree: deliveredTree, note, at}; s.loop.commit = commit; s.loop.reused = reused;
    if (!(reused && s.state === "completed" && s.loop.phase !== "完成")) {
      const done = reused && !(t.after?.length || t.next);
      s.state = done ? "completed" : "working"; s.loop.phase = done ? "完成" : "已交付";
      s.message = reused ? "已交付，沿用已有检查" : "已交付，" + (expected ? "本人确认后后台复测和评审" : "等待会话停下后复测和评审");
    }
    s.error = null; s.timeLimitSec = null; s.loop.wait = null; s.loop.pendingReturn = null; s.loop.pendingOpening = false;
    s.loop.bucket = s.state === "completed" ? null : "developmentMs";
    record("dev-loop 自身", "交付登记", begin, Date.now());
  });
  return {commit, tree: deliveredTree, reused, status};
}
// 复用执行锁和登记记录；本人确认分支在任何暂存/提交之前返回。
function delivery(dir: string, note: string, expected?: string) {
  const release = lock(operationPath(dir));
  let previousBucket: Bucket | null | undefined;
  try {
    const t = taskOf(dir), s = statusOf(dir), begin = Date.now(), cwd = t.worktree;
    if (expected && !waitingForDelivery(s)) throw new InputError("只在「等你 · 停下没交付」时可确认交付；请重新查询执行");
    if (!expected) {
      if (s.loop.phase === "收尾中" || s.loop.releasePending || alive(s.loop.finisher)) throw new InputError("正在收尾，不能交付");
      if (["cancelled", "input_required", "failed"].includes(s.state)) throw new InputError("任务未运行，请先 bin/loop 续跑");
      if (!s.loop.ready) throw new InputError("工作区尚未准备好");
      previousBucket = s.loop.bucket; update(dir, s => { s.loop.bucket = "selfMs"; });
    }
    if (!onTaskBranch(t)) throw new InputError("必须在登记的任务分支交付：" + t.branch);
    const commit = expected ? head(cwd) : "HEAD";
    if (expected && commit !== expected) throw new InputError("HEAD 已变化：当前为 " + commit + "；请重新查询执行");
    const dirty = changes(cwd);
    if (expected && dirty.length) throw new InputError("工作区有未提交改动；请保留现场并重新查询执行");
    if (expected && !undeliveredCommit(t, s, commit)) throw new InputError("当前没有领先于起点或上次登记的未交付提交；请重新查询执行");
    const outside = [...new Set([...dirty, ...changedSince(cwd, t.baseCommit, commit)])].filter(p => !inScope(p, t.scope));
    if (outside.length) throw new InputError("拒绝交付，scope 外文件：\n- " + outside.join("\n- "));
    if (expected) return register(t, s, begin, note, commit);
    if (dirty.length) gitText(cwd, ["add", "-A", "--", ...dirty]);
    const candidateTree = gitText(cwd, ["write-tree"]);
    if (tree(cwd) !== candidateTree) {
      if (s.loop.delivery?.tree === candidateTree) throw new InputError("内容与上次交付相同但 HEAD 不同；请恢复到 " + s.loop.delivery.commit + " 后交付，不创建重复提交");
      gitText(cwd, ["commit", "-m", "dev-loop: " + t.name]);
    }
    return register(t, s, begin, note);
  } catch (e) { if (!expected && !(e instanceof InputError)) fail(dir, e); throw e; }
  finally {
    try { if (previousBucket !== undefined && statusOf(dir).loop.bucket === "selfMs") update(dir, s => { s.loop.bucket = previousBucket!; }); }
    finally { release(); }
  }
}
export function deliver(dir: string, note = "") {
  const {commit, tree, reused} = delivery(dir, note);
  return {commit, tree, reused};
}
export function confirmDelivery(dir: string, expected: string) {
  if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(expected)) throw new InputError("--交付提交 须提供查询给出的完整 SHA");
  return delivery(dir, "本人确认交付已有提交", expected.toLowerCase());
}
