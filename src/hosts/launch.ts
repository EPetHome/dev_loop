/** 独立启动入口：CLI 通过子进程调用它，不引入 cli → hosts 的模块依赖。 */
import { writeFileSync, appendFileSync, readFileSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT, shellQuote } from "../infra/paths.ts";
import { childExec, identity, alive, signalProcess, type Identity } from "../infra/exec.ts";
import { readJson, optionalJson, writeJson } from "../infra/files.ts";
import { randomUUID } from "node:crypto";
import { taskOf, statusOf, transition, update, fail, inputs } from "../core/store.ts";
import { prepare, heartbeat } from "../core/lifecycle.ts";
interface LaunchOptions {
  openTerminal?: (script: string) => Promise<void>;
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}
const launchFiles = (dir: string, id: string) => ({
  request: join(dir, "launch-" + id + ".json"), pid: join(dir, "launch-" + id + "-pid.json"),
  exit: join(dir, "launch-" + id + "-exit.json"), log: join(dir, "launch-" + id + ".log"),
});
/** 在 Terminal 内保留真实 TTY；只收集 stderr，回报子进程退出及其原始错误。 */
export async function terminalSession(dir: string, id: string): Promise<number> {
  const t = taskOf(dir), files = launchFiles(dir, id);
  const request = readJson<{args: string[]; deadline: number}>(files.request);
  if (statusOf(dir).state !== "working" || Date.now() >= request.deadline) {
    writeJson(files.exit, {code: 1, raw: "会话启动请求已过期或任务已停止"}); return 1;
  }
  return new Promise((accept, reject) => {
    let raw = "", finished = false, child: ReturnType<typeof spawn> | undefined;
    const finish = (code: number) => {
      if (finished) return; finished = true;
      update(dir, (s) => { if (s.loop.startingSession?.launchId === id) s.loop.startingSession = null; });
      writeJson(files.exit, {code, raw}); accept(code);
    };
    try {
      // 与 stop/registerSession 共用状态锁：创建+发布要么先于取消，要么取消后不再创建。
      update(dir, (s) => {
        if (s.state !== "working" || Date.now() >= request.deadline) return;
        child = spawn(join(APP_ROOT, "bin/pi-dev"), request.args, {
          cwd: t.worktree, env: {...process.env, LOOP_TASK_DIR: dir}, stdio: ["inherit", "inherit", "pipe"],
        });
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (text: string) => { raw += text; appendFileSync(files.log, text); process.stderr.write(text); });
        child.once("error", (e) => { raw += String(e); appendFileSync(files.log, String(e)); finish(127); });
        child.once("close", (code) => finish(code ?? 1));
        if (child.pid) {
          const p = identity(child.pid);
          if (p.startedAt) { s.loop.startingSession = {...p, launchId: id}; writeJson(files.pid, p); }
          else { raw += "无法读取待登记会话进程身份"; child.kill("SIGKILL"); }
        }
      });
      if (!child) { raw = "会话启动请求已过期或任务已停止"; finish(1); }
    } catch (e) { finished = true; child?.kill("SIGKILL"); reject(e); }
  });
}
function waitForSession(dir: string, id: string, timeoutMs: number): Promise<void> {
  const files = launchFiles(dir, id);
  return new Promise((accept, reject) => {
    let done = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done) return; done = true; watcher.close(); clearTimeout(timer);
      if (error) reject(error); else accept();
    };
    const check = () => {
      if (done) return;
      try {
        const s = statusOf(dir), pid = optionalJson<Identity>(files.pid);
        if (s.state !== "working") { finish(s.state === "failed" ? new Error(s.error?.raw || s.message) : undefined); return; }
        const session = s.loop.session;
        if (pid && session && pid.pid === session.pid && pid.startedAt === session.startedAt && !session.endedAt && alive(session)) { finish(); return; }
        const exited = optionalJson<{code: number; raw: string}>(files.exit);
        if (exited) finish(new Error("pi 开发会话启动失败（登记前退出，退出码 " + exited.code + "）\n" + exited.raw));
      } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
    };
    const watcher = watch(dir, check); watcher.on("error", finish);
    timer = setTimeout(() => {
      try {
        signalProcess(optionalJson<Identity>(files.pid));
        finish(new Error("pi 开发会话启动超时，未确认本次会话登记\n" + readFileSync(files.log, "utf8")));
      } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
    }, Math.max(0, timeoutMs));
    check();
  });
}
export async function launchSession(dir: string, resuming = false, options: LaunchOptions = {}): Promise<void> {
  const t = taskOf(dir);
  if (statusOf(dir).state === "cancelled") return;
  const prompt = join(dir, "developer-prompt.md");
  writeFileSync(prompt, "完成后运行 " + APP_ROOT + "/bin/loop 交付。交付只提交并登记；停下后自动复测、评审。\n\n" + inputs(t).prompt);
  const session = statusOf(dir).loop.session;
  const args = ["--cwd", t.worktree, "--name", t.executionId,
    ...(resuming && session?.id ? ["--session", session.file || session.id] : ["--session-id", t.executionId]), prompt];
  const env = options.env || process.env;
  if (env.LOOP_LAUNCH_CMD && !options.openTerminal) {
    const result = await childExec(env.LOOP_LAUNCH_CMD, args, {cwd:t.worktree,env:{...env,LOOP_TASK_DIR:dir,LOOP_HOST:t.host},timeoutMs:30000});
    if (result.code !== 0) throw new Error("会话启动失败\n" + result.output);
    return;
  }
  if (t.host !== "pi") {
    transition(dir,"input_required","等你","工作区已就绪。本步 Claude/Codex 仅提供 hook 接入（插件未安装）；请手动在 worktree 开会话并连接 hosts/hook.ts，再续跑；或改用 pi。", "inputMs");
    return;
  }
  const id = randomUUID(), files = launchFiles(dir, id), timeoutMs = options.startupTimeoutMs ?? 60000;
  const deadline = Date.now() + timeoutMs, script = join(dir, "open-session.sh");
  writeJson(files.request, {args, deadline}); writeFileSync(files.log, "");
  const exports = ["PI_BIN", "PI_NODE_BIN", "PERMISSION_EXTENSION"].filter((key) => env[key] !== undefined)
    .map((key) => "export " + key + "=" + shellQuote(env[key]!) + "\n").join("");
  writeFileSync(script, "#!/bin/sh\nexport LOOP_TASK_DIR=" + shellQuote(dir) + "\n" + exports + "exec " +
    [process.execPath, join(APP_ROOT, "src/hosts/launch.ts"), "--terminal", dir, id].map(shellQuote).join(" ") + "\n", {mode:0o700});
  update(dir, (s) => { if (s.state === "working") { s.message = "等待 pi 开发会话登记"; s.loop.bucket = "selfMs"; s.timeLimitSec = Math.ceil(timeoutMs / 1000); s.evidence.push(files.log); } });
  const openTerminal = options.openTerminal || (async (file: string) => {
    const result = await childExec("osascript", ["-e", 'tell application "Terminal"\n do script ' + JSON.stringify("sh " + shellQuote(file)) + '\n activate\nend tell'],
      {cwd:t.worktree,timeoutMs:Math.min(30000, timeoutMs)});
    if (result.code !== 0) throw new Error("终端启动失败\n" + result.output);
  });
  await openTerminal(script);
  await waitForSession(dir, id, deadline - Date.now());
  update(dir, (s) => { if (s.state === "working") { s.message = "pi 开发会话已登记"; s.loop.bucket = "developmentMs"; s.timeLimitSec = null; } });
}
export async function launchMain(dir: string, resuming: boolean, options: LaunchOptions = {}): Promise<void> {
  update(dir, (s) => { s.loop.launcher = identity(); });
  const timer = setInterval(() => heartbeat(dir),60000); timer.unref();
  try {
    if (!statusOf(dir).loop.ready) await prepare(dir);
    if (statusOf(dir).state !== "cancelled") await launchSession(dir,resuming,options);
  } catch (e) { fail(dir,e); throw e; }
  finally {
    clearInterval(timer);
    update(dir, (s) => { if (s.loop.launcher?.pid === process.pid) s.loop.launcher = null; });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = process.argv[2] === "--terminal"
    ? terminalSession(resolve(process.argv[3]), process.argv[4]).then((code) => { process.exitCode = code; })
    : launchMain(resolve(process.argv[2]), process.argv.includes("--resume"));
  main.catch((e)=>{console.error(e);process.exitCode=1;});
}
