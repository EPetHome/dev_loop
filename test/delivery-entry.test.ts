import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, until } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { registerSession, resume, shutdownSession } from "../src/core/lifecycle.ts";
import { checksOf, statusOf, waitFor, type Task } from "../src/core/store.ts";
import { changes, gitText, head } from "../src/infra/git.ts";

function commit(task: Task, path: string, text: string) {
  write(join(task.worktree, path), text);
  gitText(task.worktree, ["add", "--", path]);
  gitText(task.worktree, ["commit", "-m", text]);
  return head(task.worktree);
}
const stop = async (task: Task) => {
  const result = await settle(task.dir), s = statusOf(task.dir);
  return {...result, phase: s.loop.phase, wait: s.loop.wait, delivery: s.loop.delivery?.commit};
};
const coreChecks = (task: Task) => checksOf(task.dir).filter(c => ["开发", "复测", "评审"].includes(c.step)).map(({step, result, commit}) => ({step, result, commit}));
const query = async (f: ReturnType<typeof fixture>, task: Task) => JSON.parse((await f.cli(["查询", task.executionId, "--brief", "--json"])).stdout).executions[0];
const confirmation = (task: Task, sha: string) => ["续跑", task.executionId, "--交付提交", sha, "--json"];
const errorRaw = async (p: Promise<unknown>) => {
  let raw = "";
  await assert.rejects(p, (e: any) => { raw = JSON.parse(e.stderr).error.raw; return true; });
  return raw;
};

test("W1 A15 / 问题单 A2：返修只提交未登记，不沿用 A，不反复催 B", async t => {
  const f = fixture(t), task = await f.prepare();
  const A = deliver(task.dir).commit;
  await settle(task.dir);
  const B = commit(task, "src/app.txt", "good B\n"), before = coreChecks(task), stops = [];
  for (let i = 0; i < 3; i++) stops.push(await stop(task));
  const during = coreChecks(task);
  if (statusOf(task.dir).state === "input_required") resume(task.dir);
  const receipt = deliver(task.dir); await settle(task.dir);
  const after = coreChecks(task).slice(during.length);
  t.diagnostic(JSON.stringify({A, B, stops, before, during, receipt, after, end: statusOf(task.dir).loop.phase}));
  assert.match(stops[0].reason, /bin\/loop 交付/);
  assert.ok(stops[0].reason.includes(A) && stops[0].reason.includes(B), "首次提醒要同时列出 A、B");
  assert.deepEqual(stops.map(s => [s.continue, s.phase, s.wait]), [[true, "开发中", null], [false, "等你", "停下没交付"], [false, "等你", "停下没交付"]]);
  assert.ok(stops.every(s => s.delivery === A));
  assert.deepEqual(during, before);
  assert.equal(receipt.commit, B);
  assert.deepEqual(after, ["开发", "复测", "评审"].map(step => ({step, result: step === "开发" ? "已交付" : "通过", commit: B})));
  assert.equal(statusOf(task.dir).state, "completed");
});

test("W1 A15：仅未提交文件，同 SHA 同文件清单只提醒一次；换清单可再提示", async t => {
  const f = fixture(t), task = await f.prepare(), path = join(task.worktree, "src/app.txt");
  const A = deliver(task.dir).commit;
  write(path, "good dirty\n");
  const first = await stop(task);
  write(path, "good still dirty (same path)\n");
  const second = await stop(task), view = await query(f, task);
  if (view.state === "input_required") resume(task.dir);
  write(join(task.worktree, "src/added.txt"), "good new path\n");
  const third = await stop(task), fourth = await stop(task);
  if (statusOf(task.dir).state === "input_required") resume(task.dir);
  gitText(task.worktree, ["clean", "-f", "--", "src/added.txt"]);
  const fifth = await stop(task);
  t.diagnostic(JSON.stringify({A, stops: [first, second, third, fourth, fifth], option: view.loop.deliveryConfirmation ?? null}));
  assert.deepEqual([first, second, third, fourth, fifth].map(x => x.continue), [true, false, true, false, false]);
  assert.equal(second.wait, "停下没交付");
  assert.equal(view.loop.deliveryConfirmation, undefined);
  assert.equal(existsSync(join(task.dir, "order")), false);
});

test("W1 A16：确认查询给出的完整 SHA，只登记现有 B，原会话不重开、后台只派一次", async t => {
  const hold = 'const fs=require("fs"),p=process.env.LOOP_TASK_DIR; fs.appendFileSync(p+"/order","test\\n"); fs.writeFileSync(p+"/test-started",""); const check=()=>{if(fs.existsSync(p+"/test-release"))w.close();}; const w=fs.watch(p,check);check();';
  const f = fixture(t, {test: "node hold-test.cjs"});
  write(join(f.repo, "hold-test.cjs"), hold); f.git("add", "hold-test.cjs"); f.git("commit", "-m", "hold test until receipt");
  const task = await f.prepare(); registerSession(task.dir, "pi", "original-stopped");
  const B = commit(task, "src/app.txt", "good B\n"), branch = gitText(task.worktree, ["branch", "--show-current"]);
  const history = gitText(task.worktree, ["rev-list", "HEAD"]), stops = [await stop(task), await stop(task)];
  shutdownSession(task.dir);
  const ended = statusOf(task.dir).loop.session?.endedAt;
  const statePath = join(task.dir, "status.json"), before = readFileSync(statePath, "utf8"), view = await query(f, task);
  t.diagnostic(JSON.stringify({B, stops, option: view.loop.deliveryConfirmation ?? null}));
  const raw = await errorRaw(f.cli(["交付", "--json"], task.worktree));
  assert.match(raw, /任务未运行/);
  assert.equal(readFileSync(statePath, "utf8"), before);
  assert.equal(view.loop.deliveryConfirmation?.commit, B);
  assert.equal(view.loop.deliveryConfirmation.label, "用当前提交交付");
  assert.ok(view.loop.deliveryConfirmation.command.endsWith("续跑 " + task.executionId + " --交付提交 " + B));
  assert.match(await errorRaw(f.cli(confirmation(task, B.slice(0, 12)))), /完整.*SHA/);
  assert.match(await errorRaw(f.cli([...confirmation(task, B), "--话", "不应转开发"])), /不能.*同时/);
  const receipt = JSON.parse((await f.cli(confirmation(task, B))).stdout);
  assert.equal(receipt.commit, B);
  assert.equal(receipt.reused, false);
  await until(task.dir, () => existsSync(join(task.dir, "test-started")), Boolean);
  const testing = statusOf(task.dir);
  assert.equal(testing.loop.phase, "复测中");
  assert.match(await errorRaw(f.cli(confirmation(task, B))), /停下没交付|任务正在处理/);
  assert.equal(testing.loop.session?.endedAt, ended);
  write(join(task.dir, "test-release"), "go");
  const final = await until(task.dir, () => statusOf(task.dir), s => s.state === "completed" && !s.loop.launcher);
  await settle(task.dir);
  assert.match(await errorRaw(f.cli(confirmation(task, B))), /停下没交付/);
  t.diagnostic(JSON.stringify({receipt: {commit: receipt.commit, phase: receipt.status.loop.phase, reused: receipt.reused}, atTest: testing.loop.phase, end: final.loop.phase, checks: coreChecks(task)}));
  assert.equal(final.loop.delivery?.commit, B);
  assert.equal(final.loop.facts?.resumes, 1);
  assert.equal(final.loop.facts?.stops.at(-1)?.resolvedBy, "续跑");
  assert.equal(head(task.worktree), B);
  assert.equal(gitText(task.worktree, ["branch", "--show-current"]), branch);
  assert.equal(gitText(task.worktree, ["rev-list", "HEAD"]), history);
  assert.deepEqual(changes(task.worktree), []);
  assert.equal(existsSync(join(task.dir, "opened.json")), false);
  assert.equal(readFileSync(join(task.dir, "order"), "utf8"), "test\nreview\n");
  assert.deepEqual(coreChecks(task).map(c => c.commit), [B, B, B]);
});

test("W1 A16：确认 B 沿用同提交已有的正式检查，不重跑或开会话", async t => {
  const f = fixture(t), task = await f.prepare();
  const B = commit(task, "src/app.txt", "good proven B\n");
  deliver(task.dir); await settle(task.dir);
  const checked = coreChecks(task).filter(c => c.step !== "开发");
  gitText(task.worktree, ["reset", "--hard", task.baseCommit]);
  const A = deliver(task.dir).commit;
  gitText(task.worktree, ["merge", "--ff-only", B]);
  await stop(task); await stop(task);
  const view = await query(f, task);
  t.diagnostic(JSON.stringify({A, B, option: view.loop.deliveryConfirmation ?? null, checked}));
  assert.equal(view.loop.deliveryConfirmation?.commit, B);
  const receipt = JSON.parse((await f.cli(confirmation(task, B))).stdout);
  assert.equal(receipt.reused, true);
  assert.equal(statusOf(task.dir).state, "completed");
  assert.equal(statusOf(task.dir).loop.delivery?.commit, B);
  assert.deepEqual(coreChecks(task).filter(c => c.step !== "开发"), checked);
  assert.equal(existsSync(join(task.dir, "launcher.log")), false);
});

for (const change of ["HEAD", "工作区", "分支", "累计范围", "等待原因"]) test("W1 A16：确认拒绝且保留现场 · " + change, async t => {
  const f = fixture(t), task = await f.prepare(), A = deliver(task.dir).commit;
  if (change === "累计范围") commit(task, "outside.txt", "scope 外的早先提交\n");
  const B = commit(task, "src/app.txt", "good B\n"), stops = [await stop(task), await stop(task)], view = await query(f, task);
  if (change === "HEAD") gitText(task.worktree, ["commit", "--allow-empty", "-m", "C, same tree"]);
  if (change === "工作区") write(join(task.worktree, "src/untracked.txt"), "untouched\n");
  if (change === "分支") gitText(task.worktree, ["switch", "-c", "wrong-branch"]);
  if (change === "等待原因" && view.state === "input_required") waitFor(task.dir, "模型出错", "新等待原因");
  const files = () => changes(task.worktree).map(path => [path, readFileSync(join(task.worktree, path), "utf8")]);
  const scene = () => ({head: head(task.worktree), branch: gitText(task.worktree, ["branch", "--show-current"]),
    index: gitText(task.worktree, ["ls-files", "--stage"]), files: files(), status: readFileSync(join(task.dir, "status.json"), "utf8"),
    records: readFileSync(join(task.dir, "checks.jsonl"), "utf8")});
  const before = scene(), current = await query(f, task), raw = await errorRaw(f.cli(confirmation(task, B)));
  t.diagnostic(JSON.stringify({A, B, stops, seen: view.loop.deliveryConfirmation?.commit ?? null, current: current.loop.deliveryConfirmation?.commit ?? null, head: before.head, branch: before.branch, raw, finalReceipt: statusOf(task.dir).loop.delivery?.commit}));
  assert.equal(view.loop.deliveryConfirmation?.commit, B);
  const errors: Record<string, RegExp> = {HEAD: /HEAD.*变化/, 工作区: /未提交/, 分支: /任务分支/, 累计范围: /scope 外文件：[\s\S]*outside.txt/, 等待原因: /停下没交付/};
  assert.match(raw, errors[change]);
  assert.deepEqual(scene(), before);
  if (change === "HEAD") assert.equal(current.loop.deliveryConfirmation?.commit, before.head);
  if (["工作区", "分支", "等待原因"].includes(change)) assert.equal(current.loop.deliveryConfirmation, undefined);
  assert.equal(statusOf(task.dir).loop.delivery?.commit, A);
  assert.equal(existsSync(join(task.dir, "order")), false);
});
