import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, until, getJson, hook, hostProcess, ROOT } from "./helpers.ts";
import { registerPi } from "../src/hosts/pi.ts";
import { launchSession } from "../src/hosts/launch.ts";
import { resume } from "../src/core/lifecycle.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { statusOf, answersOf, waitFor, update, inputs, appendCheck, checked, type Task } from "../src/core/store.ts";

function piWindow(task: Task, ending: Record<string, unknown> = {}) {
  const events: Record<string, any> = {}, callbacks: (() => void)[] = [], sent: {message: any; options: any}[] = [];
  const file = join(task.dir, "session with 空格.jsonl");
  write(file, [{type: "message", message: {role: "assistant", content: [], stopReason: "error", errorMessage: "older error"}},
    {type: "message", message: {role: "assistant", content: [{type: "text", text: "需要你决定"}], ...ending}}].map(e => JSON.stringify(e)).join("\n"));
  const ctx = {cwd: task.worktree, hasUI: false, sessionManager: {getSessionId: () => "original-pi", getSessionFile: () => file,
    getBranch: () => readFileSync(file, "utf8").split("\n").map(line => JSON.parse(line))}};
  registerPi({on: (event, handler) => { events[event] = handler; }, sendMessage: (message, options) => { sent.push({message, options}); }},
    {env: {LOOP_TASK_DIR: task.dir}, every: cb => { callbacks.push(cb); return {unref() {}}; }, clear() {}});
  events.session_start({}, ctx);
  return {events, ctx, file, sent, refresh: () => callbacks[1](), returns: () => sent.filter(s => s.message.customType === "dev-loop-return"), close: () => events.session_shutdown()};
}
const receipt = async (f: ReturnType<typeof fixture>, args: string[]) => JSON.parse((await f.cli([...args, "--json"])).stdout);

test("续跑 A1/A6：活着的 Pi 从停下没交付/模型出错续跑，原文送一次并开新轮", async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task);
  for (const reason of ["停下没交付", "模型出错"] as const) {
    waitFor(task.dir, reason, "等待决定");
    const text = "  原话『不改字』\r\n第二行🙂\n  ";
    const before = p.returns().length, r = await receipt(f, ["续跑", task.executionId, "--话", text]);
    assert.equal(r.running, true); assert.equal(r.status.state, "working"); assert.equal(r.status.loop.phase, "开发中");
    assert.equal(statusOf(task.dir).loop.pendingReturn, text);
    p.refresh(); p.refresh();
    assert.equal(p.returns().length, before + 1); assert.equal(p.returns().at(-1)!.message.content, text);
    assert.deepEqual(p.returns().at(-1)!.options, {triggerTurn: true}); assert.equal(statusOf(task.dir).loop.pendingReturn, null);
    assert.equal(statusOf(task.dir).loop.wait, null);
  }
  assert.equal(existsSync(join(task.dir, "opened.json")), false); p.close();
});

for (const command of ["续跑", "答复"]) test(command + " A2：退出后恢复精确 session 文件，text-file 原话只放开场，不再重复注入", async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task);
  waitFor(task.dir, "停下没交付", "等你"); p.close();
  const text = "\n  保留这句\r\n以及尾部空格  \n", file = join(f.base, "续跑原话.txt"); write(file, text);
  const expected = command === "答复" ? "本人答复：" + text : text;
  const r = await receipt(f, [command, task.executionId, "--text-file", file]); assert.equal(r.running, false);
  const opened = await until(task.dir, () => getJson(join(task.dir, "opened.json")), Boolean);
  await until(task.dir, () => statusOf(task.dir), s => !s.loop.launcher);
  assert.equal(opened.args[opened.args.indexOf("--session") + 1], p.file);
  assert.equal(opened.args.includes("--session-id"), false);
  const prompt = readFileSync(opened.args.at(-1), "utf8"); assert.ok(prompt.endsWith(expected)); assert.equal(prompt.split(expected).length, 2);
  assert.equal(statusOf(task.dir).loop.pendingReturn, expected);
  assert.deepEqual(answersOf(task.dir).map(a => a.text), command === "答复" ? [text] : []);
  const restored = piWindow(task); restored.refresh(); restored.refresh();
  assert.equal(restored.returns().length, 0, "开场提示已有原话，不再次 sendMessage");
  assert.equal(statusOf(task.dir).loop.pendingReturn, null); restored.close();
});

test("续跑 A3：不带话保留原状态、留言与回执，不写待送", async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task);
  waitFor(task.dir, "停下没交付", "等你");
  const r = await receipt(f, ["续跑", task.executionId]);
  assert.deepEqual(Object.keys(r).sort(), ["executionId", "reused", "running", "status"]);
  assert.equal(r.running, true); assert.equal(r.reused, false); assert.equal(r.status.state, "working"); assert.equal(r.status.loop.phase, "开发中");
  assert.equal(r.status.message, "已续跑，请在原开发会话继续；到上限的步骤再给一轮");
  assert.equal(r.status.loop.pendingReturn, null); p.refresh(); assert.equal(p.returns().length, 0); p.close();
  waitFor(task.dir, "停下没交付", "等你");
  assert.equal(resume(task.dir).status.message, "已续跑；到上限的步骤再给一轮");
});

for (const stopReason of ["error", "stop", undefined]) test("模型 A4/A5：从构造的 Pi 会话记录读取最后结束原因 " + stopReason, async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task, {...(stopReason ? {stopReason} : {}), errorMessage: "fetch failed\n原始错误详情"});
  assert.equal(await p.events.agent_before_settle({}, p.ctx), undefined);
  const s = statusOf(task.dir), reason = stopReason === "error" ? "模型出错" : "停下没交付";
  assert.equal(s.state, "input_required"); assert.equal(s.loop.wait, reason); assert.equal(s.loop.facts!.stops.at(-1)!.reason, reason);
  if (stopReason === "error") { assert.match(s.message, /fetch failed\n原始错误详情/); assert.doesNotMatch(s.message, /停下没交付/); }
  else assert.equal(s.message, "需要你决定");
  assert.equal(p.returns().length, 0); assert.equal(existsSync(join(task.dir, "order")), false); p.close();
});

test("模型：event.context 结束原因同样传入，尚未交付提醒仍先催一次", async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task, {stopReason: "stop"});
  write(join(task.worktree, "src/app.txt"), "good unsubmitted\n");
  const event = {context: {contextMessages: [{role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed"}]}};
  const first = await p.events.agent_before_settle(event, p.ctx);
  assert.equal(first.continue, true); assert.match(first.entries[0].content, /尚未交付/); assert.equal(statusOf(task.dir).state, "working");
  await p.events.agent_before_settle(event, p.ctx);
  assert.equal(statusOf(task.dir).loop.wait, "停下没交付"); assert.match(statusOf(task.dir).message, /fetch failed/); p.close();
});

test("答复 A7：两次只追加带时间记录，送原文；公开计数、评审材料和输入哈希", async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task), original = inputs(task);
  for (const step of ["复测", "评审"]) appendCheck(task.dir, {commit: task.baseCommit, tree: "", step, result: "通过", startedAt: task.createdAt,
    endedAt: task.createdAt, durationMs: 0, evidence: [], promptHash: original.promptHash, acceptanceHash: original.acceptanceHash});
  const texts = ["  本人定：用乙，不用甲\n保留换行🙂  ", "--第二次：按原话\r\n不要改字\n"], path = join(task.dir, "answers.jsonl");
  let prefix = "";
  for (const [i, text] of texts.entries()) {
    waitFor(task.dir, "停下没交付", "请本人决定");
    const file = join(f.base, "答复.txt"); write(file, text);
    await receipt(f, ["答复", task.executionId, ...(i ? ["--text-file", file] : ["--话", text])]);
    assert.equal(statusOf(task.dir).loop.pendingReturn, "本人答复：" + text); p.refresh(); p.refresh();
    assert.equal(p.returns().at(-1)!.message.content, "本人答复：" + text); assert.equal(p.returns().at(-1)!.options.triggerTurn, true);
    const raw = readFileSync(path, "utf8"); assert.ok(raw.startsWith(prefix)); prefix = raw;
    assert.equal(raw.trimEnd().split("\n").length, i + 1);
    const queried = await receipt(f, ["查询", "--all", "--brief"]); assert.equal(queried.executions[0].loop.answerCount, i + 1);
    assert.deepEqual(inputs(task), original); assert.equal(checked(task.dir, task.baseCommit), true, "答复不作废已有结论");
  }
  const answers = answersOf(task.dir); assert.deepEqual(answers.map(a => a.text), texts);
  for (const a of answers) assert.equal(new Date(a.at).toISOString(), a.at);
  assert.ok(answers[0].at <= answers[1].at); assert.equal(p.returns().length, 2);
  write(join(task.worktree, "src/app.txt"), "good answered\n"); deliver(task.dir, "按答复实现"); await settle(task.dir);
  const material = readFileSync(join(task.dir, "review-input-r1.md"), "utf8");
  assert.ok(material.includes("## 本人答复\n\n" + answers.map(a => a.at + "\n" + a.text).join("\n\n")));
  assert.match(readFileSync(join(ROOT, "src/core/review-prompt.md"), "utf8"), /和提示词冲突时按答复判/);
  assert.equal(readFileSync(path, "utf8"), prefix); p.close();
});

test("带话仍能交接到已检查的任务；不作废记录，无改动再交付照常沿用", async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task); deliver(task.dir); await settle(task.dir);
  waitFor(task.dir, "停下没交付", "请本人决定");
  const r = await receipt(f, ["答复", task.executionId, "--话", "保持原实现"]);
  assert.equal(r.status.loop.phase, "开发中"); p.refresh(); assert.equal(p.returns().at(-1)!.message.content, "本人答复：保持原实现");
  assert.equal(checked(task.dir, task.baseCommit), true);
  const before = readFileSync(join(task.dir, "order"), "utf8"); assert.equal(deliver(task.dir).reused, true); await settle(task.dir);
  assert.equal(statusOf(task.dir).state, "completed"); assert.equal(readFileSync(join(task.dir, "order"), "utf8"), before); p.close();
});

test("答复 A8：非等你状态拒收并说明阶段，不写记录或改变状态", async t => {
  const f = fixture(t), task = await f.prepare(), p = piWindow(task);
  waitFor(task.dir, "停下没交付", "等你"); await receipt(f, ["答复", task.executionId, "--话", "已有答复"]); p.refresh();
  const before = readFileSync(join(task.dir, "answers.jsonl"), "utf8");
  for (const [state, phase] of [["working", "开发中"], ["working", "收尾中"], ["completed", "完成"], ["cancelled", "已停止"], ["cancelled", "已放弃"], ["failed", "失败"]] as const) {
    update(task.dir, s => { s.state = state; s.loop.phase = phase; });
    const status = readFileSync(join(task.dir, "status.json"), "utf8");
    await assert.rejects(f.cli(["答复", task.executionId, "--话", "不得记录", "--json"]), (e: any) => {
      const raw = JSON.parse(e.stderr).error.raw; assert.ok(raw.includes("答复只在「等你」时接收")); assert.ok(raw.includes(phase)); return true;
    });
    assert.equal(readFileSync(join(task.dir, "answers.jsonl"), "utf8"), before); assert.equal(readFileSync(join(task.dir, "status.json"), "utf8"), status);
  }
  p.close();
});

for (const host of ["claude", "codex"]) test("续跑/答复 A9：" + host + "回执未送达，下一次真实 hook 交接一次", async t => {
  const f = fixture(t, {card: {host}}), task = await f.prepare(), worker = await hostProcess(t);
  const event = {cwd: task.worktree, host, session_id: "original-" + host, session_pid: worker.owner.pid};
  await hook(f, task.dir, "SessionStart", event);
  for (const command of ["续跑", "答复"]) {
    waitFor(task.dir, "停下没交付", "等待本人"); const text = "  原话\r\n不改字  ";
    const expected = command === "答复" ? "本人答复：" + text : text, r = await receipt(f, [command, task.executionId, "--话", text]);
    assert.equal(r.running, true); assert.equal(r.status.loop.pendingReturn, expected);
    assert.match(r.status.message, /未送达，需在窗口里说/); assert.doesNotMatch(r.status.message, /已送达/);
    const queried = await receipt(f, ["查询", task.executionId, "--brief"]); assert.match(queried.executions[0].message, /未送达/);
    const received = JSON.parse((await hook(f, task.dir, "Stop", event)).stdout);
    assert.equal(received.decision, "block"); assert.equal(received.reason, expected);
    assert.equal(statusOf(task.dir).loop.pendingReturn, null); assert.equal((await hook(f, task.dir, "PostToolUse", event)).stdout, "");
  }
  assert.equal(answersOf(task.dir).length, 1); assert.equal(statusOf(task.dir).loop.answerCount, 1);
  waitFor(task.dir, "停下没交付", "退出后"); await worker.exit();
  resume(task.dir, "退出后仍待 hook");
  await launchSession(task.dir, true, {env: {...f.env, LOOP_LAUNCH_CMD: undefined}});
  assert.equal(statusOf(task.dir).loop.wait, "需手动接入会话"); assert.match(statusOf(task.dir).message, /未送达，需在窗口里说/);
  assert.equal(statusOf(task.dir).loop.pendingReturn, "退出后仍待 hook");
});

for (const host of ["claude", "codex"]) for (const eventName of ["SessionStart", "PostToolUse", "Stop"]) test("r1 必修1：" + host + "退出后连续答复，由下一次 " + eventName + " hook 按序原文交接一次", async t => {
  const f = fixture(t, {card: {host}}), task = await f.prepare(), worker = await hostProcess(t);
  const event = {cwd: task.worktree, host, session_id: "exited-" + host, session_pid: worker.owner.pid};
  await hook(f, task.dir, "SessionStart", event); await worker.exit();
  waitFor(task.dir, "停下没交付", "等待本人答复");
  const texts = ["  答复 A：保留前后空格\r\n和换行🙂  ", "\n答复 B：仍按原话\n"], path = join(task.dir, "answers.jsonl");
  let prefix = "";
  for (const [i, text] of texts.entries()) {
    const file = join(f.base, "答复原话.txt"); write(file, text);
    const r = JSON.parse((await f.cli(["答复", task.executionId, ...(i ? ["--text-file", file] : ["--话", text]), "--json"], f.repo, {LOOP_LAUNCH_CMD: undefined})).stdout);
    assert.equal(r.running, false); assert.match(r.status.message, /未送达，需在窗口里说/);
    const s = await until(task.dir, () => statusOf(task.dir), s => s.state === "input_required" && s.loop.wait === "需手动接入会话" && !s.loop.launcher);
    assert.match(s.message, /未送达，需在窗口里说/); assert.equal(s.loop.answerCount, i + 1);
    const raw = readFileSync(path, "utf8"); assert.ok(raw.startsWith(prefix)); prefix = raw;
  }
  assert.deepEqual(answersOf(task.dir).map(a => a.text), texts);
  const expected = texts.map(text => "本人答复：" + text).join("\n\n");
  // 下一次 hook 前不模拟开发，不手工消费待送；走真实 hook CLI 的 block/context 输出。
  const received = JSON.parse((await hook(f, task.dir, eventName, {...event, session_pid: process.pid})).stdout);
  const reason = eventName === "Stop" ? received.reason : received.hookSpecificOutput.additionalContext;
  if (eventName === "Stop") assert.equal(received.decision, "block");
  if (eventName === "SessionStart") assert.ok(reason.endsWith(expected)); else assert.equal(reason, expected);
  for (const text of texts) assert.equal(reason.split("本人答复：" + text).length - 1, 1);
  assert.equal(statusOf(task.dir).loop.pendingReturn, null); assert.equal(statusOf(task.dir).state, "working");
  assert.equal((await hook(f, task.dir, "PostToolUse", event)).stdout, "", "后续 hook 不重复交接");
  assert.equal(readFileSync(path, "utf8"), prefix);
});

test("续跑/答复 A10：空话及空白文件拒收，状态和答复记录不变；旧状态公开计数为零", async t => {
  const f = fixture(t), task = await f.prepare(); waitFor(task.dir, "停下没交付", "等你");
  const path = join(task.dir, "status.json"), old = getJson(path); delete old.loop.answerCount; write(path, JSON.stringify(old));
  const before = readFileSync(path, "utf8"), query = await receipt(f, ["查询", "--all", "--brief"]);
  assert.equal(query.executions[0].loop.answerCount, 0); assert.equal(readFileSync(path, "utf8"), before);
  for (const command of ["续跑", "答复"]) for (const text of ["", " \r\n\t"]) {
    const file = join(f.base, "empty.txt"); write(file, text);
    for (const flags of [["--话", text], ["--text-file", file]]) {
      await assert.rejects(f.cli([command, task.executionId, ...flags, "--json"]), (e: any) => {
        const error = JSON.parse(e.stderr).error; assert.equal(error.category, "输入问题"); assert.match(error.raw, /话不能为空/); return true;
      });
      assert.equal(readFileSync(path, "utf8"), before); assert.equal(existsSync(join(task.dir, "answers.jsonl")), false);
    }
  }
  await assert.rejects(f.cli(["答复", task.executionId, "--json"])); assert.equal(readFileSync(path, "utf8"), before);
});
