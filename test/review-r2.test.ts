import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fixture, write, until, getJson, NODE, ROOT } from "./helpers.ts";
import { identity, alive, signalProcess } from "../src/infra/exec.ts";
import { statusOf, type Task } from "../src/core/store.ts";
import { registerSession } from "../src/core/lifecycle.ts";
import { registerPi } from "../src/hosts/pi.ts";
import { handleHook } from "../src/hosts/hook.ts";

/** 独立于后台 launcher 的真实子进程树，模拟 Terminal；Pi 替身等文件信号才登记。 */
function startHeldTerminal(f: ReturnType<typeof fixture>, task: Task, id: string) {
  const pi = join(f.base, "held-pi.cjs"), permission = join(f.base, "permission.ts");
  write(permission, "// fixture only\n");
  write(pi, "#!" + NODE + "\n" +
    "const fs=require('fs'),dir=process.env.LOOP_TASK_DIR;let attempted=false;" +
    "fs.writeFileSync(dir+'/pi-started.json',JSON.stringify({pid:process.pid}));" +
    "const register=async()=>{if(attempted||!fs.existsSync(dir+'/register-go'))return;attempted=true;" +
    "const {registerSession}=await import(" + JSON.stringify(join(ROOT, "src/core/lifecycle.ts")) + ");" +
    "const accepted=registerSession(dir,'pi','controlled-session',process.pid);" +
    "fs.writeFileSync(dir+'/registration.json',JSON.stringify({accepted}));};" +
    "fs.watch(dir,register);register();\n");
  execFileSync("chmod", ["+x", pi]);
  write(join(task.dir, "launch-" + id + ".json"), JSON.stringify({
    args: ["--cwd", task.worktree, join(f.repo, "prompt.md")], deadline: Date.now() + 60000,
  }));
  write(join(task.dir, "launch-" + id + ".log"), "");
  const wrapper = spawn(NODE, [join(ROOT, "src/hosts/launch.ts"), "--terminal", task.dir, id], {
    cwd: f.repo, detached: true, stdio: "ignore",
    env: {...f.env, LOOP_TASK_DIR: task.dir, PI_BIN: pi, PERMISSION_EXTENSION: permission},
  });
  const closed = once(wrapper, "close"), owner = identity(wrapper.pid!);
  return {closed, async cleanup() { signalProcess(owner, true); await closed; }};
}
for (const registeredFirst of [false, true]) test("r2 必修1：创建/登记交接中的进程能被 CLI 停止，已登记=" + registeredFirst, async (t) => {
  const f = fixture(t), task = await f.prepare(), id = "controlled", terminal = startHeldTerminal(f, task, id);
  try {
    const started = await until(task.dir, () => getJson<{pid: number}>(join(task.dir, "pi-started.json")), v => !!v.pid);
    const p = identity(started.pid);
    const pending = await until(task.dir, () => statusOf(task.dir), s => s.loop.startingSession?.pid === p.pid);
    assert.equal(pending.loop.session, null); assert.equal(pending.loop.launcher, null);
    assert.equal(pending.loop.startingSession?.launchId, id); assert.equal(pending.loop.startingSession?.startedAt, p.startedAt);
    assert.equal(alive(p), true);
    if (registeredFirst) {
      write(join(task.dir, "register-go"), "register");
      const result = await until(task.dir, () => getJson(join(task.dir, "registration.json")), v => v.accepted);
      assert.equal(result.accepted, true);
      const s = statusOf(task.dir); assert.equal(s.loop.session?.pid, p.pid); assert.equal(s.loop.startingSession, null);
    }
    const stopped = JSON.parse((await f.cli(["停止", task.executionId, "--json"])).stdout);
    assert.equal(stopped.state, "cancelled");
    // 必须观察包装器因 Pi 退出自行结束；先断言，再执行测试兜底清理，不能用清理冒充停止成功。
    const exited = await until(task.dir, () => getJson(join(task.dir, "launch-" + id + "-exit.json")), () => true);
    assert.notEqual(exited.code, 0); await terminal.closed;
    assert.equal(alive(p), false);
    const s = statusOf(task.dir); assert.equal(s.state, "cancelled"); assert.equal(s.loop.startingSession, null);
    if (!registeredFirst) {
      assert.equal(s.loop.session, null); assert.equal(existsSync(join(task.dir, "registration.json")), false);
    }
  } finally { await terminal.cleanup(); }
});
test("r2 必修1：取消先发生时，迟到终端不能创建会话进程", async (t) => {
  const f = fixture(t), task = await f.prepare();
  await f.cli(["停止", task.executionId, "--json"]);
  const terminal = startHeldTerminal(f, task, "cancelled-first");
  try {
    const [code] = await terminal.closed; assert.notEqual(code, 0);
    assert.equal(existsSync(join(task.dir, "pi-started.json")), false);
    assert.equal(existsSync(join(task.dir, "launch-cancelled-first-pid.json")), false);
    assert.match(readFileSync(join(task.dir, "launch-cancelled-first-exit.json"), "utf8"), /任务已停止/);
    assert.equal(statusOf(task.dir).loop.startingSession, null);
  } finally { await terminal.cleanup(); }
});
test("r2 必修1：取消后的迟到登记被拒绝，pi 不启动心跳并请求退出", async (t) => {
  const f = fixture(t), task = await f.prepare();
  await f.cli(["停止", task.executionId, "--json"]);
  assert.equal(registerSession(task.dir, "pi", "late", process.pid), false);
  const events: Record<string, any> = {}; let shutdown = false;
  registerPi({on(name, handler) { events[name] = handler; }, sendMessage() { assert.fail("不应注入开发约定"); }}, {
    env: {LOOP_TASK_DIR: task.dir}, every() { assert.fail("不应启动心跳"); },
  });
  events.session_start({}, {cwd: task.worktree, shutdown() { shutdown = true; },
    sessionManager: {getSessionId: () => "late-pi", getBranch: () => []}});
  assert.equal(shutdown, true); events.session_shutdown();
  assert.equal(await handleHook({cwd: task.worktree, session_pid: process.pid}, "SessionStart", {...f.env, LOOP_TASK_DIR: task.dir}), "");
  const s = statusOf(task.dir); assert.equal(s.state, "cancelled"); assert.equal(s.loop.session, null);
});
