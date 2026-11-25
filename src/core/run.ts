import { realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../infra/files.ts";
import { noTest } from "./card.ts";
import { removeCheckout } from "../infra/checkout.ts";
import { childExec, signalProcess, type ExecResult } from "../infra/exec.ts";
import { locked, Ledger, type Task } from "./store.ts";
import { projectedStop } from "./state.ts";
export async function run(t:Task,command:string,args:string[],timeoutMs:number,signal?:AbortSignal,env?:NodeJS.ProcessEnv,drain=false):Promise<ExecResult> {
  const ref=Number(process.env.LOOP_JOB); if (drain && !ref) throw new Error("线上脚本缺少工具登记");
  if (!drain && projectedStop(new Ledger(t.dir))) throw new Error("任务已停止");
  if (timeoutMs<=0) return {code:137,killed:true,stdout:"",stderr:"检查时限已用完",output:"检查时限已用完"};
  return childExec(command,args,{
    cwd:t.worktree,timeoutMs,signal,gate:drain,env:{...env,LOOP_TASK_DIR:t.dir,LOOP_ROLE:"worker"},
    register:ref ? owner=>locked(t.dir,l=>{
      l.add({type:"子进程",ref,owner}); if (!drain && projectedStop(l)) signalProcess(owner,true);
    }) : undefined
  });
}
export async function projectCommand(t:Task,kind:"setup"|"test",log:string,opts:{
  deadline?:number;signal?:AbortSignal;isolated?:NodeJS.ProcessEnv;sealed?:boolean;command?:string;planEnv?:NodeJS.ProcessEnv
}={}) {
  const command=kind==="setup" ? t.config.setup : opts.command ?? t.test; if (!command) return;
  const {signal,isolated,sealed,planEnv,deadline=Date.now()+t.limits.测试.timeoutMin*60000}=opts,
    timeoutMs=Math.min(2**31-1,deadline-Date.now()), args=["-c",command];
  if (isolated && (timeoutMs<=0 || signal?.aborted)) throw new Error("已中断或用完本端测试时限");
  const r=kind==="test" && noTest(command) ? undefined
    : isolated ? await childExec(sealed ? "/bin/sh" : "sh",args,{
      cwd:t.worktree,env:{...isolated,...planEnv},replaceEnv:sealed,timeoutMs,signal
    }) : await run(t,"sh",args,timeoutMs,signal,planEnv);
  const dir=sealed ? dirname(log) : planEnv?.LOOP_E2E_DIR;
  if (dir && realpathSync(dir)!==dir) throw new Error("本次尝试目录已改变："+dir);
  atomicWrite(log,r ? r.output+(r.killed?"\n超时或取消\n":"") : command+"\n");
  if (kind==="setup" && r && (r.code || r.killed)) throw new Error("setup 失败\n"+r.output); return r;
}
export const checkWorktree=(dir:string)=>join(dir,"check-worktree");
export const checkAttempt=(dir:string)=>join(dir,"check-attempt.json");
export function clearCheck(t:Task) { rmSync(checkAttempt(t.dir),{force:true}); removeCheckout(t.repo,checkWorktree(t.dir)); }
