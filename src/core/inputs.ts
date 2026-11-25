import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APP_ROOT } from "../infra/paths.ts";
import { inside } from "../infra/config.ts";
import { digest, readJson, readText } from "../infra/files.ts";
import { gitText, isAncestor, tree } from "../infra/git.ts";
import { parseE2e, InputError, type Scenario } from "./card.ts";
import type { Entry, Ledger, Task } from "./store.ts";
export const reviewPrompt = join(APP_ROOT,"src/core/review-prompt.md");
export const devRef = "refs/heads/dev";
export function baseOf(l:Ledger,sha:string) {
  const repo=l.task.repo, before=l.rows.findLast(r=>r.type==="开始" && r.step==="合入" && r.sha===sha && r.devBefore)?.devBefore;
  const target=before && isAncestor(repo,sha,devRef) ? before : devRef; // 自己合入后仍核对当时的合并基点。
  return gitText(repo,["merge-base",sha,target]);
}
export function fileHashes(root:string,paths:string[]) {
  const files:Record<string,string>=Object.create(null);
  const visit=(p:string)=>{
    const file=resolve(root,p), s=lstatSync(file);
    if (realpathSync(file)!==file || !inside(root,file)) throw new InputError("localFiles 不能越界或跟随链接："+p);
    if (s.isDirectory()) readdirSync(file).sort().forEach(name=>visit(join(p,name)));
    else if (s.isFile()) files[p]=digest(readFileSync(file)); else throw new InputError("localFiles 不是普通文件："+p);
  };
  [...new Set(paths.map(p=>join(p)))].sort().forEach(visit); return files;
}
export function copyLocal(t:Task,cwd=t.worktree) {
  const files=fileHashes(t.repo,t.config.localFiles);
  for (const path of Object.keys(files)) {
    const dest=join(cwd,path); mkdirSync(dirname(dest),{recursive:true});
    if (realpathSync(dirname(dest))!==dirname(dest) || lstatSync(dest,{throwIfNoEntry:false})?.isSymbolicLink()) throw new InputError("localFiles 目标越界："+path);
    cpSync(join(t.repo,path),dest);
  }
  return files;
}
export function inputs(t:Task) {
  const prompt=readText(t.prompt), acceptance=t.acceptance ? readText(t.acceptance) : "";
  const source=readJson<{tasks:{test?:string; e2e?:Scenario[]}[]}>(t.card).tasks.find(s=>(s as {name?:string}).name===t.name);
  const test=source?.test ?? t.test, e2e=t.e2e && parseE2e(source?.e2e);
  if (typeof test!=="string" || !test.trim()) throw new InputError("test 须为非空命令或「无：原因」");
  return {prompt,acceptance,test,e2e,promptHash:digest(prompt),acceptanceHash:digest(acceptance),...(e2e ? {e2eHash:digest(JSON.stringify(e2e))} : {})};
}
export function binding(l:Ledger,sha:string) {
  const t=l.task,{config:c}=t,{prompt,acceptance,test,e2e,...hashes}=inputs(t), base=baseOf(l,sha), pinnedTree=tree(t.repo,sha);
  const files=fileHashes(t.repo,c.localFiles), sketch=t.版式 ? readText(t.版式.草图) : "", images=l.delivery?.commit===sha ? l.delivery.images : l.rows.findLast(r=>r.type==="提交" && r.sha===sha)?.value.images || [];
  const key=digest(JSON.stringify([sha,pinnedTree,base,hashes,test,files,c.setup,c.limits,readText(reviewPrompt),c.reviewerCmd,c.reviewerModel,c.reviewerThinking,sketch,images.map((p:string)=>digest(readFileSync(p)))]));
  return {sha,tree:pinnedTree,key,base,hashes,prompt,acceptance,test,e2e,files,sketch,images};
}
export function evidence(rows:Entry[],sha:string,key:string,pinnedTree:string) {
  const match=(r:Entry)=>r.sha===sha && r.key===key && r.check?.commit===sha && r.check.tree===pinnedTree;
  const test=rows.findLast(r=>r.type==="复测" && match(r)), review=rows.findLast(r=>r.type==="评审" && match(r) && r.check!.attempt===test?.check?.attempt);
  const accepted=rows.some(r=>r.type==="接受未验证" && r.sha===sha && r.key===key && r.text?.trim());
  return {test,review,accepted,verified:test?.check?.result==="通过" && review?.check?.result==="通过" && !review.blocker};
}
export function requireGate(l:Ledger,sha:string) {
  if (!l.delivery || l.delivery.commit!==sha) throw new InputError("版本不是最后一次收货提交");
  const b=binding(l,sha), {verified,accepted}=evidence(l.rows,sha,b.key,b.tree);
  if (!verified && !accepted) throw new InputError("放行资格不足：此提交同输入须有复测通过、评审通过，或本人的接受未验证意图");
  return {...b,unverified:!verified};
}
