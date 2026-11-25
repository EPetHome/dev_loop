import { InputError } from "../core/card.ts";
import { Ledger, locked, type Entry, type Outcome } from "../core/store.ts";
import { devRef, requireGate } from "../core/inputs.ts";
import { gitText, gitTry, worktreeOf, isAncestor } from "../infra/git.ts";
import { span } from "../infra/files.ts";
import { shellQuote } from "../infra/paths.ts";
export function merge(l:Ledger,j:Entry):Outcome {
  const start=Date.now(), sha=j.sha!, {task:t}=l, {repo}=t, {unverified,hashes,tree}=requireGate(new Ledger(l.dir),sha);
  const before=gitText(repo,["rev-parse",devRef]), holder=worktreeOf(repo,"dev");
  const finish=(result:string,after:string,detail="",kind?:Outcome["kind"]):Outcome=>{
    const elapsed=span(start), value={executionId:t.executionId,commit:sha,devBefore:before,devAfter:after,result,unverified,seconds:elapsed.durationMs/1000,
      worktree:holder || "",revert:holder ? `git -C ${shellQuote(holder)} revert -m 1 ${after}` : ""};
    return {result:kind ? "失败" : "成功",kind,text:detail,value,
      check:{...hashes,tree,step:"合入",commit:sha,result,detail:detail || JSON.stringify(value),evidence:[],...elapsed}};
  };
  if (isAncestor(repo,sha,before)) return finish("已在 dev",before);
  if (!holder) throw new InputError("dev 没有检出到任何目录，无法合并");
  if (!gitTry(holder,["rev-parse","-q","--verify","MERGE_HEAD"]).code) throw new InputError("dev 有未完成的手工合并；保留现场");
  // 先在对象库试合，冲突不碰 dev 索引。只快进到已绑定双亲的 merge 提交。
  const r=gitTry(repo,["merge-tree","--write-tree","--name-only","-z",before,sha]);
  if (r.code===1) return finish("合入失败",before,"合入冲突：\n"+r.stdout.split("\0").slice(1).filter(Boolean).join("\n")+r.stderr,"冲突");
  if (r.code) throw new Error(r.stderr+r.stdout);
  const tip=gitText(repo,["commit-tree",r.stdout.split("\0")[0].trim(),"-p",before,"-p",sha,
    "-m",`Merge ${t.name}: ${unverified ? "unverified" : "reviewed"} ${sha.slice(0,7)}`]);
  const result=unverified ? "已合入（未验证）" : "已合入";
  // 先留精确的候选和原放行绑定；崩溃后不能把当时的候选与之后的 dev HEAD 混淆。
  if (j.intent) locked(l.dir,current=>current.add({type:"合入待确认",ref:j.n,sha,key:j.key,intent:j.intent,value:finish(result,tip)}));
  if (gitText(holder,["branch","--show-current"])!=="dev" || gitText(repo,["rev-parse",devRef])!==before) throw new Error("dev 已变化，重新试合");
  const applied=gitTry(holder,["merge","--ff-only","--no-edit",tip]); if (applied.code) return finish("合入失败",before,applied.stderr+applied.stdout,"重试");
  return finish(result,tip);
}

// 只补结果，不再次改 Git；可见的候选提交必须已经进入本地 dev。
export function recoverWindowMerge(l:Ledger,j:Entry):Outcome {
  const pending=l.rows.findLast(r=>r.type==="合入待确认" && r.ref===j.n && r.intent===j.intent && r.sha===j.sha && r.key===j.key);
  const outcome=pending?.value as Outcome|undefined, tip=outcome?.value?.devAfter;
  if (outcome && tip && isAncestor(l.task.repo,tip,devRef)) return outcome;
  return {result:"失败",kind:"环境",text:"合入工具中断，未确认本次合入；若需重试，请重新在窗口说「合入」。"};
}
