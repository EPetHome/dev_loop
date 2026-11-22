import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export interface Identity { pid: number; startedAt: string }
let ownStart = ""; // 只缓存本进程；外部 PID 可能复用。
function ps(pid: number, field: string) { try { return execFileSync("ps",["-p",String(pid),"-o",field+"="],{encoding:"utf8"}).trim(); } catch { return ""; } }
export const identity = (pid = process.pid): Identity => ({pid,startedAt:pid === process.pid ? (ownStart ||= ps(pid,"lstart")) : ps(pid,"lstart")});
export const alive = (p?: Identity | null) => Boolean(p?.pid && p.startedAt && identity(p.pid).startedAt === p.startedAt);
export function signalProcess(p?: Identity | null, group = false): void {
  if (!p || p.pid === process.pid || !alive(p)) return;
  try { process.kill(group ? -p.pid : p.pid,"SIGKILL"); } catch (e) {
    // macOS 僵尸进程组可能返回 EPERM；其他权限错误不能吞掉。
    const {code} = e as NodeJS.ErrnoException; if (code !== "ESRCH" && !(code === "EPERM" && ps(p.pid,"stat").startsWith("Z"))) throw e;
  }
}
export async function retireGroup(p: Identity) {
  signalProcess(p,true); const deadline = Date.now()+2000; // 只向核对了身份的进程组发信号。
  const running = (row: string) => { const [group,stat] = row.trim().split(/\s+/); return Number(group) === p.pid && stat && !stat.startsWith("Z"); };
  for (; execFileSync("ps",["-Ao","pgid=,stat="],{encoding:"utf8"}).split("\n").some(running); await delay(25))
    if (Date.now() >= deadline) throw new Error("旧检查进程组仍未退出："+p.pid);
}
export interface ExecResult { code: number; stdout: string; stderr: string; output: string; killed: boolean }
export interface ExecOptions { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onSpawn?: (p: Identity) => void }
export function childExec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((accept) => {
    const result: ExecResult = {code:0,stdout:"",stderr:"",output:"",killed:false}; let done = false, reap: ReturnType<typeof setTimeout> | undefined;
    const {cwd,timeoutMs,signal,onSpawn} = options, child = spawn(command,args,{cwd,env:{...process.env,...options.env},detached:true,stdio:["ignore","pipe","pipe"]});
    const collect = (stream: "stdout"|"stderr", text: string) => { result[stream] += text; result.output += text; };
    const finish = (code: number) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(reap);
      signal?.removeEventListener("abort",kill); child.stdout.destroy(); child.stderr.destroy(); accept({...result,code});
    };
    const kill = () => {
      result.killed = true;
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      reap ??= setTimeout(() => finish(137), 250);
    };
    // StringDecoder 保留跨管道块的 UTF-8 字符，不能逐块 Buffer.toString 后拼接。
    for (const stream of ["stdout","stderr"] as const) child[stream].setEncoding("utf8").on("data",text => collect(stream,text));
    child.on("error",e => { collect("stderr",String(e)); finish(127); });
    child.on("close",(code,sig) => finish(code ?? (sig ? 137 : 1)));
    const timer = timeoutMs > 0 ? setTimeout(kill,timeoutMs) : undefined;
    signal?.addEventListener("abort",kill,{once:true});
    try { if (child.pid && onSpawn) onSpawn(identity(child.pid)); }
    catch (e) { collect("stderr",String(e)); kill(); } if (signal?.aborted) kill();
  });
}
export async function detach(command: string, args: string[], log: string, cwd: string, env: NodeJS.ProcessEnv, acknowledge = false) {
  const fd = openSync(log,"a"); try {
    const child = spawn(command,args,{cwd,env,detached:true,stdio:acknowledge?["ignore",fd,fd,"ipc"]:["ignore",fd,fd]});
    await new Promise<void>((ok,no) => {
      child.once("error",no).once(acknowledge ? "message" : "spawn",ok);
      if (acknowledge) child.once("exit",(code,signal)=>no(new Error("下一卡启动未登记："+(signal || code))));
    });
    if (child.connected) child.disconnect(); child.unref();
  } finally { closeSync(fd); }
}
