import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
export interface Identity { pid: number; startedAt: string }
let ownStart = ""; // 只缓存本进程；外部 PID 可能复用。
function ps(pid: number, field: string) { try { return execFileSync("ps",["-p",String(pid),"-o",field+"="],{encoding:"utf8"}).trim(); } catch { return ""; } }
export const identity = (pid = process.pid): Identity => ({pid,startedAt:pid === process.pid ? (ownStart ||= ps(pid,"lstart")) : ps(pid,"lstart")});
export const alive = (p?: Identity | null) => Boolean(p?.pid && p.startedAt && identity(p.pid).startedAt === p.startedAt);
export function signalProcess(p?: Identity | null, group = false): void {
  if (!p || p.pid===process.pid || !alive(p)) return; try {process.kill(group?-p.pid:p.pid,"SIGKILL");} catch (e) { // macOS 僵尸进程组可能返回 EPERM。
    const {code} = e as NodeJS.ErrnoException; if (code !== "ESRCH" && !(code === "EPERM" && ps(p.pid,"stat").startsWith("Z"))) throw e;
  }
}
export async function retireGroup(p: Identity) {
  const replaced = () => { const start = identity(p.pid).startedAt; return Boolean(p.startedAt && start && start !== p.startedAt); };
  if (replaced()) return; signalProcess(p,true); // 查不到组长不等于 PID 已复用，仍要检查旧组。
  const deadline=Date.now()+2000, running=(row:string)=>{const [group,stat]=row.trim().split(/\s+/);return Number(group)===p.pid && stat && !stat.startsWith("Z");};
  for (; execFileSync("ps",["-Ao","pgid=,stat="],{encoding:"utf8"}).split("\n").some(running) && !replaced(); await delay(25))
    if (Date.now()>=deadline) throw new Error("旧检查进程组仍未退出："+p.pid);
}
export interface ExecResult { code: number; stdout: string; stderr: string; output: string; killed: boolean }
export interface ExecOptions { cwd:string; timeoutMs:number; env?:NodeJS.ProcessEnv; replaceEnv?:boolean; signal?:AbortSignal; register?: (p:Identity)=>void; gate?:boolean }
export function childExec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((accept) => {
    const result: ExecResult = {code:0,stdout:"",stderr:"",output:"",killed:false}; let done = false, reap: ReturnType<typeof setTimeout> | undefined;
    // 明确许可前只读私有管道；父进程死亡即 EOF，exec 保留已登记的 PID/PGID。
    const {cwd,timeoutMs,signal,register,env,replaceEnv,gate}=options, launch=gate ? ["-c",'IFS= read -r permit && [ "$permit" = go ] || exit 125; exec "$@" </dev/null',"dev-loop-start",command,...args] : args;
    const child=spawn(gate ? "/bin/sh" : command,launch,{cwd,env:replaceEnv ? env || {} : {...process.env,...env},detached:true,stdio:[gate ? "pipe" : "ignore","pipe","pipe"]});
    const collect = (stream: "stdout"|"stderr", text: string) => { result[stream] += text; result.output += text; };
    const finish = (code: number) => {
      if (done) return; done=true; clearTimeout(timer); clearTimeout(reap);
      signal?.removeEventListener("abort",kill); child.stdin?.destroy(); child.stdout.destroy(); child.stderr.destroy(); accept({...result,code});
    };
    const kill = () => {
      if (done) return; result.killed=true; try {if (child.pid) process.kill(-child.pid,"SIGKILL");}catch{}
      reap ??= setTimeout(() => finish(137), 250);
    };
    // StringDecoder 保留跨管道块的 UTF-8 字符，不能逐块 Buffer.toString 后拼接。
    for (const stream of ["stdout","stderr"] as const) child[stream].setEncoding("utf8").on("data",text => collect(stream,text));
    child.on("error",e => { collect("stderr",String(e)); finish(127); }); child.stdin?.on("error",e=>{collect("stderr",String(e));kill();});
    child.on("close",(code,sig) => finish(code ?? (sig ? 137 : 1)));
    const timer=timeoutMs>0 ? setTimeout(kill,timeoutMs) : undefined; signal?.addEventListener("abort",kill,{once:true});
    try {
      if (child.pid && register) {const owner=identity(child.pid);if(gate && !owner.startedAt)throw new Error("未取得线上脚本进程身份");register(owner);}
      if (signal?.aborted) kill(); else child.stdin?.end(child.pid && register ? "go\n" : undefined);
    } catch(e) {collect("stderr",String(e));kill();child.stdin?.destroy();}
  });
}
