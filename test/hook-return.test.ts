import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fixture, write, hook, hostProcess, sq, MUST, PASS, until } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { statusOf, checksOf } from "../src/core/store.ts";
import { alive } from "../src/infra/exec.ts";

async function pending(t: Parameters<typeof fixture>[0], host: string) {
  const f = fixture(t, {card: {host}, reviewer:
    'if [ ! -e "$LOOP_TASK_DIR/retry-go" ]; then echo "Bad Request original" >&2; exit 7; fi; if [ -e "$LOOP_TASK_DIR/repaired" ]; then printf %s ' + sq(PASS) + '; else printf %s ' + sq(MUST) + '; fi'});
  const task = await f.prepare(), worker = await hostProcess(t);
  const event = {cwd: task.worktree, host, session_id: "original-" + host, session_pid: worker.owner.pid};
  await hook(f, task.dir, "SessionStart", event);
  write(join(task.worktree, "src/app.txt"), "good delivered\n"); deliver(task.dir);
  assert.equal((await hook(f, task.dir, "Stop", event)).stdout, "");
  assert.equal(statusOf(task.dir).state, "failed"); assert.equal(statusOf(task.dir).error?.category, "临时故障");
  const tests = checksOf(task.dir).filter(c => c.step === "复测");
  write(join(task.dir, "retry-go"), "");
  const receipt = JSON.parse((await f.cli(["续跑", task.executionId, "--json"])).stdout);
  assert.equal(receipt.reviewOnly, true);
  const s = await until(task.dir, () => statusOf(task.dir), s => s.state === "input_required" && !!s.loop.pendingReturn && !s.loop.launcher);
  assert.equal(s.loop.wait, "需手动接入会话"); assert.match(s.message, /尚未送达/);
  assert.equal(s.loop.reviewReturns, 1); assert.equal(s.loop.facts!.resumes, 1); assert.equal(alive(worker.owner), true);
  assert.equal(existsSync(join(task.dir, "opened.json")), false, "补评审没有开开发会话");
  assert.deepEqual(checksOf(task.dir).filter(c => c.step === "复测"), tests, "补评审没有复测");
  return {...f, task, event, tests};
}
for (const host of ["claude", "codex"]) for (const eventName of ["Stop", "PostToolUse", "SessionStart"]) test("r1必修2：" + host + "后台必修经真实" + eventName + " hook交接，修复后正常交付", async t => {
  const f = await pending(t, host), {task} = f;
  const received = JSON.parse((await hook(f, task.dir, eventName, f.event)).stdout);
  const reason = eventName === "Stop" ? received.reason : received.hookSpecificOutput.additionalContext;
  if (eventName === "Stop") assert.equal(received.decision, "block");
  else assert.equal(received.hookSpecificOutput.hookEventName, eventName);
  assert.match(reason, /评审必修：[\s\S]*src\/app.txt:1[\s\S]*触发：输入 bad 时/);
  let s = statusOf(task.dir); assert.equal(s.state, "working"); assert.equal(s.loop.phase, "开发中");
  assert.equal(s.loop.pendingReturn, null); assert.equal(s.loop.wait, null); assert.equal(s.loop.facts!.resumes, 1);
  assert.equal(s.loop.reviewRounds, 2); assert.deepEqual(checksOf(task.dir).filter(c => c.step === "复测"), f.tests);
  assert.equal((await hook(f, task.dir, "PostToolUse", f.event)).stdout, "", "返修交接只消费一次");
  // 模拟宿主收到 block/context 后按原路径修复并交付，再由同一个 Stop 入口推进。
  write(join(task.worktree, "src/app.txt"), "good repaired\n"); write(join(task.dir, "repaired"), ""); deliver(task.dir);
  assert.equal((await hook(f, task.dir, "Stop", f.event)).stdout, "");
  s = statusOf(task.dir); assert.equal(s.state, "completed"); assert.equal(s.loop.phase, "完成");
  assert.equal(checksOf(task.dir).filter(c => c.step === "复测").length, 2); assert.equal(s.loop.reviewReturns, 1);
  assert.equal(readFileSync(join(task.dir, "order"), "utf8"), "test\nreview\nreview\nreview\ntest\nreview\n");
});
test("r1必修2：未交接前被停止，迟到hook不消费返修、不恢复working", async t => {
  const f = await pending(t, "claude"), before = checksOf(f.task.dir).length;
  await f.cli(["停止", f.task.executionId, "--json"]);
  assert.equal((await hook(f, f.task.dir, "Stop", f.event)).stdout, "");
  assert.equal(statusOf(f.task.dir).state, "cancelled"); assert.ok(statusOf(f.task.dir).loop.pendingReturn);
  assert.equal(checksOf(f.task.dir).length, before);
});
