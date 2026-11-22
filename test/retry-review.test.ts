import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fixture, write, writeFixtureScript, sq, PASS, MUST, until, NODE, ROOT } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { resume, registerSession } from "../src/core/lifecycle.ts";
import { statusOf, checksOf, update, inputs, appendCheck } from "../src/core/store.ts";
import { gitText } from "../src/infra/git.ts";
import { launchMain } from "../src/hosts/launch.ts";
import { lock } from "../src/infra/files.ts";
import { operationPath } from "../src/core/run.ts";

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
test("W1 r2 必修1：只补评审沿用同次复测生成的覆盖率报告", async t => {
  const f = fixture(t, {test: 'echo test >> "$LOOP_TASK_DIR/order"; mkdir -p dist; cp src/app.txt dist/coverage.json',
    config: {setup: 'echo setup >> "$LOOP_TASK_DIR/setup-count"'}, reviewer: `
    if ! grep -q 'report from B' dist/coverage.json; then echo '原复测报告缺失' >&2; exit 8; fi
    pwd > "$LOOP_TASK_DIR/review-worktree"
    if [ ! -e "$LOOP_TASK_DIR/retry-go" ]; then echo '临时断连' >&2; exit 7; fi
    printf %s ${sq(PASS)}`});
  const task = await f.prepare(); write(join(task.worktree,"src/app.txt"), "report from B\n");
  const {commit} = deliver(task.dir); await settle(task.dir);
  const failed = statusOf(task.dir), before = checksOf(task.dir).filter(c => c.step === "复测");
  const cwd = readFileSync(join(task.dir,"review-worktree"), "utf8").trim();
  assert.equal(failed.error?.category,"临时故障"); assert.match(failed.error.raw,/临时断连/); assert.notEqual(cwd,task.worktree);
  // 开发工作区以内的忽略产物也不能冒充原复测报告。
  write(join(task.worktree,"dist/coverage.json"),"report from C\n"); write(join(task.dir,"retry-go"),"");
  const receipt = JSON.parse((await f.cli(["续跑",task.executionId,"--json"])).stdout);
  const s = await until(task.dir, () => statusOf(task.dir), s => !s.loop.launcher && s.state !== "working");
  const order = readFileSync(join(task.dir,"order"),"utf8"), setups = readFileSync(join(task.dir,"setup-count"),"utf8");
  t.diagnostic(JSON.stringify({commit, initial:failed.state, retry:receipt.reviewOnly, final:s.state, error:s.error, order, setups}));
  assert.equal(receipt.reviewOnly,true); assert.equal(s.state,"completed");
  assert.equal(readFileSync(join(task.dir,"review-worktree"),"utf8").trim(),cwd);
  assert.equal(order,"test\nreview\nreview\nreview\n"); assert.equal(setups,"setup\nsetup\n");
  assert.deepEqual(checksOf(task.dir).filter(c => c.step === "复测"),before);
  assert.equal(readFileSync(join(task.worktree,"dist/coverage.json"),"utf8"),"report from C\n");
  assert.equal(existsSync(cwd),false);
});
const oldOverflow = "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.";
for (const [name, raw, overflow] of [
  ["Codex", oldOverflow, true],
  ["Gemini", "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)", true],
  ["限流", "429 rate_limit_exceeded: Rate limit reached for tokens per minute (TPM)", false],
  ["临时断连", "连接暂时中断，稍后再试", false],
] as const) test("W1 A17 / 问题单 A3：只读本次 Pi 评审结束原因 · " + name, async t => {
  const f = fixture(t, {config: {reviewerCmd: ""}}), task = await f.prepare(), bin = join(f.base, "fake-review-pi.cjs");
  writeFixtureScript(bin,"node",`
const fs = require("fs"), path = require("path"), t = process.env.LOOP_TASK_DIR;
const arg = name => process.argv[process.argv.indexOf(name)+1];
const id = arg("--session-id"), dir = process.argv.includes("--session-dir") ? arg("--session-dir") : path.join(t,"legacy-review-sessions");
const err = errorMessage => ({type:"message",message:{role:"assistant",stopReason:"error",errorMessage}});
const oldOverflow = ${JSON.stringify(oldOverflow)}, raw = ${JSON.stringify(raw)};
const log = (filename, id, ...lines) => fs.writeFileSync(path.join(dir,filename), [{type:"session",id}, ...lines].map(x=>JSON.stringify(x)).join("\\n")+"\\n");
fs.mkdirSync(dir,{recursive:true});
log("other-review.jsonl", "another-attempt", err(oldOverflow));
log("2026-test_"+id+".jsonl", id, err(oldOverflow), err(raw));
fs.appendFileSync(path.join(t,"order"), "review\\n");
console.log("评审未生成报告");
`);
  const old = process.env.PI_BIN;
  try { process.env.PI_BIN = bin; deliver(task.dir); await settle(task.dir); await settle(task.dir); }
  finally { if (old === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = old; }
  const {error} = JSON.parse((await f.cli(["查询", task.executionId, "--json"])).stdout).executions[0];
  const s = statusOf(task.dir), review = checksOf(task.dir).findLast(c => c.step === "评审")!;
  const order = readFileSync(join(task.dir, "order"), "utf8");
  const files = review.evidence.map(path => ({path, bytes: readFileSync(path).byteLength}));
  t.diagnostic(JSON.stringify({commit: review.commit, phase: s.loop.phase, error, order, evidence: files, materialBytes: readFileSync(join(task.dir, "review-input-r1.md")).byteLength}));
  assert.equal(s.state, "failed");
  assert.equal(review.result, "失败");
  assert.equal(s.loop.reviewReturns, 0);
  if (overflow) {
    assert.equal(error.category, "评审上下文超限");
    assert.equal(error.raw, raw);
    assert.equal(review.detail, raw);
    assert.equal(readFileSync(review.evidence[0], "utf8").includes(raw), false);
    assert.ok(review.evidence.slice(1).some(path => readFileSync(path, "utf8").includes(raw)));
    assert.equal(order, "test\nreview\n");
  } else {
    assert.equal(error.category, "临时故障");
    assert.match(error.raw, /缺少「## 必修」标题/);
    assert.equal(order, "test\nreview\nreview\n");
  }
});
test("评审必修：Stop 先持执行锁，当前补评审等锁后只执行一次", async t => {
  const f = await failed(t), {dir} = f.task, {reviewRequest} = resume(dir).status.loop;
  assert.ok(reviewRequest); write(join(dir,"retry-go"),"");
  const held = join(dir,"stop-holds-lock"), gate = join(f.base,"stop-gate"); execFileSync("mkfifo",[gate]);
  const stopCode = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const [path,held,gate] = process.argv.slice(1), link = fs.linkSync;
fs.linkSync = (pending,destination) => {
  link(pending,destination);
  if (destination === path) { fs.writeFileSync(held,''); fs.readFileSync(gate); }
};
syncBuiltinESMExports();
const {handleHook} = await import(${JSON.stringify(join(ROOT,"src/hosts/hook.ts"))});
if (await handleHook({},'Stop')) process.exitCode=71;`;
  const stop = spawn(NODE,["--input-type=module","-e",stopCode,operationPath(dir),held,gate],{cwd:f.repo,env:{...f.env,LOOP_TASK_DIR:dir},stdio:"inherit"});
  const closed = once(stop,"close"); let released = false;
  const releaseStop = () => { if (!released) { released=true; write(gate,"continue"); } };
  try {
    await until(dir,() => existsSync(held),Boolean);
    assert.equal(JSON.parse(readFileSync(operationPath(dir),"utf8")).pid,stop.pid);
    const wait = Atomics.wait, gateWait = t.mock.method(Atomics,"wait",(...args: Parameters<typeof wait>) => {
      if (!released) { assert.equal(statusOf(dir).loop.launcher?.pid,process.pid); releaseStop(); }
      return wait(...args);
    });
    try { await launchMain(dir,false,{env:f.env,reviewRequest}); } finally { gateWait.mock.restore(); releaseStop(); }
  } finally { if (!released) stop.kill("SIGKILL"); }
  assert.deepEqual(await closed,[0,null]);
  assert.equal(statusOf(dir).state,"completed"); assert.equal(statusOf(dir).loop.reviewRounds,2);
  assert.equal(readFileSync(join(dir,"order"),"utf8"),"test\nreview\nreview\nreview\n");
  assert.equal(existsSync(join(dir,"opened.json")),false);
});

test("评审必修：补评审等待锁超时，无 launcher 时续跑沿用原请求", async t => {
  const f = await failed(t), {dir,executionId} = f.task, {reviewRequest} = resume(dir).status.loop; assert.ok(reviewRequest);
  const release = lock(operationPath(dir)); let now = Date.now();
  const clock = t.mock.method(Date,"now",() => now+=3000); // 只推进等待预算，不等真实时限。
  try { await launchMain(dir,false,{env:f.env,reviewRequest}); } finally { clock.mock.restore(); release(); }
  const pending = statusOf(dir);
  assert.equal(pending.loop.phase,"评审中"); assert.equal(pending.loop.launcher,null); assert.equal(pending.loop.reviewRequest,reviewRequest);
  write(join(dir,"retry-go"),"");
  const receipt = JSON.parse((await f.cli(["续跑",executionId,"--json"])).stdout);
  assert.equal(receipt.reviewOnly,true); assert.equal(receipt.status.loop.reviewRequest,reviewRequest);
  await until(dir,() => statusOf(dir),s => s.state === "completed" && !s.loop.launcher);
  assert.equal(readFileSync(join(dir,"order"),"utf8"),"test\nreview\nreview\nreview\n");
  assert.equal(existsSync(join(dir,"opened.json")),false);
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
  const request = resume(task.dir); assert.equal(request.reviewOnly,true); assert.ok(request.status.loop.reviewRequest);
  write(join(f.repo,"prompt.md"),"后台启动前需求又变化");
  await launchMain(task.dir,false,{env:f.env,reviewRequest:request.status.loop.reviewRequest});
  assert.equal(statusOf(task.dir).loop.phase, "开发中"); assert.ok(existsSync(join(task.dir, "opened.json")));
  assert.equal(checksOf(task.dir).filter(c => c.step === "复测").length, 1); assert.equal(statusOf(task.dir).loop.reviewRounds, 1);
});
test("同为评审中，旧补评审请求也不能代替新请求", async t => {
  const f = await failed(t), {dir} = f.task, a = resume(dir).status.loop.reviewRequest; assert.ok(a);
  await launchMain(dir,false,{env:f.env,reviewRequest:a}); assert.equal(statusOf(dir).state,"failed");
  const b = resume(dir).status; assert.equal(b.loop.phase,"评审中");
  assert.ok(b.loop.reviewRequest); assert.notEqual(b.loop.reviewRequest,a);
  const checks = checksOf(dir); await launchMain(dir,false,{env:f.env,reviewRequest:a});
  assert.deepEqual(statusOf(dir),b); assert.deepEqual(checksOf(dir),checks);
  write(join(dir,"retry-go"),""); await launchMain(dir,false,{env:f.env,reviewRequest:b.loop.reviewRequest});
  assert.equal(statusOf(dir).state,"completed"); assert.equal(checksOf(dir).filter(c => c.step === "复测").length,1);
  assert.equal(existsSync(join(dir,"opened.json")),false);
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
