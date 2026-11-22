import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fixture, write, until, NODE, ROOT, getJson } from "./helpers.ts";
import { gitText, head, changes } from "../src/infra/git.ts";
import { identity, signalProcess } from "../src/infra/exec.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { statusOf, checksOf } from "../src/core/store.ts";
import { handleHook } from "../src/hosts/hook.ts";
import { registerSession } from "../src/core/lifecycle.ts";
import { readCard } from "../src/core/card.ts";
import { launchMain, terminalSession } from "../src/hosts/launch.ts";
import { HOOK_TIMEOUT_SEC, HOOK_OVERHEAD_SEC } from "../src/infra/host-limits.ts";

function hiddenIndexChange(worktree: string, path: string, staged: string) {
  const file = join(worktree, path), original = readFileSync(file, "utf8");
  write(file, staged); gitText(worktree, ["add", "--", path]); write(file, original);
  assert.equal(gitText(worktree, ["diff", "HEAD", "--", path]), "");
  assert.notEqual(gitText(worktree, ["diff", "--cached", "HEAD", "--", path]), "");
}
test("r1 必修1：索引越界 B、工作区恢复 A，交付仍拒绝且不改索引/HEAD", async (t) => {
  const f = fixture(t), task = await f.prepare(), before = head(task.worktree);
  hiddenIndexChange(task.worktree, "outside.txt", "staged outside B\n");
  const index = gitText(task.worktree, ["write-tree"]);
  assert.deepEqual(changes(task.worktree), ["outside.txt"]);
  assert.throws(() => deliver(task.dir), /scope 外文件：[\s\S]*outside.txt/);
  assert.equal(head(task.worktree), before);
  assert.equal(gitText(task.worktree, ["write-tree"]), index);
  assert.equal(statusOf(task.dir).loop.delivery, null);
});
for (const delivered of [false, true]) test("r1 必修1：隐藏索引改动在停下时不能漏检，已交付=" + delivered, async (t) => {
  const f = fixture(t), task = await f.prepare();
  if (delivered) deliver(task.dir);
  hiddenIndexChange(task.worktree, "src/app.txt", "hidden staged B\n");
  const result = await settle(task.dir, "停下");
  assert.equal(result.continue, true);
  assert.match(result.reason, delivered ? /交付后又改了/ : /尚未交付/);
  assert.equal(statusOf(task.dir).loop.testReturns + statusOf(task.dir).loop.reviewReturns, 0);
  assert.equal(existsSync(join(task.dir, "order")), false);
});

/** 模拟 Terminal 接收成功并执行原样包装脚本；没有真实窗口，也不运行真实 pi。 */
function fakeTerminal(env: NodeJS.ProcessEnv, cwd: string) {
  let accepted = false;
  const children: { child: ChildProcess; pid: ReturnType<typeof identity>; closed: Promise<unknown> }[] = [];
  return {
    async openTerminal(script: string) {
      const child = spawn("sh", [script], {cwd, env, detached: true, stdio: "ignore"});
      const closed = once(child, "close");
      children.push({child, pid: identity(child.pid!), closed}); accepted = true;
    },
    get accepted() { return accepted; },
    async close() { for (const c of children) { signalProcess(c.pid, true); await c.closed; } },
  };
}
for (const missing of ["pi", "permission"]) test("r1 必修2：Terminal 接收成功，但 " + missing + " 缺失后状态 failed 并保留原文", async (t) => {
  const f = fixture(t), task = await f.prepare(), permission = join(f.base, "permission.ts");
  write(permission, "// fixture only\n");
  const env = {...f.env, LOOP_LAUNCH_CMD: undefined, PI_BIN: missing === "pi" ? join(f.base, "missing-pi") : NODE,
    PERMISSION_EXTENSION: missing === "permission" ? join(f.base, "missing-permission.ts") : permission};
  const terminal = fakeTerminal(env, f.repo);
  try {
    await assert.rejects(launchMain(task.dir, false, {env, openTerminal: terminal.openTerminal}), /pi-dev: 找不到 pi 或权限扩展/);
    assert.equal(terminal.accepted, true);
    const s = statusOf(task.dir);
    assert.equal(s.state, "failed"); assert.equal(s.loop.launcher, null); assert.equal(s.loop.session, null);
    assert.ok(s.error?.category); assert.match(s.error!.raw, /pi-dev: 找不到 pi 或权限扩展/);
    const log = s.evidence.find(path => /launch-.*\.log$/.test(path))!;
    assert.match(readFileSync(log, "utf8"), /pi-dev: 找不到 pi 或权限扩展/);
  } finally { await terminal.close(); }
});
test("r1 必修2：确认本次真实进程登记后才结束启动监测", async (t) => {
  const f = fixture(t), task = await f.prepare(), pi = join(f.base, "fake-pi.cjs"), permission = join(f.base, "permission.ts");
  write(permission, "// fixture only\n");
  write(pi, "#!" + NODE + "\n(async()=>{const fs=require('fs');const {registerSession}=await import(" +
    JSON.stringify(join(ROOT, "src/core/lifecycle.ts")) + ");const dir=process.env.LOOP_TASK_DIR;registerSession(dir,'pi','registered-pi',process.pid);" +
    "const watcher=fs.watch(dir,()=>{if(fs.existsSync(dir+'/finish-pi')){watcher.close();process.exit(0);}});})();\n");
  execFileSync("chmod", ["+x", pi]);
  const env = {...f.env, LOOP_LAUNCH_CMD: undefined, PI_BIN: pi, PERMISSION_EXTENSION: permission};
  const terminal = fakeTerminal(env, f.repo);
  try {
    await launchMain(task.dir, false, {env, openTerminal: terminal.openTerminal});
    const s = statusOf(task.dir);
    assert.equal(s.state, "working"); assert.equal(s.loop.session?.id, "registered-pi");
    assert.notEqual(s.loop.session?.pid, process.pid); assert.equal(s.loop.launcher, null);
    assert.equal(s.timeLimitSec, null); assert.match(s.message, /会话已登记/);
  } finally { write(join(task.dir, "finish-pi"), "done"); await terminal.close(); }
});
test("r1 必修2：旧会话身份不能代替本次登记；未启动有期限地报失败", async (t) => {
  const f = fixture(t), task = await f.prepare();
  registerSession(task.dir, "pi", "old-session", process.pid);
  await assert.rejects(launchMain(task.dir, false, {openTerminal: async () => {}, startupTimeoutMs: 25}), /启动超时/);
  assert.equal(statusOf(task.dir).state, "failed"); assert.equal(statusOf(task.dir).loop.launcher, null);
});
test("r1 必修2：延迟到超时后执行的终端包装器不再打开 pi", async (t) => {
  const f = fixture(t), task = await f.prepare(), id = "expired";
  write(join(task.dir, "launch-" + id + ".json"), JSON.stringify({args: [], deadline: Date.now() - 1}));
  assert.equal(await terminalSession(task.dir, id), 1);
  assert.match(getJson(join(task.dir, "launch-" + id + "-exit.json")).raw, /过期/);
  assert.equal(existsSync(join(task.dir, "launch-" + id + "-pid.json")), false);
});

for (const host of ["claude", "codex"]) test("r1 必修3：" + host + " 超出 hook 总预算启动前拒绝，合法覆盖仍支持", async (t) => {
  const f = fixture(t, {card: {host, limits: {开发评审: {timeoutMin: 120}}}});
  await assert.rejects(f.cli(["启动", f.card, "--json"]), (e: any) => {
    assert.match(e.stderr, /"category":"不支持"/); assert.match(e.stderr, /Stop hook 外层时限为 4900 秒/);
    assert.match(e.stderr, /降低两项 timeoutMin[\s\S]*或改用 pi/); return true;
  });
  assert.deepEqual(readdirSync(f.root), []);
  f.raw.limits = {测试: {timeoutMin: 10}, 开发评审: {timeoutMin: 70}};
  write(f.card, JSON.stringify(f.raw)); const card = readCard(f.card).card;
  assert.equal((card.limits.测试.timeoutMin + card.limits.开发评审.timeoutMin) * 60 + HOOK_OVERHEAD_SEC, HOOK_TIMEOUT_SEC);
  f.raw.limits.开发评审.timeoutMin = 71; write(f.card, JSON.stringify(f.raw));
  assert.throws(() => readCard(f.card), /不支持此配置/);
});
for (const host of ["claude", "codex"]) test("W1 r2 必修2：合法 " + host + " 卡的隔离准备与复测共用预算", async t => {
  const f = fixture(t,{card:{host},config:{setup:"node gate.cjs setup"},test:"node gate.cjs test"});
  write(join(f.repo,"gate.cjs"), `
const fs=require('fs'), p=process.env.LOOP_TASK_DIR, stage=process.argv[2];
if (!fs.existsSync(p+'/gate-on')) process.exit(0);
const ready=()=>{if(fs.existsSync(p+'/'+stage+'-go'))w.close();};
const w=fs.watch(p,ready);fs.writeFileSync(p+'/'+stage+'-started','');ready();
`);
  f.git("add","gate.cjs"); f.git("commit","-m","time-controlled setup and test");
  const task = await f.prepare(), {commit} = deliver(task.dir);
  const now = Date.now(), limits = task.limits;
  assert.equal((limits.测试.timeoutMin + limits.开发评审.timeoutMin) * 60 + HOOK_OVERHEAD_SEC, HOOK_TIMEOUT_SEC);
  t.mock.timers.enable({apis:["Date","setTimeout"], now});
  write(join(task.dir,"gate-on"),"");
  const active = handleHook({cwd:task.worktree,last_assistant_message:"已经交付"},"Stop",{...f.env,LOOP_TASK_DIR:task.dir,LOOP_HOST:host});
  await until(task.dir,()=>existsSync(join(task.dir,"setup-started")),Boolean);
  t.mock.timers.tick(5 * 60000); write(join(task.dir,"setup-go"),"");
  await until(task.dir,()=>existsSync(join(task.dir,"test-started")),Boolean);
  t.mock.timers.tick(15 * 60000); write(join(task.dir,"test-go"),"");
  const response = await active, test = checksOf(task.dir).findLast(c=>c.step==="复测");
  t.diagnostic(JSON.stringify({host,commit,elapsedMs:Date.now()-now, test:test?.result, review:statusOf(task.dir).loop.reviewRounds, response:response.slice(0,240)}));
  assert.equal(test?.commit,commit); assert.equal(test?.result,"失败"); assert.match(response,/复测失败.*超时/);
  assert.equal(statusOf(task.dir).loop.reviewRounds,0);
  assert.ok(Date.now()-now < HOOK_TIMEOUT_SEC * 1000);
});
test("r1 必修3：pi 不受固定 Stop hook 时限约束，120 分钟覆盖保持可用", (t) => {
  const f = fixture(t, {card: {host: "pi", limits: {开发评审: {timeoutMin: 120}}}});
  assert.equal(readCard(f.card).card.limits.开发评审.timeoutMin, 120);
});
