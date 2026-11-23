import { realpathSync, rmSync } from "node:fs";
import { atomicWrite } from "../infra/files.ts";
import { dirname, join } from "node:path";
import { noTest } from "./card.ts";
import { removeCheckout } from "../infra/checkout.ts";
import { childExec, signalProcess, type ExecResult } from "../infra/exec.ts";
import { statusOf, update, type Task } from "./store.ts";
// 子进程登记供停止和中断接管使用，不参与结论有效性。
export async function run(t: Task, command: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  if (statusOf(t.dir).state === "cancelled") throw new Error("任务已停止");
  if (timeoutMs <= 0) return {code:137,killed:true,stdout:"",stderr:"检查时限已用完",output:"检查时限已用完"};
  let pid = 0; try { return await childExec(command,args,{cwd:t.worktree,timeoutMs,signal,env:{...env,LOOP_TASK_DIR:t.dir},onSpawn(p) {
    pid = p.pid; update(t.dir,s => { s.loop.activeProcess = p; if (s.state === "cancelled") signalProcess(p,true); });
  }}); } finally { update(t.dir,s => { s.loop.activeProcess = null; },undefined,s => s.loop.activeProcess?.pid === pid); }
}
interface Workload {
  deadline?: number; signal?: AbortSignal; isolated?: NodeJS.ProcessEnv; sealed?: boolean;
}
export async function projectCommand(t: Task, kind: "setup" | "test", log?: string, opts: Workload & {command?:string; planEnv?:NodeJS.ProcessEnv} = {}) {
  const command = kind === "setup" ? t.config.setup : opts.command ?? t.test;
  if (!command) return;
  const {signal,isolated,sealed,planEnv,deadline = Date.now()+t.limits.测试.timeoutMin*60000} = opts;
  const timeoutMs = Math.min(2**31-1,deadline-Date.now()), args = ["-c",command];
  if (isolated && (timeoutMs <= 0 || signal?.aborted)) throw new Error("已中断或用完本端测试时限");
  const r = kind === "test" && noTest(command) ? undefined : isolated
    ? await childExec(sealed ? "/bin/sh" : "sh",args,{cwd:t.worktree,env:{...isolated,...planEnv},replaceEnv:sealed,timeoutMs,signal})
    : await run(t,"sh",args,timeoutMs,signal,planEnv);
  if (log) {
    const dir = sealed ? dirname(log) : planEnv?.LOOP_E2E_DIR;
    if (dir && realpathSync(dir) !== dir) throw new Error("本次尝试目录已改变："+dir);
    const suffix = !isolated && kind === "test" && r?.killed ? "\n复测超时或取消\n" : "";
    atomicWrite(log,r ? r.output+suffix : command+"\n");
  }
  if (kind === "setup" && r && (r.code || r.killed) && (isolated || statusOf(t.dir).state !== "cancelled"))
    throw new Error(`setup 失败（${r.killed ? "超时或取消" : "可修正环境后续跑"}）\n${r.output}`);
  return r;
}
export const operationPath = (dir: string) => join(dir, "operation.lock");
export const checkWorktree = (dir: string) => join(dir,"check-worktree");
export const checkAttempt = (dir: string) => join(dir,"check-attempt.json");
export function clearCheck(t: Task) { rmSync(checkAttempt(t.dir),{force:true}); removeCheckout(t.repo,checkWorktree(t.dir)); }
