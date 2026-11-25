import { mkdirSync, realpathSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { InputError, readCard } from "../core/card.ts";
import { inputs, devRef } from "../core/inputs.ts";
import { allTasks, hasLedger, Ledger, locked, ledgerFile, type Task } from "../core/store.ts";
import { publish } from "../core/view.ts";
import { loadConfig } from "../infra/config.ts";
import { digest, iso, jsonLines, withLock, atomicWrite, errorText } from "../infra/files.ts";
import { commitOf, gitText } from "../infra/git.ts";
import { tasksRoot, wake } from "../infra/paths.ts";
const ascii=(s:string)=>s.replace(/[^a-zA-Z0-9_-]+/g,"-").slice(0,25) || "card";
export function startCards(files:string[],edges:string[],words:string,dispatch?:string,instruction?:string) {
  if (!files.length) throw new InputError("开工需要开发卡路径");
  let drafts:(Task & {title:string})[];
  try { drafts=files.map(path=>{
    const {file,repo,card,cardHash}=readCard(resolve(path)), {acceptance,base,after}=card, task=card.tasks[0], config=loadConfig(repo,!!task.proofs?.length,card.limits,after.includes("部署"));
    commitOf(repo,devRef); if (after.includes("推送")) gitText(repo,["remote","get-url","origin"]);
    if (after.includes("部署") && (!config.deploy?.check || !config.deploy.rollback)) throw new InputError("自动部署须登记 deploy.cmd/check/rollback");
    return {...task,title:card.name,host:"pi",repo,card:file,cardHash,acceptance,base,after,config,limits:config.limits,createdAt:iso(),dispatchId:dispatch || null,baseCommit:"",executionId:"",worktree:"",dir:"",branch:"",proofs:task.proofs?.map(p=>({...p,before:p.before || ""}))};
  }); } catch(e) {throw new InputError(errorText(e));}
  if (new Set(drafts.map(t=>t.card)).size!==drafts.length) throw new InputError("同批卡不得重复");
  const index=(s:string)=>{
    if (/^[1-9]\d*$/.test(s) && Number(s)<=drafts.length) return Number(s)-1;
    const matches=drafts.flatMap((t,i)=>[t.name,t.title,basename(t.card,".json")].includes(s) || t.card===resolve(s) ? [i] : []);
    if (matches.length!==1) throw new InputError("依赖不能唯一定位："+s); return matches[0];
  };
  const deps=drafts.map(()=>new Set<number>()); for (const edge of edges) {
    const [b,a,...rest]=edge.split("="); if (!b || !a || rest.length) throw new InputError("依赖用 后项=前项");
    const from=index(a),to=index(b); if (!drafts[from].after.includes("合入")) throw new InputError(`${a} 被依赖，但开发卡没有授权合入`); deps[to].add(from);
  }
  const order:number[]=[]; while (order.length<drafts.length) {
    const next=deps.findIndex((d,i)=>!order.includes(i) && [...d].every(k=>order.includes(k))); if(next<0)throw new InputError("批次依赖成环"); order.push(next);
  }
  const hash=digest(JSON.stringify(drafts.map((t,i)=>{const h=inputs(t);return [t.card,t.cardHash,h.promptHash,h.acceptanceHash,[...deps[i]].sort()];})));
  let root=tasksRoot(); mkdirSync(root,{recursive:true,mode:0o700});root=realpathSync(root);
  const ids=drafts.map((t,i)=>[ascii(basename(t.repo)),ascii(t.name),hash.slice(0,12),String(i+1)].join("-")), leader=order[0];
  const receipt=(l:Ledger)=>{const s=publish(l), t=l.task;return {executionId:t.executionId,taskDir:t.dir,status:join(t.dir,"status.json"),state:"working",warnings:s.warnings,...(ids.length>1 && {executions:ids})};};
  const result=withLock(join(root,"start.lock"),()=>{
    if (instruction) for (const dir of allTasks(root)) {
      if (hasLedger(dir)) {const l=new Ledger(dir); if(l.open.instruction===instruction)return receipt(l);}
      else {const i=jsonLines<{id:string;type:string;result:unknown}>(join(dir,"instructions.jsonl")).find(x=>x.id===instruction && x.type==="启动"); if(i)return i.result;}
    }
    for (const i of [...order.slice(1),leader]) {
      const t=drafts[i], executionId=ids[i], dir=join(root,executionId); if(hasLedger(dir))continue;
      Object.assign(t,{executionId,dir,branch:"dev-loop/"+executionId,worktree:join(dir,"worktree")});
      const temp=mkdtempSync(join(root,".open-"));
      try {
        atomicWrite(ledgerFile(temp),JSON.stringify({n:1,at:t.createdAt,type:"开工",task:t,text:words,todo:"按开发卡开发、验证并交付。",batch:order.map(i=>ids[i]),deps:[...deps[i]].map(i=>ids[i]),limit:drafts[leader].config.maxParallelCards,...(i===leader && {instruction})})+"\n");
        renameSync(temp,dir);
      } finally {rmSync(temp,{recursive:true,force:true});}
    }
    ids.filter(id=>id!==ids[leader]).forEach(id=>locked(join(root,id),publish)); return locked(join(root,ids[leader]),receipt);
  });
  wake(join(root,ids[leader])); return result;
}
