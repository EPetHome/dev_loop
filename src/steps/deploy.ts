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
import { pendingDeploy, projectedStop } from "../core/state.ts";
import { alive, retireGroup } from "../infra/exec.ts";
function executable(cwd:string,path:string) {
  const file=resolve(cwd,path);
  try { if (!lstatSync(file).isFile() || !inside(realpathSync(cwd),realpathSync(file))) throw new Error(); accessSync(file,constants.X_OK); return file; }
  catch {throw new InputError("脚本不存在或不可执行："+path);}
}
const peers=(l:Ledger)=>allTasks(dirname(l.dir)).filter(hasLedger).map(d=>new Ledger(d)).filter(other=>other.task.repo===l.task.repo);
export async function deploy(l:Ledger,j:Entry):Promise<Outcome> {
  const start=Date.now(), t=l.task, sha=j.sha!, cfg=t.config.deploy;
  if (!cfg || j.auto && (!cfg.check || !cfg.rollback)) throw new InputError("未登记可用的 deploy.cmd/check/rollback");
  const books=peers(l), interrupted=j.repair ? pendingDeploy(new Ledger(l.dir)) : undefined;
  const last=books.flatMap(b=>b.rows.filter(r=>(r.type==="部署" || r.type==="退回") && r.result==="成功")).sort((a,b)=>a.at.localeCompare(b.at)).at(-1);
  if (j.repair ? interrupted?.ref!==j.repair || interrupted.sha!==sha || last && last.at>interrupted.at : books.some(pendingDeploy))
    throw new InputError("线上仍有待确认的部署，必须先回退原尝试");
  const own=join(l.dir,`deploy-${sha.slice(0,7)}-${j.n}`), evidenceDir=interrupted?.value.evidenceDir || own,
    log=own+".log", onDev=isAncestor(t.repo,sha,devRef);
  if (j.step==="部署" && !interrupted) requireGate(new Ledger(l.dir),sha);
  if (j.step==="退回" && (last?.type!=="部署" || last.value?.executionId!==t.executionId || !cfg.rollback)) throw new InputError("只能退回项目最新一次部署，且须登记 rollback");
  const steps:{name:string;path:string;code:number;seconds:number;killed:boolean}[]=[];
  const perform=async (cwd:string,name:string,path:string,failed?:string,dir=evidenceDir)=>{
    const time=Date.now(); appendFileSync(log,`$ ${path}\n`);
    const r=await run({...t,worktree:cwd},executable(cwd,path),[],cfg.timeoutMin*60000,undefined,{
      ...cfg.env,LOOP_DEPLOY_COMMIT:sha,LOOP_REPO:t.repo,LOOP_EVIDENCE_DIR:dir,LOOP_DEPLOY_FAILED:failed
    },true);
    steps.push({name,path,code:r.code,seconds:(Date.now()-time)/1000,killed:r.killed});
    appendFileSync(log,`${r.output}\n退出码 ${r.code}\n`);
    return !r.code && !r.killed;
  };
  mkdirSync(evidenceDir,{recursive:true}); appendFileSync(log,""); let result:string, kind:Outcome["kind"];
  if (j.step==="退回") {
    if (projectedStop(new Ledger(l.dir))) throw new InputError("任务已停止");
    const ok=await checkout(t.repo,sha,cwd=>perform(cwd,"rollback",cfg.rollback!,"manual",last!.value.evidenceDir));
    result=ok ? "已退回" : "退回失败"; if (!ok) kind="环境";
  } else if (interrupted) {
    const old=l.rows.filter(r=>r.type==="开始" && r.n!==j.n && (r.n===j.repair || r.repair===j.repair));
    if (old.some(r=>alive(r.owner))) throw new InputError("原部署或补偿仍在运行");
    for (const p of l.rows.filter(r=>r.type==="子进程" && r.owner && old.some(s=>s.n===r.ref))) await retireGroup(p.owner!);
    const ok=!!cfg.rollback && await checkout(t.repo,sha,cwd=>perform(cwd,"rollback",cfg.rollback!,"interrupted"));
    result=ok ? "部署失败，已回退" : "部署失败，回退也失败"; if (!ok) kind="环境";
  } else {
    const outcome=await checkout(t.repo,sha,async cwd=>{
      for (const path of [cfg.cmd,cfg.check,cfg.rollback]) if (path) executable(cwd,path);
      staticSnapshot(t,cwd,sha,join(evidenceDir,"snapshot-static.json"),last?.sha); await snapshot(t,cwd,sha,join(evidenceDir,"snapshot-before.json"),"live");
      locked(l.dir,book=>{if(projectedStop(book))throw new InputError("任务已停止");book.add({type:"部署开始",ref:j.n,sha,value:{evidenceDir}});});
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
