import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture, write, sq, MUST } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { resume, stop, registerSession } from "../src/core/lifecycle.ts";
import { statusOf, waitFor, fail, transition } from "../src/core/store.ts";
import { merge } from "../src/steps/merge.ts";
import { reviewed } from "./step-helpers.ts";
import { finish } from "../src/cli/finish.ts";

test("A1/A2：简要公开查询直接带任务名、开始时间、续跑次数和永久停下事实", async t => {
  const f = fixture(t, {reviewer: "printf %s " + sq(MUST), card: {limits: {开发评审: {maxRepairs: 1, timeoutMin: 1}}}}), task = await f.prepare();
  deliver(task.dir); await settle(task.dir);
  const before = statusOf(task.dir), stop = before.loop.facts!.stops[0];
  assert.equal(before.loop.facts!.name, task.name); assert.equal(before.loop.facts!.startedAt, task.createdAt);
  assert.equal(before.loop.facts!.resumes, 0);
  assert.equal(stop.step, "评审中"); assert.equal(stop.state, "input_required"); assert.equal(stop.reason, "评审必修到上限");
  assert.ok(Date.parse(stop.at)); assert.equal(stop.resumedAt, null); assert.equal(stop.resolvedBy, null);
  assert.equal(stop.message, [...before.message].slice(0, 200).join(""));
  resume(task.dir);
  const query = JSON.parse((await f.cli(["查询", "--all", "--brief", "--json"])).stdout), s = query.executions[0];
  assert.equal(s.loop.facts.resumes, 1); assert.equal(s.loop.wait, null);
  assert.equal(s.loop.facts.stops[0].reason, stop.reason); assert.ok(Date.parse(s.loop.facts.stops[0].resumedAt));
  assert.equal(s.loop.facts.stops[0].resolvedBy, "续跑");
  assert.deepEqual(s.loop.facts, statusOf(task.dir).loop.facts);
});
test("A6：停止、续跑、放弃及已停记录去重，旧未解开记录先关闭", async t => {
  const f = fixture(t), task = await f.prepare();
  waitFor(task.dir, "停下没交付", "需要确认"); stop(task.dir); stop(task.dir);
  let facts = statusOf(task.dir).loop.facts!;
  assert.equal(facts.stops.length, 2); assert.equal(facts.stops[0].resolvedBy, "停止"); assert.ok(facts.stops[0].resumedAt);
  assert.equal(facts.stops[1].step, "等你"); assert.equal(facts.stops[1].state, "cancelled"); assert.equal(facts.stops[1].reason, "已停止");
  resume(task.dir); facts = statusOf(task.dir).loop.facts!;
  assert.equal(facts.resumes, 1); assert.equal(facts.stops[1].resolvedBy, "续跑"); assert.ok(facts.stops[1].resumedAt);
  stop(task.dir); stop(task.dir, true); facts = statusOf(task.dir).loop.facts!;
  assert.equal(facts.stops.at(-2)!.resolvedBy, "放弃"); assert.equal(facts.stops.at(-1)!.reason, "已放弃");
  assert.throws(() => resume(task.dir), /已放弃/); assert.equal(statusOf(task.dir).loop.facts!.resumes, 1);
});
test("失败原话最多200字，保留最近50条；失败前阶段不是失败阶段", async t => {
  const f = fixture(t), task = await f.prepare();
  transition(task.dir, "working", "复测中", "test", "testMs");
  fail(task.dir, "错🙂".repeat(120), "临时故障");
  let s = statusOf(task.dir);
  assert.equal(s.loop.facts!.stops[0].reason, "临时故障"); assert.equal(s.loop.facts!.stops[0].step, "复测中");
  assert.equal([...s.loop.facts!.stops[0].message].length, 200);
  for (let i = 0; i < 51; i++) { resume(task.dir); waitFor(task.dir, "停下没交付", String(i)); }
  s = statusOf(task.dir); assert.equal(s.loop.facts!.stops.length, 50); assert.equal(s.loop.facts!.stops[0].message, "1");
  assert.equal(s.loop.facts!.stops.at(-1)!.message, "50"); assert.equal(s.loop.facts!.resumes, 51);
});
test("A9：无 facts 的旧文件只读查询不改写，续跑后补齐，不虚构历史", async t => {
  const f = fixture(t), task = await f.prepare();
  waitFor(task.dir, "停下没交付", "旧执行");
  const old = statusOf(task.dir); delete old.loop.facts; write(join(task.dir, "status.json"), JSON.stringify(old));
  const result = JSON.parse((await f.cli(["查询", "--all", "--brief", "--json"])).stdout);
  assert.equal(result.executions[0].loop.facts, undefined); assert.equal(statusOf(task.dir).loop.facts, undefined);
  resume(task.dir); const facts = statusOf(task.dir).loop.facts!;
  assert.equal(facts.name, task.name); assert.equal(facts.startedAt, task.createdAt); assert.equal(facts.resumes, 1); assert.deepEqual(facts.stops, []);
});
test("沿用通过记录关闭停下事实；成功续跑才计数", async t => {
  const f = fixture(t), task = await f.prepare(), {commit} = deliver(task.dir);
  reviewed(task, commit); stop(task.dir);
  assert.equal(resume(task.dir).reused, true);
  const s = statusOf(task.dir); assert.equal(s.loop.facts!.resumes, 1); assert.equal(s.loop.facts!.stops[0].resolvedBy, "沿用通过记录");
  write(join(task.worktree, "src/app.txt"), "good new change\n"); registerSession(task.dir, "pi", "running");
  assert.throws(() => resume(task.dir), /开发会话仍在运行/); assert.equal(statusOf(task.dir).loop.facts!.resumes, 1);
});
test("接受未验证合入 / 手工收尾关闭事实，但不计为续跑", async t => {
  const f = fixture(t), task = await f.prepare();
  write(join(task.worktree, "src/app.txt"), "good delivered\n"); deliver(task.dir);
  waitFor(task.dir, "评审必修到上限", "缺检查");
  merge(task.dir, {acceptUnverified: true});
  let facts = statusOf(task.dir).loop.facts!;
  assert.equal(facts.stops[0].resolvedBy, "合入（接受未验证）"); assert.ok(facts.stops[0].resumedAt); assert.equal(facts.resumes, 0);
  const g = fixture(t, {card: {flow: ["开发评审", "测试", "合入"]}}), other = await g.prepare(), d = deliver(other.dir);
  reviewed(other, d.commit); waitFor(other.dir, "收尾没走完", "手动接手"); await finish(other.dir);
  facts = statusOf(other.dir).loop.facts!; assert.equal(facts.stops[0].resolvedBy, "收尾"); assert.ok(facts.stops[0].resumedAt); assert.equal(facts.resumes, 0);
});
