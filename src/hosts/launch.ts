/** 独立启动入口：CLI 通过子进程调用它，不引入 cli → hosts 的模块依赖。 */
import { writeFileSync, appendFileSync, readFileSync, watch } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT, shellQuote } from "../infra/paths.ts";
import { childExec, identity, alive, signalProcess, type Identity } from "../infra/exec.ts";
import { readJson, optionalJson, writeJson } from "../infra/files.ts";
import { randomUUID } from "node:crypto";
import { taskOf, statusOf, waitFor, update, fail, inputs, launchStarted } from "../core/store.ts";
import { prepare, heartbeat } from "../core/lifecycle.ts";
import { settle } from "../core/settle.ts";
import { startCompanion, startFinish } from "./after-settle.ts";
import { convention } from "./convention.ts";
interface LaunchOptions {
  openTerminal?: (script: string) => Promise<void>;
  startupTimeoutMs?: number; env?: NodeJS.ProcessEnv;
  reviewOnly?: boolean; confirmedCommit?: string; handoff?: boolean; retest?: string;
}
function launchFiles(dir: string, id: string) {
  const base = join(dir,`launch-${id}`); return {request:base+".json",pid:base+"-pid.json",exit:base+"-exit.json",log:base+".log"};
}
/** 在 Terminal 内保留真实 TTY；只收集 stderr，回报子进程退出及其原始错误。 */
export async function terminalSession(dir: string, id: string): Promise<number> {
  const t = taskOf(dir), files = launchFiles(dir,id), request = readJson<{args:string[];deadline:number}>(files.request);
  let raw = "", child: ChildProcess | undefined, code = 1;
  const note = (text: string) => { raw += text; appendFileSync(files.log,text); };
  try { // 创建与发布同持状态锁：停止先发生时不会再创建会话。
    update(dir,s => {
      if (s.state !== "working" || Date.now() >= request.deadline) return;
      child = spawn(join(APP_ROOT,"bin/pi-dev"),request.args,{cwd:t.worktree,env:{...process.env,LOOP_TASK_DIR:dir},stdio:["inherit","inherit","pipe"]});
      child.stderr!.setEncoding("utf8").on("data",(text: string) => { note(text); process.stderr.write(text); });
      if (!child.pid) return;
      const p = identity(child.pid);
      if (p.startedAt) { s.loop.startingSession = {...p,launchId:id}; writeJson(files.pid,p); }
      else { raw += "无法读取待登记会话进程身份"; child.kill("SIGKILL"); }
    });
  } catch (e) { child?.kill("SIGKILL"); throw e; }
  if (!child) raw = "会话启动请求已过期或任务已停止";
  else {
    try { code = (await once(child,"close"))[0] ?? 1; }
    catch (e) { note(String(e)); code = 127; }
    update(dir,s => { if (s.loop.startingSession?.launchId === id) s.loop.startingSession = null; });
  }
  writeJson(files.exit,{code,raw}); return code;
}
async function waitForSession(dir: string, id: string, timeoutMs: number) {
  const files = launchFiles(dir,id); let watcher: ReturnType<typeof watch> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((accept,reject) => {
      const check = () => {
        try {
          const s = statusOf(dir), {session} = s.loop, pid = optionalJson<Identity>(files.pid);
          if (s.state !== "working") { if (s.state === "failed") throw new Error(s.error?.raw || s.message); return accept(); }
          if (pid && session?.pid === pid.pid && session.startedAt === pid.startedAt && !session.endedAt && alive(session)) return accept();
          const exit = optionalJson<{code:number;raw:string}>(files.exit);
          if (exit) throw new Error(`pi 开发会话启动失败（登记前退出，退出码 ${exit.code}）\n${exit.raw}`);
        } catch (e) { reject(e); }
      };
      watcher = watch(dir,check).on("error",reject); check();
      timer = setTimeout(() => {
        try { signalProcess(optionalJson<Identity>(files.pid)); throw new Error("pi 开发会话启动超时，未确认本次会话登记\n" + readFileSync(files.log,"utf8")); }
        catch (e) { reject(e); }
      },Math.max(0,timeoutMs));
    });
  } finally { watcher?.close(); clearTimeout(timer); }
}
export async function launchSession(dir: string, resuming = false, options: LaunchOptions = {}): Promise<void> {
  const t = taskOf(dir), s = statusOf(dir), prompt = join(dir,"developer-prompt.md"); if (s.state === "cancelled") return;
  const opening = resuming && s.loop.pendingOpening ? s.loop.pendingReturn : null;
  writeFileSync(prompt, convention(t) + "\n\n" + inputs(t).prompt + (opening ? "\n\n## 续跑带话\n" + opening : ""));
  const {session} = s.loop, args = ["--cwd",t.worktree,"--name",t.executionId,
    ...(resuming && session?.id ? ["--session", session.file || session.id] : ["--session-id", t.executionId]), prompt];
  const env = options.env || process.env;
  if (env.LOOP_LAUNCH_CMD && !options.openTerminal) {
    const result = await childExec(env.LOOP_LAUNCH_CMD, args, {cwd:t.worktree,env:{...env,LOOP_TASK_DIR:dir,LOOP_HOST:t.host},timeoutMs:30000});
    if (result.code !== 0) throw new Error("会话启动失败\n"+result.output); return;
  }
  if (t.host !== "pi") {
    waitFor(dir,"需手动接入会话","工作区已就绪。本步 Claude/Codex 仅提供 hook 接入（插件未安装）；请手动在 worktree 开会话并连接 hosts/hook.ts，再续跑；或改用 pi。"+(s.loop.pendingReturn ? "\n未送达，需在窗口里说；下一次 hook 交接。" : "")); return;
  }
  const id = randomUUID(), files = launchFiles(dir, id), timeoutMs = options.startupTimeoutMs ?? 60000;
  const deadline = Date.now() + timeoutMs, script = join(dir, "open-session.sh");
  writeJson(files.request, {args, deadline}); writeFileSync(files.log, "");
  const exports = ["PI_BIN", "PI_NODE_BIN", "PERMISSION_EXTENSION", "LOOP_CAFFEINATE_CMD"].filter((key) => env[key] !== undefined)
    .map((key) => "export " + key + "=" + shellQuote(env[key]!) + "\n").join("");
  writeFileSync(script, "#!/bin/sh\nexport LOOP_TASK_DIR=" + shellQuote(dir) + "\n" + exports + "exec " +
    [process.execPath, join(APP_ROOT, "src/hosts/launch.ts"), "--terminal", dir, id].map(shellQuote).join(" ") + "\n", {mode:0o700});
  update(dir, (s) => { if (s.state === "working") { s.message = "等待 pi 开发会话登记"; s.loop.bucket = "selfMs"; s.timeLimitSec = Math.ceil(timeoutMs / 1000); s.evidence.push(files.log); } });
  const openTerminal = options.openTerminal || (async (file: string) => {
    const result = await childExec("osascript", ["-e", 'tell application "Terminal"\n do script ' + JSON.stringify("sh " + shellQuote(file)) + '\n activate\nend tell'],
      {cwd:t.worktree,timeoutMs:Math.min(30000, timeoutMs)});
    if (result.code !== 0) throw new Error("终端启动失败\n" + result.output);
  });
  await openTerminal(script); await waitForSession(dir,id,deadline-Date.now());
  update(dir, (s) => { if (s.state === "working") { s.message = "pi 开发会话已登记"; s.loop.bucket = "developmentMs"; s.timeLimitSec = null; } });
}
export async function launchMain(dir: string, resuming: boolean, options: LaunchOptions = {}): Promise<void> {
  let claimed = false; const s = update(dir,s => {
    if (s.state !== "working" || options.handoff && launchStarted(s) ||
        options.retest && (s.loop.phase !== "复测中" || s.loop.retestAttempt !== options.retest || alive(s.loop.launcher))) return;
    s.loop.launcher = identity(); s.loop.launchStarted = claimed = true;
  });
  if (options.handoff && launchStarted(s)) process.send?.("started", () => {}); // 持久领取之后才应答。
  if (!claimed) return;
  const timer = setInterval(() => heartbeat(dir),60000); timer.unref();
  try {
    if (options.reviewOnly || options.confirmedCommit || options.retest) {
      const result = await settle(dir, "", options);
      if (!result.continue || statusOf(dir).state !== "working") { await startFinish(dir, options.env || process.env); return; }
      const source = options.reviewOnly ? "补评审" : options.retest ? "后台复测" : "确认交付后检查";
      if (taskOf(dir).host !== "pi") { waitFor(dir,"需手动接入会话",`${source}需返修，尚未送达。请在已接入 hook 的原会话继续，或重新接入；下一次 hook 会交接返修要求。\n${result.reason}`,result.reason); return; }
      update(dir, s => { if (s.state === "working") s.loop.pendingReturn = result.reason; });
      const {session} = statusOf(dir).loop; if (alive(session) && !session?.endedAt) return;
      resuming = true;
    }
    if (!statusOf(dir).loop.ready) await prepare(dir);
    if (statusOf(dir).state !== "cancelled") { await startCompanion(dir,options.env || process.env); await launchSession(dir,resuming,options); }
  } catch (e) { fail(dir,e); throw e; }
  finally { clearInterval(timer); update(dir,s => { if (s.loop.launcher?.pid === process.pid) s.loop.launcher = null; }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, mode, value] = process.argv.slice(2);
  const main = target === "--terminal" ? terminalSession(resolve(mode), value).then(code => { process.exitCode = code; })
    : launchMain(resolve(target), mode === "--resume", {reviewOnly: mode === "--review", confirmedCommit: mode === "--delivery" ? value : undefined, retest: mode === "--retest" ? value : undefined, handoff: mode === "--handoff"});
  main.catch((e)=>{console.error(e);process.exitCode=1;});
}
