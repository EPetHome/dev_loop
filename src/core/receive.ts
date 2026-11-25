import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { inScope, InputError } from "./card.ts";
import { baseOf, inputs } from "./inputs.ts";
import { digest, maybe, span } from "../infra/files.ts";
import { head, git, gitText, tree, changes, changedSince, releaseChanges, worktreeOf } from "../infra/git.ts";
import type { Entry, Ledger, Receipt, Task } from "./store.ts";
export function onBranch(t:Task) {
  if (realpathSync(t.worktree)!==t.worktree || worktreeOf(t.repo,t.branch)!==t.worktree) throw new InputError("不在登记的任务工作区："+t.worktree);
}
const workHash=(cwd:string,p:string)=>maybe(()=>lstatSync(join(cwd,p)).isFile() && digest(readFileSync(join(cwd,p))));
export function candidate(l:Ledger) {
  const t=l.task, cwd=t.worktree; onBranch(t); const sha=head(cwd), prepared=l.last("准备好")?.baseFiles || {};
  const staged=new Set(git(cwd,["diff","--cached","--name-only","--no-renames","-z"]).split("\0").filter(Boolean));
  const dirty=releaseChanges(cwd).filter(p=>staged.has(p) || !Object.hasOwn(prepared,p) || workHash(cwd,p)!==prepared[p]).sort();
  const key=digest(JSON.stringify([sha,git(cwd,["diff","--binary","--no-ext-diff","--no-textconv","HEAD","--"]),dirty.map(p=>[p,workHash(cwd,p)])]));
  return {sha,dirty,key,changed:dirty.length>0 || sha!==(l.delivery?.commit || t.baseCommit),stagedLocal:[...staged].filter(p=>Object.hasOwn(prepared,p))};
}
export function receive(l:Ledger,start:Entry) {
  const t=l.task,c=candidate(l),base=baseOf(l,c.sha),cwd=t.worktree, outside=[...new Set([...c.dirty,...changedSince(cwd,base,c.sha)])].filter(p=>!inScope(p,t.scope));
  const refs=inputs(t), {images=[],note=""}=start, layout=t.版式, found=new Map<string,string>();
  if (outside.length || c.stagedLocal.length) throw new InputError("拒绝交付，scope 外或不应暂存的 localFiles：\n- "+[...new Set([...outside,...c.stagedLocal])].join("\n- "));
  for (const p of images) {
    const name=basename(p), ext=extname(name), page=layout?.页面.find(s=>s===name || s===basename(name,ext)) || name;
    if (!/^(?:\.png|\.jpe?g|\.webp|\.gif)$/i.test(ext) || !lstatSync(p,{throwIfNoEntry:false})?.isFile() || found.has(page)) throw new InputError("截图不存在、格式不支持或重复："+p);
    found.set(page,p);
  }
  const missing=layout?.页面.filter(p=>!found.has(p)); if (missing?.length) throw new InputError("缺截图："+missing.join("、")+"。补齐后再交付。");
  const folder=join(t.dir,"截图",String(start.n)); if (found.size) mkdirSync(folder,{recursive:true}); const saved=[...found.values()].map(p=>{ const path=join(folder,basename(p)); copyFileSync(p,path); return path; });
  const unstaged=changes(cwd,true).filter(p=>c.dirty.includes(p)); if (unstaged.length) gitText(cwd,["add","-A","--",...unstaged]);
  if (tree(cwd)!==gitText(cwd,["write-tree"])) gitText(cwd,["commit","-m","dev-loop: "+t.name]);
  const commit=head(cwd), pinned=tree(cwd), previous=l.delivery;
  const reused=previous?.commit===commit && digest(JSON.stringify(saved.map(p=>workHash(folder,basename(p)))))===digest(JSON.stringify(previous.images.map(p=>digest(readFileSync(p)))));
  if (reused) return {type:"收货",result:"成功",ref:start.n,sha:commit,value:{commit,tree:pinned,reused}};
  if ((!c.changed && !previous || previous?.tree===pinned && previous.commit!==commit) && base===baseOf(l,previous?.commit || c.sha)) throw new InputError("没有新的交付改动");
  const value:Receipt={commit,tree:pinned,note,at:new Date().toISOString(),images:saved};
  const {prompt,acceptance,e2e,test,...hashes}=refs, check={...hashes,...span(Date.parse(l.last("提交")?.at || l.open.at)),step:"开发",result:"已交付",commit,tree:pinned,evidence:saved};
  return {type:"提交",sha:commit,value,check,ref:start.n,result:"成功"};
}
