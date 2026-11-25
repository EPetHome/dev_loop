import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { registerPi } from "../src/hosts/pi.ts";
import { Ledger, locked, type Entry, type Task } from "../src/core/store.ts";
import { binding } from "../src/core/inputs.ts";
import { identity } from "../src/infra/exec.ts";
import { fixture, write } from "./helpers.ts";

function windowView(x: Task) {
  const start = locked(x.dir, l => l.add({type: "开始", step: "开窗口"}));
  let refresh: (() => void) | undefined, title: string | undefined, status: string | undefined;
  const ctx = {
    cwd: x.worktree, hasUI: true, isIdle: () => false,
    ui: {
      setTitle: (text: string) => { title = text; },
      setStatus: (key: string, text?: string) => { assert.equal(key, "dev-loop"); status = text; }
    },
    sessionManager: {getSessionId: () => "test-session", getSessionFile: () => undefined, getBranch: () => []},
    shutdown: () => assert.fail("窗口不应关闭")
  };
  const handlers = new Map<string, (event: unknown, context: typeof ctx) => unknown>();
  registerPi({on: (name, fn) => handlers.set(name, fn), sendMessage: () => assert.fail("本用例只刷新标题")}, {
    env: {LOOP_TASK_DIR: x.dir, LOOP_WINDOW_JOB: String(start.n), LOOP_PI_WINDOW_OWNER: String(process.ppid),
      LOOP_EXPECT_SESSION: "test-session", LOOP_WAKE: "manual"},
    every: ((callback: () => void) => { refresh = callback; }) as typeof setInterval
  });
  handlers.get("session_start")!({}, ctx);
  assert.ok(refresh, "Pi 应登记窗口并启动刷新");
  locked(x.dir, l => l.add({type: "开窗口", ref: start.n, result: "成功"}));
  return () => { refresh!(); return {title, status}; };
}

function assertWindow(view: ReturnType<typeof windowView>, task: Task, phase: string, detail = "") {
  const {title, status} = view(), expected = `【${phase}】${task.name}${detail} · 已用 0 评审轮`;
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
