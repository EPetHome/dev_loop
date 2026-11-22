import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fixture, write, writeFixtureScript, until, getJson, ROOT, NODE, hook, hostProcess } from "./helpers.ts";
import { statusOf, waitFor, transition, fail } from "../src/core/store.ts";
import { heartbeat, stop } from "../src/core/lifecycle.ts";
import { alive, type Identity } from "../src/infra/exec.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { writeJson } from "../src/infra/files.ts";

/** 替身通过文件时钟兑现 -t 租约；SIGTERM 或超时都记录释放，不依赖真实等待。 */
function inhibitor(t: Parameters<typeof fixture>[0], f: ReturnType<typeof fixture>) {
  const clock = join(f.base, "clock.json"), log = join(f.base, "assertions.jsonl"), cmd = join(f.base, "fake-caffeinate.cjs"), previous = process.env.LOOP_CAFFEINATE_CMD;
  writeJson(clock, Date.now());
  writeFixtureScript(cmd,"node",
    'const fs=require("fs"),cp=require("child_process"),clock=' + JSON.stringify(clock) + ',log=' + JSON.stringify(log) + ';' +
    'const now=()=>JSON.parse(fs.readFileSync(clock,"utf8")),args=process.argv.slice(2),start=now(),seconds=args.includes("-t")?Number(args[args.indexOf("-t")+1]):Infinity,owner=args.includes("-w")?args[args.indexOf("-w")+1]:"",expires=start+seconds*1000;' +
    'const emit=event=>fs.appendFileSync(log,JSON.stringify({event,pid:process.pid,task:process.env.LOOP_TASK_DIR,args,at:now()})+"\\n");' +
    'let done=false;const end=()=>{if(done)return;done=true;emit("off");process.exit(0);};' +
    'process.on("SIGTERM",end);fs.watchFile(clock,{interval:50},()=>{const p=owner?cp.spawnSync("ps",["-p",owner,"-o","stat="],{encoding:"utf8"}):null;if(now()>=expires||(p&&(p.status!==0||p.stdout.trim().startsWith("Z"))))end();else emit("checked");});if(Number.isFinite(seconds))setTimeout(end,seconds*1000);emit("on");\n');
  process.env.LOOP_CAFFEINATE_CMD = f.env.LOOP_CAFFEINATE_CMD = cmd;
  t.after(() => { process.env.LOOP_CAFFEINATE_CMD = previous; });
  const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return {clock, log, events, async event(event: string, pid: number) { return until(f.base, events, es => es.some(e => e.event === event && e.pid === pid), log); }};
}
test("A7：working租约随注入时钟/心跳续期，等你立即放开；另一个working任务不受影响", async t => {
  const f = fixture(t), driver = inhibitor(t, f);
  t.mock.timers.enable({apis: ["Date"], now: Date.now()});
  const first = await f.prepare(), lease = () => getJson<Identity>(join(first.dir, "idle-sleep.json"));
  const old = lease(); await driver.event("on", old.pid); assert.equal(alive(old), true);
  assert.deepEqual(driver.events()[0].args, ["-i", "-t", "120"]);
  const seq = statusOf(first.dir).seq; t.mock.timers.tick(60000); writeJson(driver.clock, Date.now()); heartbeat(first.dir);
  const renewed = lease(); assert.notEqual(renewed.pid, old.pid); await driver.event("on", renewed.pid); await driver.event("off", old.pid);
  assert.equal(statusOf(first.dir).seq, seq + 1); assert.equal(alive(renewed), true);
  const second = await f.prepare(), other = getJson<Identity>(join(second.dir, "idle-sleep.json")); await driver.event("on", other.pid);
  waitFor(first.dir, "停下没交付", "需要确认"); await driver.event("off", renewed.pid);
  assert.equal(existsSync(join(first.dir, "idle-sleep.json")), false); assert.equal(alive(other), true);
  const count = driver.events().filter(e => e.event === "on").length; t.mock.timers.tick(180000); heartbeat(first.dir);
  assert.equal(driver.events().filter(e => e.event === "on").length, count);
  fail(second.dir, "temporary", "临时故障"); await driver.event("off", other.pid);
});
for (const state of ["completed", "failed", "cancelled"] as const) test("离开working自动释放替身：" + state, async t => {
  const f = fixture(t), driver = inhibitor(t, f), task = await f.prepare(), lease = getJson<Identity>(join(task.dir, "idle-sleep.json"));
  await driver.event("on", lease.pid);
  if (state === "completed") transition(task.dir, "completed", "完成", "done", null);
  if (state === "failed") fail(task.dir, "error", "临时故障");
  if (state === "cancelled") stop(task.dir);
  await driver.event("off", lease.pid); assert.equal(existsSync(join(task.dir, "idle-sleep.json")), false);
});
test("干活进程退出后心跳消失，120秒租约自行失效，没有清理命令或常驻监控", async t => {
  const f = fixture(t), driver = inhibitor(t, f), now = Date.now();
  const code = 'const {createTask}=await import(' + JSON.stringify(join(ROOT, "src/core/store.ts")) + ');console.log(createTask(process.argv[1],process.argv[2]).dir);';
  const dir = execFileSync(NODE, ["--input-type=module", "-e", code, f.card, f.root], {env: f.env, encoding: "utf8"}).trim();
  const lease = getJson<Identity>(join(dir, "idle-sleep.json")); await driver.event("on", lease.pid);
  t.mock.timers.enable({apis: ["Date"], now}); t.mock.timers.tick(120000); writeJson(driver.clock, Date.now());
  await driver.event("off", lease.pid); assert.equal(statusOf(dir).state, "working");
  assert.equal(driver.events().filter(e => e.event === "on").length, 1);
});
test("无宿主定时器的复测/评审推进也会每60秒续期", async t => {
  const f = fixture(t, {test: "node held.cjs"}), driver = inhibitor(t, f);
  write(join(f.repo, "held.cjs"), 'const fs=require("fs"),dir=process.env.LOOP_TASK_DIR;fs.writeFileSync(dir+"/test-started","");fs.watch(dir,()=>{});');
  f.git("add", "held.cjs"); f.git("commit", "-m", "held test");
  const task = await f.prepare(); deliver(task.dir);
  const original = getJson<Identity>(join(task.dir, "idle-sleep.json")); await driver.event("on", original.pid);
  t.mock.timers.enable({apis: ["Date", "setInterval"], now: Date.now()});
  const active = settle(task.dir); await until(task.dir, () => existsSync(join(task.dir, "test-started")), Boolean);
  t.mock.timers.tick(60000); writeJson(driver.clock, Date.now());
  const renewed = getJson<Identity>(join(task.dir, "idle-sleep.json")); assert.notEqual(renewed.pid, original.pid); await driver.event("on", renewed.pid);
  stop(task.dir); await active; await driver.event("off", renewed.pid);
});
for (const host of ["claude", "codex"]) test("r1必修1：" + host + "真实hook登记后无事件超过120秒仍防睡，等你后释放", async t => {
  const f = fixture(t, {card: {host}}), driver = inhibitor(t, f), task = await f.prepare(), worker = await hostProcess(t);
  await hook(f, task.dir, "SessionStart", {cwd: task.worktree, host, session_pid: worker.owner.pid, session_id: host + "-long-call"});
  const bound = getJson<Identity & {owner: Identity}>(join(task.dir, "idle-sleep.json")); await driver.event("on", bound.pid);
  assert.deepEqual(driver.events().find(e => e.event === "on" && e.pid === bound.pid).args, ["-i", "-w", String(worker.owner.pid)]);
  assert.equal(bound.owner.pid, worker.owner.pid); const seq = statusOf(task.dir).seq;
  t.mock.timers.enable({apis: ["Date"], now: Date.now()}); t.mock.timers.tick(121000); writeJson(driver.clock, Date.now());
  await until(f.base, driver.events, events => events.some(e => e.pid === bound.pid && e.at === Date.now() && ["checked", "off"].includes(e.event)),driver.log);
  assert.equal(alive(bound), true); assert.equal(driver.events().some(e => e.pid === bound.pid && e.event === "off"), false);
  assert.equal(statusOf(task.dir).state, "working"); assert.equal(statusOf(task.dir).seq, seq, "没有工具事件或心跳来续期");
  await hook(f, task.dir, "Stop", {cwd: task.worktree, last_assistant_message: "需要确认，暂不交付"});
  await driver.event("off", bound.pid); assert.equal(statusOf(task.dir).state, "input_required"); assert.equal(alive(worker.owner), true);
});
for (const host of ["claude", "codex"]) test("r1必修1：" + host + "宿主退出后进程绑定断言自行释放", async t => {
  const f = fixture(t, {card: {host}}), driver = inhibitor(t, f), task = await f.prepare(), worker = await hostProcess(t);
  await hook(f, task.dir, "SessionStart", {cwd: task.worktree, host, session_pid: worker.owner.pid});
  const lease = getJson<Identity>(join(task.dir, "idle-sleep.json")); await driver.event("on", lease.pid);
  await worker.exit(); writeJson(driver.clock, Date.now()); await driver.event("off", lease.pid);
  assert.equal(statusOf(task.dir).state, "working", "退出释放不依赖新状态更新或人工清理");
});
test("防睡命令不可用只记原始错误，不成为新拒绝点", t => {
  const f = fixture(t), env = {...f.env, LOOP_CAFFEINATE_CMD: join(f.base, "missing-command")};
  const script = 'const {createTask}=await import(' + JSON.stringify(join(ROOT, "src/core/store.ts")) + ');' +
    'const {prepare}=await import(' + JSON.stringify(join(ROOT, "src/core/lifecycle.ts")) + ');' +
    'const {dir}=createTask(process.argv[1],process.argv[2]);await prepare(dir);console.log(dir);';
  // 等进程退出，spawn 的 error 事件已处理；不依赖新建日志的 FS watch 通知。
  const dir = execFileSync(NODE, ["--input-type=module", "-e", script, f.card, f.root], {env, encoding: "utf8", timeout: 12000}).trim();
  assert.equal(statusOf(dir).state, "working");
  assert.match(readFileSync(join(dir, "idle-sleep.log"), "utf8"), /ENOENT/);
  stop(dir);
});
