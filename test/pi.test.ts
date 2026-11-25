import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPi } from "../src/hosts/pi.ts";
import { Ledger, locked, type Entry, type Task } from "../src/core/store.ts";
import { binding } from "../src/core/inputs.ts";
import { alive, identity } from "../src/infra/exec.ts";
import { maybe } from "../src/infra/files.ts";
import { fixture, write, writeFixtureScript, until, PASS, sq } from "./helpers.ts";

type SessionEntry = {type:string; id:string; parentId:string|null; message?:{role:string;content:string}; details?:number};
const history = [
  {type:"message",id:"first-turn",parentId:null,message:{role:"user",content:"先实现第一项"}},
  {type:"message",id:"first-answer",parentId:"first-turn",message:{role:"assistant",content:"已实现第一项"}},
];
function reloadBranch(file:string) {
  // Pi 解析有效 JSON，各帧按 id 关联，最后一条的 parentId 一直追到根。
  const entries=readFileSync(file,"utf8").split("\n").map(line=>maybe(()=>JSON.parse(line) as SessionEntry))
    .filter((e): e is SessionEntry=>!!e && e.type!=="session");
  const byId=new Map(entries.map(e=>[e.id,e])), branch:SessionEntry[]=[];
  for (let e=entries.at(-1); e; e=e.parentId ? byId.get(e.parentId) : undefined) branch.unshift(e);
  return branch;
}

function windowView(x: Task, receiveMessages = false, persist = appendFileSync) {
  const start = locked(x.dir, l => l.add({type: "开始", step: "开窗口"}));
  const file=write(join(x.dir,"sessions","test-session.jsonl"),
    [{type:"session",id:"test-session"},...history].map(e=>JSON.stringify(e)+"\n").join(""));
  let refresh: (() => void) | undefined, title: string | undefined, status: string | undefined;
  const messages: string[] = [], branch: SessionEntry[] = [...history];
  const link=()=>({id:`entry-${branch.length}`,parentId:branch.at(-1)?.id ?? null});
  const ctx = {
    cwd: x.worktree, mode: "tui", hasUI: true, isIdle: () => receiveMessages,
    ui: {
      setTitle: (text: string) => { title = text; },
      setStatus: (key: string, text?: string) => { assert.equal(key, "dev-loop"); status = text; },
      notify: (text:string)=>{ assert(receiveMessages); messages.push(text); }
    },
    sessionManager: {getSessionId: () => "test-session", getSessionFile: () => file, getBranch: () => branch},
    shutdown: () => assert.fail("窗口不应关闭")
  };
  const handlers = new Map<string, (event: unknown, context: typeof ctx) => unknown>();
  registerPi({on: (name, fn) => handlers.set(name, fn), sendMessage: (m, opts) => {
    assert(receiveMessages, "本用例只刷新标题");
    assert.equal(m.display, true);
    assert.equal(opts.triggerTurn, false, "通知不应另开模型轮次");
    // Pi 先更新内存，写入失败由宿主捕获；只有存入会话才发出显示事件。
    const entry = {type: "custom_message", ...m, ...link()};
    branch.push(entry);
    try { persist(file, JSON.stringify(entry) + "\n"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOSPC") return; throw e; }
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
    refresh: () => { refresh!(); return {title, status}; },
    laterTurn: (content:string)=>{
      const entry={type:"message",...link(),message:{role:"user",content}};
      branch.push(entry); appendFileSync(file,JSON.stringify(entry)+"\n");
      return entry;
    }, file, branch, messages
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
const receipt = async (f: ReturnType<typeof fixture>, persist?: typeof appendFileSync) => {
  const x = await f.prepare(), view = windowView(x, true, persist);
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

for (const applied of [true, false]) test(`N4 返修 2 · 合入 worker 在快进${applied ? "后" : "前"}退出，仅补真实结论`, async t => {
  const f = fixture(t), tipFile = join(f.base, "intended-merge");
  const shim = write(join(f.base, "kill-window-merge.mjs"), `
import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawn, append=fs.appendFileSync, tipFile=${JSON.stringify(tipFile)};
function interrupt(tip) { fs.writeFileSync(tipFile,tip); process.kill(process.pid,'SIGKILL'); }
${applied ? `fs.appendFileSync=(path,bytes,...opts)=>{
  if (String(path).endsWith('/ledger.jsonl') && String(bytes).includes('"type":"合入"') && !fs.existsSync(tipFile)) {
    const row=JSON.parse(bytes);
    if (row.intent && row.result==='成功') interrupt(row.value.devAfter);
  }
  return append(path,bytes,...opts);
};` : `cp.spawn=(cmd,args,opts)=>{
  const p=spawn(cmd,args,opts);
  if (args?.[2]==='dev-loop-start' && args[3]==='git' && args.includes('--ff-only') && !fs.existsSync(tipFile)) interrupt(args.at(-1));
  return p;
};`}
syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = [f.env.NODE_OPTIONS, `--import=${pathToFileURL(shim).href}`].filter(Boolean).join(" ");
  const {x, view, commit} = await receipt(f), before = f.git("rev-parse", "dev");
  await complete(f, x);
  view.input("合入");
  await f.pump(x.dir, () => existsSync(tipFile));
  const tip = readFileSync(tipFile, "utf8");
  assert.equal(f.git("rev-parse", "dev"), applied ? tip : before);
  if (applied) f.git("commit", "--allow-empty", "-m", "advance dev before receipt recovery");
  const head = f.git("rev-parse", "dev");
  const l = await f.pump(x.dir, l => !!l.last("合入"));
  const result = l.last("合入")!;
  assert.equal(result.result, applied ? "成功" : "失败");
  if (applied) {
    assert.equal(result.value.devAfter, tip, "回执应是原合入提交，不是后来 dev 的 HEAD");
    assert.equal(f.git("rev-parse", `${tip}^2`), commit);
  } else assert.match(result.text!, /未确认.*合入/);
  assertWindow(view, x, applied ? "已合入" : "合入失败");
  assert.equal(view.messages.length, 1);
  assert(view.messages[0].includes(applied ? tip : result.text!));
  await tickTwice(f);
  const after = new Ledger(x.dir);
  assert.equal(after.rows.filter(r => r.type === "窗口原话").length, 1);
  assert.equal(quoteIntents(after).length, 1);
  assert.equal(after.rows.filter(r => r.type === "合入").length, 1);
  assert.equal(f.git("rev-parse", "dev"), head);
  assert.equal(f.git("rev-list", "--count", "--merges", "dev"), applied ? "1" : "0");
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

test("N4 复审 1 · 合入进程未退出时 tick 不下结论，快进后只补原提交号", async t => {
  const f = fixture(t), {x, view, commit} = await receipt(f), before = f.git("rev-parse", "dev");
  await complete(f, x);
  const ready = join(f.base, "git-holds-ref"), go = join(f.base, "allow-git"), hooks = join(f.base, "hooks");
  // Git 自己在更新本地 dev 前通知 prepared。暂停的是这一笔真实的引用事务。
  writeFixtureScript(join(hooks, "reference-transaction"), "sh", `
if [ "$1" = prepared ]; then
  while read -r old new ref; do [ "$ref" != refs/heads/dev ] || printf '%s' "$new" > ${sq(ready)}; done
  if [ -s ${sq(ready)} ]; then while [ ! -e ${sq(go)} ]; do sleep .03; done; fi
fi
exit 0
`);
  f.git("config", "core.hooksPath", hooks);
  view.input("合入");
  let tip = "";
  try {
    const l = await f.pump(x.dir, () => existsSync(ready) && !!readFileSync(ready, "utf8"));
    tip = readFileSync(ready, "utf8");
    const merge = l.rows.findLast(r => r.type === "开始" && r.step === "合入")!;
    process.kill(merge.owner!.pid, "SIGKILL");
    await until(x.dir, () => alive(merge.owner), v => !v);
    await tickTwice(f);
    assert.equal(f.git("rev-parse", "dev"), before);
    const pending = new Ledger(x.dir);
    assert.equal(pending.last("合入"), undefined, "Git 未退出时不可登记最终结论");
    const git = pending.rows.find(r => r.type === "子进程" && r.ref === merge.n);
    assert(alive(git?.owner), "已登记的 Git 仍在执行原快进");
    assertWindow(view, x, "收尾中", " · 正在合入");
    assert.deepEqual(view.messages, []);
  } finally { write(go, ""); }
  const l = await f.pump(x.dir, l => !!l.last("合入"));
  assert.equal(l.last("合入")!.result, "成功");
  assert.equal(l.last("合入")!.value.devAfter, tip);
  assert.equal(f.git("rev-parse", "dev"), tip);
  assert.equal(f.git("rev-parse", "dev^2"), commit);
  assertWindow(view, x, "已合入");
  assert.equal(view.messages.length, 1);
  assert(view.messages[0].includes(tip));
  await tickTwice(f);
  const again = new Ledger(x.dir);
  assert.equal(quoteIntents(again).length, 1);
  assert.equal(again.rows.filter(r => r.type === "开始" && r.step === "合入").length, 1);
  assert.equal(again.rows.filter(r => r.type === "合入").length, 1);
  assert.equal(f.git("rev-list", "--count", "--merges", "dev"), "1");
});

for (const how of ["缺换行","截断 UTF-8 后已有后续对话"]) test(`N4 复审 2 · Pi 会话写满时不记送达，恢复后实际重发一次（${how}）`, async t => {
  const f = fixture(t);
  let full = true, attempts = 0;
  const {x, view, commit} = await receipt(f, (file, bytes) => {
    attempts++;
    if (!full) return appendFileSync(file, bytes);
    if (attempts===1) {
      const frame=Buffer.from(String(bytes));
      const end=how==="缺换行" ? frame.length-1 : frame.indexOf(Buffer.from("合入失败"))+1;
      appendFileSync(file,frame.subarray(0,end));
    }
    throw Object.assign(new Error("disk full"), {code: "ENOSPC"});
  });
  const rename=fs.renameSync;
  const diskFull=Object.assign(new Error("disk full"),{code:"ENOSPC"});
  const keepFull=t.mock.method(fs,"renameSync",(from:fs.PathLike,to:fs.PathLike)=>{
    if (to===view.file && full) throw diskFull;
    rename(from,to);
  });
  syncBuiltinESMExports();
  t.after(()=>{keepFull.mock.restore();syncBuiltinESMExports();});
  locked(x.dir, l => l.add({type: "完成", sha: commit}));
  view.input("合入");
  const refused = (await f.pump(x.dir, l => !!l.last("合入") || !!l.last("评审"))).last("合入")!;
  assert.match(refused.text!, /放行资格不足/);
  assertWindow(view, x, "合入失败");
  assert.equal(attempts, 1);
  assert.equal(new Ledger(x.dir).last("合入送达"), undefined);
  view.refresh();
  assert.deepEqual(view.messages, []);
  assert.equal(new Ledger(x.dir).last("合入送达"), undefined, "会话内存已有也不能提前确认");
  const original=readFileSync(view.file).subarray(0,Buffer.byteLength([
    {type:"session",id:"test-session"},...history
  ].map(e=>JSON.stringify(e)+"\n").join("")));
  full=false;
  const later=how==="缺换行" ? [] : [view.laterTurn("磁盘恢复后我又说了一句")];
  view.refresh();
  assert.equal(view.messages.length, 1);
  assert(view.messages[0].includes(refused.text!));
  assert.equal(new Ledger(x.dir).last("合入送达")?.ref, refused.n);
  view.refresh();
  assert.equal(view.messages.length, 1);
  const branch=reloadBranch(view.file), receiptEntries=branch.filter(e=>e.type==="custom_message");
  assert.deepEqual(branch.filter(e=>e.type==="message"),[...history,...later],"重开时原对话和后续对话均可从活动叶回溯");
  assert.deepEqual(readFileSync(view.file).subarray(0,original.length),original,"不变更之前的会话字节");
  assert.equal(receiptEntries.length,1);
  assert.equal(receiptEntries[0].details,refused.n);
  assert.equal(receiptEntries[0].id,view.branch[history.length].id,"补齐原条目，不产生悬空父节点");
  assert.deepEqual(branch,view.branch,"重载后的活动链和原 Pi 的内存链一致");
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
