import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
export interface Identity { pid: number; startedAt: string }
let ownStart = ""; // 只缓存本进程；外部 PID 可能复用。
function processStart(pid: number) {
  try { return execFileSync("ps",["-p",String(pid),"-o","lstart="],{encoding:"utf8"}).trim(); } catch { return ""; }
}
export const identity = (pid = process.pid): Identity => ({pid, startedAt: pid === process.pid ? (ownStart ||= processStart(pid)) : processStart(pid)});
export const alive = (p?: Identity | null) => Boolean(p?.pid && p.startedAt && identity(p.pid).startedAt === p.startedAt);
export function signalProcess(p?: Identity | null, group = false): void {
  if (!p || p.pid === process.pid || !alive(p)) return;
  try { process.kill(group ? -p.pid : p.pid, "SIGKILL"); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM") {
      let stat = "";
      try { stat = execFileSync("ps", ["-p", String(p.pid), "-o", "stat="], {encoding: "utf8"}).trim(); } catch {}
      if (stat.startsWith("Z")) return; // macOS 僵尸进程组可能返回 EPERM；其他权限错误不能吞掉。
    }
    throw e;
  }
}
export interface ExecResult { code: number; stdout: string; stderr: string; output: string; killed: boolean }
export interface ExecOptions {
  cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  onSpawn?: (p: Identity) => void;
}
export function childExec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((accept) => {
    let stdout = "", stderr = "", output = "", killed = false, done = false;
    let timer: ReturnType<typeof setTimeout> | undefined, reap: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env },
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code: number) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(reap);
      options.signal?.removeEventListener("abort", kill);
      child.stdout.destroy(); child.stderr.destroy();
      accept({ code, stdout, stderr, output, killed });
    };
    const kill = () => {
      killed = true;
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      reap ??= setTimeout(() => finish(137), 250);
    };
    // StringDecoder 保留跨管道块的 UTF-8 字符，不能逐块 Buffer.toString 后拼接。
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (b) => { stdout += b.toString(); output += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); output += b.toString(); });
    child.on("error", (e) => { stderr += String(e); output += String(e); finish(127); });
    child.on("close", (code, sig) => finish(code ?? (sig ? 137 : 1)));
    if (options.timeoutMs > 0) timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    try { if (child.pid) options.onSpawn?.(identity(child.pid)); }
    catch (e) { stderr += String(e); output += String(e); kill(); }
    if (options.signal?.aborted) kill();
  });
}
export async function detach(command: string, args: string[], log: string, cwd: string, env: NodeJS.ProcessEnv, acknowledge = false) {
  const fd = openSync(log,"a");
  try {
    const child = spawn(command,args,{cwd,env,detached:true,stdio:acknowledge?["ignore",fd,fd,"ipc"]:["ignore",fd,fd]});
    await new Promise<void>((ok,no) => {
      child.once("error",no); child.once(acknowledge ? "message" : "spawn",ok);
      if (acknowledge) child.once("exit",(code,signal)=>no(new Error("下一卡启动未登记："+(signal || code))));
    });
    if (child.connected) child.disconnect(); child.unref();
  } finally { closeSync(fd); }
}
