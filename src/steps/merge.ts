import { taskOf, statusOf, missingChecks, recordStep, LoopError } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { gitText, gitTry, worktreeOf, isAncestor } from "../infra/git.ts";
import { readJson } from "../infra/files.ts";
import { shellQuote } from "../infra/paths.ts";
export interface MergeResult {
  executionId: string; commit: string; devBefore: string; devAfter: string; result: string; unverified: boolean;
  seconds: number; worktree: string; revert: string;
}
export function merge(dir: string, o: {commit?: string; acceptUnverified: boolean}): MergeResult {
  const start = Date.now(), t = taskOf(dir), commit = statusOf(dir).loop.commit;
  if (!commit) throw new InputError("没有交付记录");
  if (o.commit) {
    const confirmed = gitTry(t.repo, ["rev-parse", "--verify", "--end-of-options", o.commit + "^{commit}"]);
    if (confirmed.code || confirmed.stdout.trim() !== commit) throw new InputError("目标已变化：确认的是 " + o.commit + "，当前是 " + commit);
  }
  const missing = missingChecks(dir, commit), unverified = missing.length > 0;
  if (unverified && !o.acceptUnverified) throw new InputError("合入资格不足：" + missing.join("；") + "。确需合入请加 --接受未验证");
  const before = gitText(t.repo, ["rev-parse", "refs/heads/dev"]), holder = worktreeOf(t.repo, "dev");
  const finish = (result: string, after: string, message: string, detail = ""): MergeResult => {
    const failed = result === "合入失败", ended = Date.now();
    const r = {executionId: t.executionId, commit, devBefore: before, devAfter: after, result, unverified,
      seconds: (ended - start) / 1000, worktree: holder || "", revert: holder ? "git -C " + shellQuote(holder) + " revert -m 1 " + after : ""};
    recordStep(dir, {step: "合入", result, commit, startedAt: new Date(start).toISOString(), endedAt: new Date(ended).toISOString(),
      durationMs: ended - start, evidence: [], detail: detail || JSON.stringify(r)},
    {phase: failed ? "合入失败" : "已合入", message, complete: !failed && o.acceptUnverified});
    return r;
  };
  if (isAncestor(t.repo, commit, before)) return finish("已在 dev", before, "已在 dev " + before.slice(0, 7) + (unverified ? "，未验证" : ""));
  if (!holder) throw new InputError("dev 没有检出到任何目录，无法合并");
  let name = t.name;
  try { name = readJson<{name: string}>(t.card).name || name; } catch {}
  const message = "Merge " + name + ": " + (unverified ? "unverified" : "reviewed") + " " + commit.slice(0, 7);
  const merging = gitTry(holder, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0;
  const r = gitTry(holder, ["merge", "--no-ff", "--no-edit", "-m", message, commit], {GIT_MERGE_AUTOEDIT: "no"});
  if (r.code) {
    const conflicts = gitTry(holder, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
    let raw = r.stdout + r.stderr;
    if (!merging && gitTry(holder, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0) {
      const abort = gitTry(holder, ["merge", "--abort"]); if (abort.code) raw += abort.stdout + abort.stderr;
    }
    const result = finish("合入失败", gitText(t.repo, ["rev-parse", "refs/heads/dev"]), conflicts.length ? "冲突：" + conflicts.slice(0, 3).join("、") : "git 拒绝合并", raw);
    throw new LoopError("输入问题", raw, result);
  }
  const after = gitText(t.repo, ["rev-parse", "refs/heads/dev"]);
  return finish(unverified ? "已合入（未验证）" : "已合入", after, after.slice(0, 7) + (unverified ? "，未验证" : ""));
}
