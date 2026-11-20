import { existsSync } from "node:fs";
import { gitText, head, tree, changes, changedSince, isAncestor } from "../infra/git.ts";
import { lock } from "../infra/files.ts";
import { alive } from "../infra/exec.ts";
import { inScope, InputError } from "./card.ts";
import { taskOf, statusOf, update, inputs, appendCheck, checked, fail, type Bucket, type Status, type Task } from "./store.ts";
import { operationPath } from "./run.ts";

export function undeliveredCommit(t: Task, s: Status, commit: string): boolean {
  const previous = s.loop.delivery?.commit || t.baseCommit;
  return commit !== previous && isAncestor(t.worktree, previous, commit);
}
export function waitingForDelivery(s: Status): boolean {
  return s.state === "input_required" && s.loop.phase === "等你" && s.loop.wait === "停下没交付" && s.loop.ready && !s.loop.released && !s.loop.abandoned;
}
export const onTaskBranch = (t: Task) => gitText(t.worktree, ["branch", "--show-current"]) === t.branch;
function verifyScope(t: Task, commit: string, dirty: string[] = []) {
  const affected = [...new Set([...dirty, ...changedSince(t.worktree, t.baseCommit, commit)])];
  const outside = affected.filter(p => !inScope(p, t.scope));
  if (outside.length) throw new InputError("拒绝交付，scope 外文件：\n" + outside.map(p => "- " + p).join("\n"));
}
function requireDeliveryWait(s: Status) {
  if (!waitingForDelivery(s)) throw new InputError("只在「等你 · 停下没交付」时可确认交付；请重新查询执行");
}
function register(t: Task, before: Status, commit: string, deliveredTree: string, note: string, begin: number, confirmed = false) {
  const {dir} = t, now = new Date().toISOString(), h = inputs(t), reused = checked(dir, commit, h);
  const start = before.loop.stepStartedAt;
  const record = (step: string, result: string, start: number, end: string, durationMs: number) => appendCheck(dir, {
    commit, tree: deliveredTree, step, result, startedAt: new Date(start).toISOString(), endedAt: end, durationMs,
    evidence: [], promptHash: h.promptHash, acceptanceHash: h.acceptanceHash,
  });
  const status = update(dir, s => {
    // stop/续跑可能先拿到状态锁；只有仍在原等待现场才登记。
    if (confirmed) {
      requireDeliveryWait(s);
      if (s.loop.stepStartedAt !== start) throw new InputError("等待现场已变化；请重新查询执行");
      record("等你", "已续跑", start, new Date(begin).toISOString(), Math.max(0, begin - start));
      s.loop.facts!.resumes++;
    }
    record("开发", "已交付", confirmed ? begin : start, new Date(begin).toISOString(), before.loop.bucket === "developmentMs" ? Math.max(0, begin - start) : 0);
    s.loop.delivery = {commit, tree: deliveredTree, note, at: now}; s.loop.commit = commit; s.loop.reused = reused;
    const pending = Boolean(t.after?.length || t.next);
    if (!(reused && s.state === "completed" && s.loop.phase !== "完成")) {
      s.state = reused && !pending ? "completed" : "working"; s.loop.phase = reused && !pending ? "完成" : "已交付";
      s.message = reused ? "已交付，沿用已有检查" : confirmed ? "本人已确认交付，后台复测和评审" : "已交付，等待会话停下后复测和评审";
    }
    s.error = null; s.timeLimitSec = null; s.loop.wait = null; s.loop.pendingReturn = null; s.loop.pendingOpening = false;
    s.loop.bucket = s.state === "completed" ? null : "developmentMs";
    record("dev-loop 自身", "交付登记", begin, now, Math.max(0, Date.now() - begin));
  });
  return {commit, tree: deliveredTree, reused, status};
}
export function deliver(dir: string, note = "") {
  const release = lock(operationPath(dir));
  let previousBucket: Bucket | null | undefined;
  try {
    const t = taskOf(dir), s = statusOf(dir);
    if (s.loop.phase === "收尾中" || alive(s.loop.finisher)) throw new InputError("正在收尾，不能交付");
    if (s.state === "cancelled" || s.state === "input_required" || s.state === "failed") throw new InputError("任务未运行，请先 bin/loop 续跑");
    if (!s.loop.ready) throw new InputError("工作区尚未准备好");
    const begin = Date.now(); previousBucket = s.loop.bucket;
    update(dir, (s) => { s.loop.bucket = "selfMs"; });
    if (!onTaskBranch(t)) throw new InputError("必须在登记的任务分支交付：" + t.branch);
    const dirty = changes(t.worktree); verifyScope(t, "HEAD", dirty);
    if (dirty.length) gitText(t.worktree, ["add", "-A", "--", ...dirty]);
    const candidateTree = gitText(t.worktree, ["write-tree"]);
    if (s.loop.delivery?.tree === candidateTree && tree(t.worktree) !== candidateTree) throw new InputError("内容与上次交付相同但 HEAD 不同；请恢复到 " + s.loop.delivery.commit + " 后交付，不创建重复提交");
    if (tree(t.worktree) !== candidateTree) gitText(t.worktree, ["commit", "-m", "dev-loop: " + t.name]);
    const commit = head(t.worktree), {tree: deliveredTree, reused} = register(t, s, commit, tree(t.worktree, commit), note, begin);
    return {commit, tree: deliveredTree, reused};
  } catch (e) { if (!(e instanceof InputError)) fail(dir, e); throw e; }
  finally {
    try { if (previousBucket !== undefined && statusOf(dir).loop.bucket === "selfMs") update(dir, (s) => { s.loop.bucket = previousBucket!; }); }
    finally { release(); }
  }
}

/** 本人确认只登记指定的现有提交；没有暂存、写索引树或新建提交的路径。 */
export function confirmDelivery(dir: string, expected: string) {
  if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(expected)) throw new InputError("--交付提交 须提供查询给出的完整 SHA");
  const release = lock(operationPath(dir));
  try {
    const begin = Date.now(), t = taskOf(dir), s = statusOf(dir);
    requireDeliveryWait(s);
    if (!existsSync(t.worktree)) throw new InputError("工作区已不在；请重新查询执行");
    if (!onTaskBranch(t)) throw new InputError("工作区已不在任务分支 " + t.branch + "；请重新查询执行");
    const commit = head(t.worktree);
    if (commit !== expected.toLowerCase()) throw new InputError("HEAD 已变化：当前为 " + commit + "；请重新查询执行");
    if (changes(t.worktree).length) throw new InputError("工作区有未提交改动；请保留现场并重新查询执行");
    if (!undeliveredCommit(t, s, commit)) throw new InputError("当前没有领先于起点或上次登记的未交付提交；请重新查询执行");
    verifyScope(t, commit);
    return register(t, s, commit, tree(t.worktree, commit), "本人确认交付已有提交", begin, true);
  } finally { release(); }
}
