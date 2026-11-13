import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fixture, write, sq, PASS, MUST, until } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { resume, registerSession } from "../src/core/lifecycle.ts";
import { statusOf, checksOf, update, inputs, appendCheck } from "../src/core/store.ts";
import { gitText } from "../src/infra/git.ts";
import { launchMain } from "../src/hosts/launch.ts";

async function failed(t: Parameters<typeof fixture>[0], options: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(t, {reviewer: 'if [ ! -e "$LOOP_TASK_DIR/retry-go" ]; then echo "Bad Request original" >&2; exit 7; fi; printf %s ' + sq(PASS), ...options});
  const task = await f.prepare(); write(join(task.worktree, "src/app.txt"), "good delivered\n"); deliver(task.dir); await settle(task.dir);
  assert.equal(statusOf(task.dir).state, "failed"); return {...f, task};
}
test("A3/A4：临时失败记事实；续跑立即回执，后台只评审，不开会话不复测", async t => {
  const hold = 'node hold-review.cjs; printf %s ' + sq(PASS);
  const f = fixture(t, {reviewer: 'if [ ! -e "$LOOP_TASK_DIR/retry-go" ]; then echo "Bad Request original" >&2; exit 7; fi; ' + hold});
  write(join(f.repo, "hold-review.cjs"), 'const fs=require("fs"),p=process.env.LOOP_TASK_DIR;fs.writeFileSync(p+"/retry-started","");const done=()=>{if(fs.existsSync(p+"/review-release"))w.close();};const w=fs.watch(p,done);done();');
  f.git("add", "hold-review.cjs"); f.git("commit", "-m", "controlled review");
  const task = await f.prepare(); deliver(task.dir); await settle(task.dir);
  let s = statusOf(task.dir); assert.equal(s.state, "failed"); assert.equal(s.error?.category, "临时故障");
  assert.equal(s.loop.reviewReturns, 0); assert.equal(s.loop.reviewRounds, 1);
  assert.equal(s.loop.facts!.stops[0].step, "评审中"); assert.equal(s.loop.facts!.stops[0].reason, "临时故障"); assert.match(s.loop.facts!.stops[0].message, /Bad Request original/);
  const before = checksOf(task.dir).filter(c => c.step === "复测");
  registerSession(task.dir, "pi", "original-session"); write(join(task.dir, "retry-go"), "");
  const receipt = JSON.parse((await f.cli(["续跑", task.executionId, "--json"])).stdout);
  assert.equal(receipt.reviewOnly, true); assert.equal(receipt.status.state, "working");
  await until(task.dir, () => existsSync(join(task.dir, "retry-started")), Boolean);
  assert.equal(statusOf(task.dir).state, "working"); assert.equal(existsSync(join(task.dir, "opened.json")), false);
  assert.deepEqual(checksOf(task.dir).filter(c => c.step === "复测"), before);
  write(join(task.dir, "review-release"), "");
  s = await until(task.dir, () => statusOf(task.dir), s => s.state === "completed" && !s.loop.launcher);
  assert.equal(s.loop.phase, "完成"); assert.equal(s.loop.reviewRounds, 2); assert.equal(s.loop.reviewReturns, 0);
  assert.equal(s.loop.facts!.resumes, 1); assert.equal(s.loop.facts!.stops[0].resolvedBy, "续跑"); assert.ok(s.loop.facts!.stops[0].resumedAt);
  assert.equal(readFileSync(join(task.dir, "order"), "utf8"), "test\nreview\nreview\nreview\n");
  assert.equal(existsSync(join(task.dir, "opened.json")), false);
  assert.deepEqual(checksOf(task.dir).filter(c => c.step === "复测"), before);
  assert.match(readFileSync(join(task.dir, "review-input-r2.md"), "utf8"), /结果：通过/);
});
test("复测没验证且日志已丢也可只补评审，通过后照常收尾", async t => {
  const f = await failed(t, {test: "无：文档无可运行检查", card: {flow: ["开发评审", "测试", "合入"]}}), {task} = f;
  rmSync(join(task.dir, "test-" + statusOf(task.dir).loop.commit + ".log")); write(join(task.dir, "retry-go"), "");
  const receipt = JSON.parse((await f.cli(["续跑", task.executionId, "--json"])).stdout); assert.equal(receipt.reviewOnly, true);
  const s = await until(task.dir, () => statusOf(task.dir), s => s.state === "completed" && !s.loop.finisher && !s.loop.launcher);
  assert.equal(s.loop.phase, "已合入"); assert.equal(checksOf(task.dir).filter(c => c.step === "复测").length, 1);
  assert.equal(existsSync(join(task.dir, "opened.json")), false);
  assert.match(readFileSync(join(task.dir, "review-input-r2.md"), "utf8"), /结果：没验证[\s\S]*复测原文缺失/);
});
for (const change of ["未提交", "HEAD", "提示词", "验收标准", "失败类别", "最后检查", "复测记录", "失败记录哈希"]) test("A5 / 回退条件：" + change + "变化仍按原逻辑回开发", async t => {
  const f = await failed(t), {task} = f;
  if (change === "未提交") write(join(task.worktree, "src/app.txt"), "good dirty\n");
  if (change === "HEAD") gitText(task.worktree, ["commit", "--allow-empty", "-m", "new HEAD same tree"]);
  if (change === "提示词") write(join(f.repo, "prompt.md"), "新提示词");
  if (change === "验收标准") write(join(f.repo, "criteria.md"), "新验收标准");
  if (change === "失败类别") update(task.dir, s => { s.error!.category = "工具内部错误"; });
  if (change === "最后检查") { const last = checksOf(task.dir).findLast(c => c.step === "评审")!; appendCheck(task.dir, {...last, result: "必修"}); }
  if (change === "复测记录") {
    const lines = checksOf(task.dir).filter(c => c.step !== "复测"); write(join(task.dir, "checks.jsonl"), lines.map(c => JSON.stringify(c)).join("\n") + "\n");
  }
  if (change === "失败记录哈希") { const last = checksOf(task.dir).findLast(c => c.step === "评审")!; appendCheck(task.dir, {...last, promptHash: inputs(task).promptHash + "old"}); }
  const result = JSON.parse((await f.cli(["续跑", task.executionId, "--json"])).stdout);
  assert.notEqual(result.reviewOnly, true); assert.equal(result.status.loop.phase, "开发中");
  await until(task.dir, () => existsSync(join(task.dir, "opened.json")), Boolean);
  await until(task.dir, () => statusOf(task.dir), s => !s.loop.launcher);
  assert.equal(statusOf(task.dir).loop.reviewRounds, 1);
});
for (const live of [false, true]) test("补评审给出必修后照常返修，原会话存活=" + live, async t => {
  const f = await failed(t, {reviewer: 'if [ ! -e "$LOOP_TASK_DIR/retry-go" ]; then exit 7; fi; printf %s ' + sq(MUST)}), {task} = f;
  if (live) registerSession(task.dir, "pi", "original-session");
  write(join(task.dir, "retry-go"), ""); await f.cli(["续跑", task.executionId, "--json"]);
  const s = await until(task.dir, () => statusOf(task.dir), s => s.loop.phase === "开发中" && !s.loop.launcher);
  assert.equal(s.loop.reviewReturns, 1); assert.match(s.loop.pendingReturn!, /评审必修/);
  assert.equal(checksOf(task.dir).filter(c => c.step === "复测").length, 1);
  if (live) assert.equal(existsSync(join(task.dir, "opened.json")), false);
  else await until(task.dir, () => existsSync(join(task.dir, "opened.json")), Boolean);
});
test("回执后提示词再变化，后台重核资格回开发，不补评审也不复测", async t => {
  const f = await failed(t), {task} = f;
  assert.equal(resume(task.dir).reviewOnly, true); write(join(f.repo, "prompt.md"), "后台启动前需求又变化");
  await launchMain(task.dir, false, {env: f.env, reviewOnly: true});
  assert.equal(statusOf(task.dir).loop.phase, "开发中"); assert.ok(existsSync(join(task.dir, "opened.json")));
  assert.equal(checksOf(task.dir).filter(c => c.step === "复测").length, 1); assert.equal(statusOf(task.dir).loop.reviewRounds, 1);
});
test("补评审的必修仍遵守原退回上限", async t => {
  const f = await failed(t, {reviewer: 'if [ ! -e "$LOOP_TASK_DIR/retry-go" ]; then exit 7; fi; printf %s ' + sq(MUST), card: {limits: {开发评审: {maxRepairs: 1, timeoutMin: 1}}}}), {task} = f;
  write(join(task.dir, "retry-go"), ""); await f.cli(["续跑", task.executionId, "--json"]);
  const s = await until(task.dir, () => statusOf(task.dir), s => s.state === "input_required" && !s.loop.launcher);
  assert.equal(s.loop.wait, "评审必修到上限"); assert.equal(s.loop.reviewReturns, 1); assert.equal(existsSync(join(task.dir, "opened.json")), false);
  assert.equal(s.loop.facts!.stops.at(-1)!.reason, "评审必修到上限");
});
test("再次临时失败不扣退回次数，下一次还能只补评审", async t => {
  const f = await failed(t), {task} = f;
  await f.cli(["续跑", task.executionId, "--json"]);
  const s = await until(task.dir, () => statusOf(task.dir), s => s.state === "failed" && !s.loop.launcher);
  assert.equal(s.loop.reviewReturns, 0); assert.equal(s.loop.facts!.stops.length, 2); assert.equal(s.loop.facts!.resumes, 1);
  assert.equal(resume(task.dir).reviewOnly, true); assert.equal(statusOf(task.dir).loop.facts!.resumes, 2);
});
