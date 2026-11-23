import { taskOf, statusOf, missingChecks, recordStep, LoopError } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { gitText, gitTry, worktreeOf, isAncestor } from "../infra/git.ts";
import { readJson, span } from "../infra/files.ts";
import { shellQuote } from "../infra/paths.ts";
export type MergeResult = ReturnType<typeof merge>;
const merging = (cwd: string) => !gitTry(cwd,["rev-parse","-q","--verify","MERGE_HEAD"]).code;
const devHead = (repo: string) => gitText(repo,["rev-parse","refs/heads/dev"]);
function target(dir: string, o: {commit?: string; acceptUnverified?: boolean}) {
  const t = taskOf(dir), commit = statusOf(dir).loop.commit; if (!commit) throw new InputError("没有交付记录");
  if (o.commit) {
    const r = gitTry(t.repo,["rev-parse","--verify","--end-of-options",o.commit+"^{commit}"]);
    if (r.code || r.stdout.trim() !== commit) throw new InputError(`目标已变化：确认的是 ${o.commit}，当前是 ${commit}`);
  }
  const missing = missingChecks(dir,commit), unverified = missing.length > 0;
  if (unverified && !o.acceptUnverified) throw new InputError("合入资格不足："+missing.join("；")+"。确需合入请加 --接受未验证");
  return {t,commit,unverified};
}
export function prepareMerge(dir: string, commit?: string) {
  const {t,commit:sha} = target(dir,{commit}), before = devHead(t.repo); if (isAncestor(t.repo,sha,before)) return before;
  const holder = worktreeOf(t.repo,"dev"); if (!holder) throw new InputError("dev 没有检出到任何目录，无法合并");
  const r = gitTry(t.repo,["merge-tree","--write-tree",before,sha]);
  if (r.code) throw new LoopError("输入问题",r.stdout+r.stderr,{conflict:r.code === 1});
  const prepared = gitText(t.repo,["commit-tree",r.stdout.trim().split("\n")[0],"-p",before,"-p",sha,"-m",`Merge ${t.name}: reviewed ${sha.slice(0,7)}`]);
  if (merging(holder)) throw new InputError("dev 有未完成合并 MERGE_HEAD，无法快进；线上未动");
  // 真实索引和工作区两树预检，不写入，不拒绝无关改动。
  const ready = gitTry(holder,["read-tree","--dry-run","-m","-u",before,prepared]);
  if (ready.code) throw new InputError("dev 无法快进；线上未动\n"+ready.stdout+ready.stderr); return prepared;
}
export function merge(dir: string, o: {commit?: string; acceptUnverified: boolean; prepared?: string}) {
  const start = Date.now(), {t,commit,unverified} = target(dir,o), before = devHead(t.repo), holder = worktreeOf(t.repo,"dev");
  const finish = (result: string, after: string, message: string, detail = "") => {
    const failed = result === "合入失败", timing = span(start);
    const r = {executionId:t.executionId,commit,devBefore:before,devAfter:after,result,unverified,seconds:timing.durationMs/1000,
      worktree:holder || "",revert:holder ? `git -C ${shellQuote(holder)} revert -m 1 ${after}` : ""};
    recordStep(dir,{step:"合入",result,commit,...timing,evidence:[],detail:detail || JSON.stringify(r)},
      {phase:failed ? "合入失败" : "已合入",message,complete:!failed && o.acceptUnverified});
    return r;
  };
  const suffix = unverified ? "，未验证" : "";
  if (isAncestor(t.repo,commit,before)) return finish("已在 dev",before,`已在 dev ${before.slice(0,7)}${suffix}`);
  if (!holder) throw new InputError("dev 没有检出到任何目录，无法合并");
  let name = t.name; try { name = readJson<{name:string}>(t.card).name || name; } catch {}
  const message = `Merge ${name}: ${unverified ? "unverified" : "reviewed"} ${commit.slice(0,7)}`, hadMerge = merging(holder);
  const r = gitTry(holder,o.prepared ? ["merge","--ff-only",o.prepared] : ["merge","--no-ff","--no-edit","-m",message,commit],{GIT_MERGE_AUTOEDIT:"no"});
  if (r.code) {
    const conflicts = gitTry(holder,["diff","--name-only","--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
    const abort = !hadMerge && merging(holder) && gitTry(holder,["merge","--abort"]), raw = r.stdout+r.stderr+(abort && abort.code ? abort.stdout+abort.stderr : "");
    const result = finish("合入失败",devHead(t.repo),conflicts.length ? "冲突："+conflicts.slice(0,3).join("、") : "git 拒绝合并",raw);
    throw new LoopError("输入问题",raw,result);
  }
  const after = devHead(t.repo); return finish(unverified ? "已合入（未验证）" : "已合入",after,after.slice(0,7)+suffix);
}
