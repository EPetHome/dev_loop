import { rmSync } from "node:fs";
import { join } from "node:path";
import { removeCheckout } from "../infra/checkout.ts";
import { childExec, signalProcess, type ExecResult } from "../infra/exec.ts";
import { statusOf, update, type Task } from "./store.ts";
/** 子进程登记只为停止命令可结束当前复测/评审，不参与结论有效性。 */
export async function run(t: Task, command: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  if (statusOf(t.dir).state === "cancelled") throw new Error("任务已停止");
  if (timeoutMs <= 0) return {code:137,killed:true,stdout:"",stderr:"检查时限已用完",output:"检查时限已用完"};
  let pid = 0;
  try {
    return await childExec(command,args,{cwd:t.worktree,timeoutMs,signal,env:{...env,LOOP_TASK_DIR:t.dir},onSpawn(p) {
      pid = p.pid; update(t.dir, s => { s.loop.activeProcess = p; if (s.state === "cancelled") signalProcess(p,true); });
    }});
  } finally { update(t.dir,s => { if (s.loop.activeProcess?.pid === pid) s.loop.activeProcess = null; }); }
}
export const operationPath = (dir: string) => join(dir, "operation.lock");
export const checkWorktree = (dir: string) => join(dir,"check-worktree");
export const checkAttempt = (dir: string) => join(dir,"check-attempt.json");
export function clearCheck(t: Task) { rmSync(checkAttempt(t.dir),{force:true}); removeCheckout(t.repo,checkWorktree(t.dir)); }
