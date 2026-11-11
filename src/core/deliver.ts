import { gitText, head, tree, changes, changedSince } from "../infra/git.ts";
import { lock } from "../infra/files.ts";
import { alive } from "../infra/exec.ts";
import { inScope, InputError } from "./card.ts";
import { taskOf, statusOf, update, inputs, appendCheck, checked, fail, type Bucket } from "./store.ts";
import { operationPath } from "./run.ts";
export function deliver(dir: string, note = "") {
  const release = lock(operationPath(dir)), t = taskOf(dir);
  let previousBucket: Bucket | null | undefined;
  try {
    const s = statusOf(dir);
    if (s.loop.phase === "收尾中" || alive(s.loop.finisher)) throw new InputError("正在收尾，不能交付");
    if (s.state === "cancelled" || s.state === "input_required" || s.state === "failed") throw new InputError("任务未运行，请先 bin/loop 续跑");
    if (!s.loop.ready) throw new InputError("工作区尚未准备好");
    const begin = Date.now(); previousBucket = s.loop.bucket;
    update(dir, (s) => { s.loop.bucket = "selfMs"; });
    if (gitText(t.worktree, ["branch", "--show-current"]) !== t.branch) throw new InputError("必须在登记的任务分支交付：" + t.branch);
    const dirty = changes(t.worktree), affected = [...new Set([...dirty, ...changedSince(t.worktree, t.baseCommit)])];
    const outside = affected.filter((p) => !inScope(p, t.scope));
    if (outside.length) throw new InputError("拒绝交付，scope 外文件：\n" + outside.map((p) => "- " + p).join("\n"));
    if (dirty.length) gitText(t.worktree, ["add", "-A", "--", ...dirty]);
    const candidateTree = gitText(t.worktree, ["write-tree"]);
    if (s.loop.delivery?.tree === candidateTree && tree(t.worktree) !== candidateTree) throw new InputError("内容与上次交付相同但 HEAD 不同；请恢复到 " + s.loop.delivery.commit + " 后交付，不创建重复提交");
    if (tree(t.worktree) !== candidateTree) gitText(t.worktree, ["commit", "-m", "dev-loop: " + t.name]);
    const commit = head(t.worktree), deliveredTree = tree(t.worktree), now = new Date().toISOString(), h = inputs(t);
    appendCheck(dir, { commit, tree: deliveredTree, step: "开发", result: "已交付", startedAt: new Date(s.loop.stepStartedAt).toISOString(), endedAt: new Date(begin).toISOString(),
      durationMs: previousBucket === "developmentMs" ? Math.max(0, begin - s.loop.stepStartedAt) : 0, evidence: [], promptHash: h.promptHash, acceptanceHash: h.acceptanceHash });
    const reused = checked(dir, commit, h);
    update(dir, (s) => {
      s.loop.delivery = { commit, tree: deliveredTree, note, at: now }; s.loop.commit = commit; s.loop.warned = false; s.loop.reused = reused;
      const pending = Boolean(t.after?.length || t.next);
      if (!(reused && s.state === "completed" && s.loop.phase !== "完成")) {
        s.state = reused && !pending ? "completed" : "working"; s.loop.phase = reused && !pending ? "完成" : "已交付";
        s.message = reused ? "已交付，沿用已有检查" : "已交付，等待会话停下后复测和评审";
      }
      s.loop.wait = null; s.loop.pendingReturn = null; s.loop.bucket = s.state === "completed" ? null : "developmentMs";
    });
    appendCheck(dir, { commit, tree: deliveredTree, step: "dev-loop 自身", result: "交付登记", startedAt: new Date(begin).toISOString(), endedAt: now,
      durationMs: Math.max(0, Date.now() - begin), evidence: [], promptHash: h.promptHash, acceptanceHash: h.acceptanceHash });
    return { commit, tree: deliveredTree, reused };
  } catch (e) { if (!(e instanceof InputError)) fail(dir, e); throw e; }
  finally {
    try { if (previousBucket !== undefined && statusOf(dir).loop.bucket === "selfMs") update(dir, (s) => { s.loop.bucket = previousBucket!; }); }
    finally { release(); }
  }
}
