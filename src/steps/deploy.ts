import { mkdirSync, accessSync, constants, lstatSync, realpathSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { span, readText } from "../infra/files.ts";
import { allTasks, hasLedger, Ledger, locked, type Entry, type Outcome } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { snapshot, staticSnapshot } from "../core/snapshot.ts";
import { inside } from "../infra/config.ts";
import { isAncestor } from "../infra/git.ts";
import { run } from "../core/run.ts";
import { devRef, requireGate } from "../core/inputs.ts";
function executable(cwd:string,path:string) {
  const file=resolve(cwd,path);
  try { if (!lstatSync(file).isFile() || !inside(realpathSync(cwd),realpathSync(file))) throw new Error(); accessSync(file,constants.X_OK); return file; }
  catch {throw new InputError("脚本不存在或不可执行："+path);}
}
function previous(l:Ledger) {
  return allTasks(dirname(l.dir)).filter(hasLedger).flatMap(d=>{
    const other=new Ledger(d); if (other.task.repo!==l.task.repo) return [];
    const last=other.rows.findLast(r=>(r.type==="部署" || r.type==="退回") && r.result==="成功"); return last ? [last] : [];
  }).sort((a,b)=>a.at.localeCompare(b.at)).at(-1);
}
export async function deploy(l:Ledger,j:Entry):Promise<Outcome> {
  const start=Date.now(), t=l.task, sha=j.sha!, cfg=t.config.deploy;
  if (!cfg || j.auto && (!cfg.check || !cfg.rollback)) throw new InputError("未登记可用的 deploy.cmd/check/rollback");
  const onDev=isAncestor(t.repo,sha,devRef), evidenceDir=join(l.dir,`deploy-${sha.slice(0,7)}-${j.n}`), log=evidenceDir+".log", last=previous(l);
  const interrupted=l.rows.findLast(r=>r.type==="部署开始" && !l.rows.some(end=>end.type==="部署" && end.ref===r.ref));
  if (j.step==="部署") requireGate(new Ledger(l.dir),sha);
  if (j.step==="退回" && (last?.type!=="部署" || last.value?.executionId!==t.executionId || !cfg.rollback)) throw new InputError("只能退回项目最新一次部署，且须登记 rollback");
  const steps:{name:string;path:string;code:number;seconds:number;killed:boolean}[]=[];
  const perform=async (cwd:string,name:string,path:string,failed?:string,dir=evidenceDir)=>{
    const time=Date.now(); appendFileSync(log,`$ ${path}\n`);
    const r=await run({...t,worktree:cwd},executable(cwd,path),[],cfg.timeoutMin*60000,undefined,{...cfg.env,LOOP_DEPLOY_COMMIT:sha,LOOP_REPO:t.repo,LOOP_EVIDENCE_DIR:dir,LOOP_DEPLOY_FAILED:failed});
    steps.push({name,path,code:r.code,seconds:(Date.now()-time)/1000,killed:r.killed}); appendFileSync(log,`${r.output}\n退出码 ${r.code}\n`); return !r.code && !r.killed;
  };
  mkdirSync(evidenceDir,{recursive:true}); appendFileSync(log,""); let result:string, kind:Outcome["kind"];
  if (j.step==="退回") {
    const ok=await checkout(t.repo,sha,cwd=>perform(cwd,"rollback",cfg.rollback!,"manual",last!.value.evidenceDir));
    result=ok ? "已退回" : "退回失败"; if (!ok) kind="环境";
  } else if (interrupted) {
    // 不把中断的线上副作用当作成功，也不盲目重发部署。
    const ok=interrupted.sha===sha && !!cfg.rollback && await checkout(t.repo,sha,cwd=>perform(cwd,"rollback",cfg.rollback!,"interrupted",interrupted.value.evidenceDir));
    if (ok) locked(l.dir,book=>book.add({type:"部署",ref:interrupted.ref,result:"失败",kind:"重试",sha,text:"中断部署已回退"}));
    result=ok ? "部署失败，已回退" : "部署失败，回退也失败"; kind=ok ? "重试" : "环境";
  } else {
    const outcome=await checkout(t.repo,sha,async cwd=>{
      for (const path of [cfg.cmd,cfg.check,cfg.rollback]) if (path) executable(cwd,path);
      staticSnapshot(t,cwd,sha,join(evidenceDir,"snapshot-static.json"),last?.sha); await snapshot(t,cwd,sha,join(evidenceDir,"snapshot-before.json"),"live");
      locked(l.dir,book=>book.add({type:"部署开始",ref:j.n,sha,value:{evidenceDir}}));
      const failed=!await perform(cwd,"cmd",cfg.cmd) ? "cmd" : cfg.check && !await perform(cwd,"check",cfg.check) ? "check" : "";
      if (failed) return !cfg.rollback ? "未回退" : await perform(cwd,"rollback",cfg.rollback,failed) ? "已回退" : "回退也失败";
      if (cfg.check) await snapshot(t,cwd,sha,join(evidenceDir,"snapshot-after.json"),"live"); return "";
    });
    result=outcome ? "部署失败，"+outcome : cfg.check ? "已部署" : "已部署（未检查）";
    if (outcome) kind=outcome==="已回退" ? "产品" : "环境";
  }
  const timing=span(start), text=readText(log).trimEnd().split(/\r?\n/).slice(-40).join("\n");
  return {result:kind ? "失败" : "成功",kind,text,value:{executionId:t.executionId,commit:sha,onDev,result,steps,log,evidenceDir,seconds:timing.durationMs/1000},
    check:{step:j.step,commit:sha,result,...timing,evidence:[log,evidenceDir],detail:text}} as Outcome;
}
