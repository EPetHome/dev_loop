import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fixture, write, until, getJson, ROOT, NODE } from "./helpers.ts";
import { statusOf, waitFor, transition, fail } from "../src/core/store.ts";
import { heartbeat, stop } from "../src/core/lifecycle.ts";
import { alive, type Identity } from "../src/infra/exec.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";

/** 替身通过文件时钟兑现 -t 租约；SIGTERM 或超时都记录释放，不依赖真实等待。 */
function inhibitor(t: Parameters<typeof fixture>[0], f: ReturnType<typeof fixture>) {
  const clock = join(f.base, "clock.json"), log = join(f.base, "assertions.jsonl"), cmd = join(f.base, "fake-caffeinate.cjs"), previous = process.env.LOOP_CAFFEINATE_CMD;
  write(clock, JSON.stringify(Date.now()));
  write(cmd, "#!" + NODE + "\n" +
    'const fs=require("fs"),clock=' + JSON.stringify(clock) + ',log=' + JSON.stringify(log) + ';' +
    'const now=()=>JSON.parse(fs.readFileSync(clock,"utf8")),args=process.argv.slice(2),start=now(),expires=start+Number(args[args.indexOf("-t")+1])*1000;' +
    'const emit=event=>fs.appendFileSync(log,JSON.stringify({event,pid:process.pid,task:process.env.LOOP_TASK_DIR,args,at:now()})+"\\n");' +
    'let done=false;const end=()=>{if(done)return;done=true;emit("off");process.exit(0);};' +
    'process.on("SIGTERM",end);fs.watch(clock,()=>{if(now()>=expires)end();});setTimeout(end,Number(args[args.indexOf("-t")+1])*1000);emit("on");\n');
  execFileSync("chmod", ["+x", cmd]); process.env.LOOP_CAFFEINATE_CMD = f.env.LOOP_CAFFEINATE_CMD = cmd;
  t.after(() => { process.env.LOOP_CAFFEINATE_CMD = previous; });
  const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return {clock, events, async event(event: string, pid: number) { return until(f.base, events, es => es.some(e => e.event === event && e.pid === pid)); }};
}
test("A7：working租约随注入时钟/心跳续期，等你立即放开；另一个working任务不受影响", async t => {
  const f = fixture(t), driver = inhibitor(t, f);
  t.mock.timers.enable({apis: ["Date"], now: Date.now()});
  const first = await f.prepare(), lease = () => getJson<Identity>(join(first.dir, "idle-sleep.json"));
  const old = lease(); await driver.event("on", old.pid); assert.equal(alive(old), true);
  assert.deepEqual(driver.events()[0].args, ["-i", "-t", "120"]);
  const seq = statusOf(first.dir).seq; t.mock.timers.tick(60000); write(driver.clock, JSON.stringify(Date.now())); heartbeat(first.dir);
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
  t.mock.timers.enable({apis: ["Date"], now}); t.mock.timers.tick(120000); write(driver.clock, JSON.stringify(Date.now()));
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
  t.mock.timers.tick(60000); write(driver.clock, JSON.stringify(Date.now()));
  const renewed = getJson<Identity>(join(task.dir, "idle-sleep.json")); assert.notEqual(renewed.pid, original.pid); await driver.event("on", renewed.pid);
  stop(task.dir); await active; await driver.event("off", renewed.pid);
});
test("防睡命令不可用只记原始错误，不成为新拒绝点", async t => {
  const f = fixture(t), previous = process.env.LOOP_CAFFEINATE_CMD;
  process.env.LOOP_CAFFEINATE_CMD = join(f.base, "missing-command"); t.after(() => { process.env.LOOP_CAFFEINATE_CMD = previous; });
  const task = await f.prepare(); assert.equal(statusOf(task.dir).state, "working");
  await until(task.dir, () => readFileSync(join(task.dir, "idle-sleep.log"), "utf8"), text => text.includes("ENOENT"));
  stop(task.dir);
});
