import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registerPi } from "../src/hosts/pi.ts";
import { Ledger, locked, type Entry, type Task } from "../src/core/store.ts";
import { binding } from "../src/core/inputs.ts";
import { identity } from "../src/infra/exec.ts";
import { fixture, write, until, PASS, sq } from "./helpers.ts";

function windowView(x: Task, receiveMessages = false) {
  const start = locked(x.dir, l => l.add({type: "开始", step: "开窗口"}));
  let refresh: (() => void) | undefined, title: string | undefined, status: string | undefined;
  const messages: string[] = [];
  const ctx = {
    cwd: x.worktree, mode: "tui", hasUI: true, isIdle: () => receiveMessages,
    ui: {
      setTitle: (text: string) => { title = text; },
      setStatus: (key: string, text?: string) => { assert.equal(key, "dev-loop"); status = text; }
    },
    sessionManager: {getSessionId: () => "test-session", getSessionFile: () => undefined, getBranch: () => []},
    shutdown: () => assert.fail("窗口不应关闭")
  };
  const handlers = new Map<string, (event: unknown, context: typeof ctx) => unknown>();
  registerPi({on: (name, fn) => handlers.set(name, fn), sendMessage: (m, opts) => {
    assert(receiveMessages, "本用例只刷新标题");
    assert.equal(m.display, true);
    assert.equal(opts.triggerTurn, false, "通知不应另开模型轮次");
    messages.push(m.content);
  }}, {
    env: {LOOP_TASK_DIR: x.dir, LOOP_WINDOW_JOB: String(start.n), LOOP_PI_WINDOW_OWNER: String(process.ppid),
      LOOP_EXPECT_SESSION: "test-session", LOOP_WAKE: "manual"},
    every: ((callback: () => void) => { refresh = callback; }) as typeof setInterval
  });
  handlers.get("session_start")!({}, ctx);
  assert.ok(refresh, "Pi 应登记窗口并启动刷新");
  locked(x.dir, l => l.add({type: "开窗口", ref: start.n, result: "成功"}));
  return {
    input: (text: string, source = "interactive") => handlers.get("input")!({text, source}, ctx),
    busy: () => handlers.get("agent_start")!({}, ctx),
    abort: () => handlers.get("agent_settled")!({aborted: true}, ctx),
    refresh: () => { refresh!(); return {title, status}; }, messages
  };
}

function assertWindow(view: ReturnType<typeof windowView>, task: Task, phase: string, detail = "") {
  const {title, status} = view.refresh(), expected = `【${phase}】${task.name}${detail} · 已用 0 评审轮`;
  assert.equal(title, expected, "窗口标题");
  assert.equal(status, "dev-loop " + expected, "状态栏");
}

test("N3 A1/A2 · Pi 标题和状态栏从完成变为已合入，与查询一致", async t => {
  const f = fixture(t), x = await f.prepare(), view = windowView(x);
  const query = async () => (await f.call(["查询", x.executionId, "--brief"])).executions[0];
  write(join(x.worktree, "src/app.txt"), "done\n");
  const {commit} = await f.call(["交付"], x.worktree, {LOOP_TASK_DIR: x.dir});
  await f.call(["复测", x.executionId]);
  await f.call(["评审", x.executionId]);
  const {key, tree} = binding(new Ledger(x.dir), commit);
  locked(x.dir, l => l.add({type: "完成", sha: commit, key, boundTree: tree}));
  assert.equal((await query()).loop.phase, "完成");
  assertWindow(view, x, "完成");

  for (const [type, phase] of [["合入", "已合入"], ["部署", "已部署"]]) {
    locked(x.dir, l => l.add({type, sha: commit, key, result: "成功"}));
    assert.equal((await query()).loop.phase, phase);
    assertWindow(view, x, phase);
  }
  locked(x.dir, l => l.add({type: "释放", sha: commit, key, result: "成功", value: {released: true}}));
  const released = await query();
  assert.equal(released.loop.phase, "已部署");
  assert.equal(released.loop.released, true);
  assertWindow(view, x, "已部署", " · 已释放");
});

test("N3 · Pi 显示等你、本人中止和正在运行的工具", async t => {
  const f = fixture(t), x = await f.prepare(), view = windowView(x);
  const query = async () => (await f.call(["查询", x.executionId, "--brief"])).executions[0];
  const append = (entry: Omit<Entry, "n" | "at">) => locked(x.dir, l => l.add(entry));
  append({type: "疑问", wait: "需求疑问", text: "等确认"});
  assert.equal((await query()).loop.phase, "等你");
  assertWindow(view, x, "等你");

  append({type: "答复", text: "继续"});
  append({type: "窗口", status: "闲", ending: "aborted", aborted: true});
  const suspended = await query();
  assert.equal(suspended.state, "working");
  assert.equal(suspended.loop.phase, "开发中"); // 兼容 PA 的阶段字段。
  assert.equal(suspended.message, "本人中止，等本人说话");
  assertWindow(view, x, "本人中止");

  append({type: "窗口原话", text: "继续"});
  for (const [step, phase] of [["复测", "复测中"], ["评审", "评审中"], ["合入", "收尾中"], ["部署", "部署中"], ["释放", "收尾中"]] as const) {
    const job = append({type: "开始", step, owner: identity()});
    const running = await query();
    assert.equal(running.loop.phase, phase);
    assert.equal(running.message, `正在${step}`);
    assertWindow(view, x, phase, phase === "收尾中" ? ` · 正在${step}` : "");
    append({type: step, ref: job.n, result: "成功"});
  }
});

const quoteIntents = (l: Ledger) => l.rows.filter(r => r.type === "合入意图");
const receipt = async (f: ReturnType<typeof fixture>) => {
  const x = await f.prepare(), view = windowView(x, true);
  write(join(x.worktree, "src/app.txt"), "window merge candidate\n");
  const {commit} = await f.call(["交付"], x.worktree, {LOOP_TASK_DIR: x.dir});
  await f.call(["复测", x.executionId]);
  return {x, view, commit};
};
const complete = (f: ReturnType<typeof fixture>, x: Task) => f.pump(x.dir, l => !!l.last("完成"));
const tickTwice = async (f: ReturnType<typeof fixture>) => {
  for (let i = 0; i < 2; i++) assert.deepEqual((await f.call(["tick", "--all"])).errors, []);
};

test("N4 A1/A3 · 完成后 Pi 原话只触发一次本地合入，窗口显示合入提交", async t => {
  const f = fixture(t), remote = join(f.base, "remote.git");
  f.git("init", "--bare", remote);
  f.git("remote", "add", "origin", remote);
  f.git("push", "origin", "dev");
  const before = f.git("rev-parse", "dev"), {x, view, commit} = await receipt(f);
  const done = await complete(f, x);
  assertWindow(view, x, "完成");
  const text = " \t合入\n ";
  view.input(text);
  const quote = new Ledger(x.dir).last("窗口原话")!;
  assert.equal(quote.text, text);
  assert(quote.n > done.last("完成")!.n);
  view.busy(); // 合入不靠开发方回复或正常停下。
  const merged = await f.pump(x.dir, l => !!l.last("合入"));
  const intent = quoteIntents(merged)[0], merge = merged.last("合入")!, tip = f.git("rev-parse", "dev");
  assert.equal(intent?.ref, quote.n);
  assert.equal(intent?.text, text);
  assert.equal(intent?.sha, commit);
  assert.equal(merge.intent, intent.n);
  assert.equal(merge.result, "成功");
  assert.equal(merge.value.devAfter, tip);
  assert.equal(f.git("rev-parse", "dev^2"), commit);
  assert.equal(f.git("--git-dir", remote, "rev-parse", "dev"), before);
  assertWindow(view, x, "已合入");
  assert.equal(view.messages.length, 1);
  assert(view.messages[0].includes(tip));

  await tickTwice(f);
  const again = new Ledger(x.dir);
  assert.equal(quoteIntents(again).length, 1);
  assert.equal(again.rows.filter(r => r.type === "合入").length, 1);
  assert(!again.rows.some(r => r.step === "推送" || r.step === "部署"));
  assert.equal(f.git("rev-list", "--count", "--merges", "dev"), "1");
  assertWindow(view, x, "已合入");
  assert.equal(view.messages.length, 1);
});

test("N4 A2 · 评审中说合入，通过后旧原话不补成意图", async t => {
  const f = fixture(t, {reviewer: `touch "$LOOP_TASK_DIR/review-ready"
while [ ! -e "$LOOP_TASK_DIR/review-go" ]; do sleep .03; done
printf '%s' ${sq(PASS)}`});
  const {x, view} = await receipt(f), before = f.git("rev-parse", "dev");
  const review = f.call(["评审", x.executionId]);
  try {
    await until(x.dir, () => existsSync(join(x.dir, "review-ready")), Boolean);
    assertWindow(view, x, "评审中");
    view.input("合入");
    const inReview = new Ledger(x.dir);
    assert(inReview.last("窗口原话")!.n > inReview.last("开始")!.n);
    assert.equal(inReview.last("评审"), undefined);
  } finally {
    write(join(x.dir, "review-go"), "");
    await review;
  }
  const done = await complete(f, x);
  assertWindow(view, x, "完成");
  assert(done.last("完成")!.n > done.last("窗口原话")!.n);
  await tickTwice(f);
  assert.equal(quoteIntents(new Ledger(x.dir)).length, 0);
  assert.equal(new Ledger(x.dir).last("合入"), undefined);
  assert.equal(f.git("rev-parse", "dev"), before);
});

test("N4 A4 · 完成后合入吧、先别合入只记窗口原话", async t => {
  const f = fixture(t), {x, view} = await receipt(f), before = f.git("rev-parse", "dev");
  await complete(f, x);
  for (const text of ["合入吧", "先别合入"]) view.input(text);
  view.input("合入", "extension");
  await tickTwice(f);
  const l = new Ledger(x.dir);
  assert.deepEqual(l.rows.filter(r => r.type === "窗口原话").map(r => r.text), ["合入吧", "先别合入"]);
  assert.equal(quoteIntents(l).length, 0);
  assert.equal(l.last("合入"), undefined);
  assert.equal(f.git("rev-parse", "dev"), before);
  assertWindow(view, x, "完成");
  assert.deepEqual(view.messages, []);
});

test("N4 · 在等本人或 Esc 中止时说合入，解除等待但不补成合入意图", async t => {
  const f = fixture(t), {x, view} = await receipt(f), before = f.git("rev-parse", "dev");
  await f.call(["评审", x.executionId]);
  assertWindow(view, x, "收尾中"); // 调度还没记「完成」，窗口不提前显示可合入。
  await complete(f, x);
  await f.call(["提问", "请本人确认"], x.worktree, {LOOP_TASK_DIR: x.dir});
  assertWindow(view, x, "等你");
  view.input("合入");
  await tickTwice(f);
  assertWindow(view, x, "完成");

  view.abort();
  assertWindow(view, x, "本人中止");
  view.input("合入");
  await tickTwice(f);
  const l = new Ledger(x.dir);
  assert.equal(l.rows.filter(r => r.type === "窗口原话").length, 2);
  assert.equal(quoteIntents(l).length, 0);
  assert.equal(l.last("合入"), undefined);
  assert.equal(f.git("rev-parse", "dev"), before);
  assertWindow(view, x, "完成");
});

test("N4 A5 · 伪造完成遭合入工具拒绝，窗口说明原因且查询报缺证据", async t => {
  const f = fixture(t), {x, view, commit} = await receipt(f), before = f.git("rev-parse", "dev");
  const fake = locked(x.dir, l => l.add({type: "完成", sha: commit}));
  view.input("合入");
  const l = await f.pump(x.dir, l => !!l.last("合入") || !!l.last("评审"));
  assert.equal(l.last("评审"), undefined, "合入工具应先独立核对现有证据");
  const rejected = l.last("合入")!;
  assert.equal(rejected.result, "失败");
  assert.match(rejected.text!, /放行资格不足/);
  assert.equal(quoteIntents(l).length, 1);
  assert.equal(rejected.intent, quoteIntents(l)[0].n);
  assert.equal(f.git("rev-parse", "dev"), before);
  assertWindow(view, x, "合入失败");
  assert.equal(view.messages.length, 1);
  assert(view.messages[0].includes(rejected.text!));
  const query = (await f.call(["查询", x.executionId])).executions[0];
  assert(query.ledger.audit.some((r: any) => r.record === fake.n && /缺放行证据/.test(r.reason)));
});
