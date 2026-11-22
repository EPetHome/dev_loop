import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixture, getJson, ROOT, until, write } from "./helpers.ts";
import { createTask, checked, checksOf, statusOf, taskOf } from "../src/core/store.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { digest, readText } from "../src/infra/files.ts";

const seed = Buffer.from([0,255,142,74,13,10]);
const testDir = "test/种子";
const common = {issue:"PA046",expected:1,beforeActual:0};
const sceneFiles = ["test/proof-scenario.cjs","test/proof-fixture-helper.cjs",`${testDir}/order.bin`];
const unitFiles = ["test/proof-unit.cjs","test/proof-cases.cjs",...sceneFiles.slice(1)];
const scene = {...common,scenario:"S3",checkpoint:"原单重投",test:"node test/proof-scenario.cjs",testFiles:sceneFiles};
const unit = {...common,testName:"原单重投",test:"node test/proof-unit.cjs",testFiles:unitFiles};
const build = `const fs=require('node:fs'), lock=JSON.parse(fs.readFileSync('src/lock.json','utf8'));
if (!lock.dep) { console.error('离线依赖不可得：queue@old'); process.exit(2); }
fs.mkdirSync('node_modules/queue',{recursive:true}); fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('node_modules/queue/index.js', 'module.exports='+JSON.stringify(lock));
fs.copyFileSync('src/inbox.cjs','dist/inbox.cjs'); console.log('built with '+lock.dep);`;
const inbox = (kind: "bug" | "fixed", extraStarts = 0) => `exports.inbox = notify => {
const seen=new Set(), allowed=new Set();
return (order,valid) => {
  const duplicate=${kind === "bug" ? "seen" : "allowed"}.has(order);
  seen.add(order);
  if (valid && !duplicate) { allowed.add(order); notify(order); ${"notify(order); ".repeat(extraStarts)} }
};};\n`;
const helper = `const assert=require('node:assert/strict'),fs=require('node:fs'),{join}=require('node:path');
const {inbox}=require('../dist/inbox.cjs'), lock=require('queue');
exports.lock=lock;
exports.observe=()=>{
  assert.equal(process.env.PROD_TOKEN,undefined); assert.equal(process.env.NODE_PATH,undefined);
  assert.equal(process.env.LOOP_TASK_DIR,undefined); assert.equal(fs.existsSync('local.txt'),false);
  for(const dir of [process.env.HOME,process.env.TMPDIR]) fs.writeFileSync(join(dir,'marker'),'',{flag:'wx'});
  const key=fs.readFileSync(${JSON.stringify(testDir+"/order.bin")}).toString('hex'), messages=[];
  const submit=inbox(order=>messages.push(order));
  submit(key,false); assert.deepEqual(messages,[],'首次拒绝'); submit(key,true);
  console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,tmp:process.env.TMPDIR,dep:lock.dep,key}));
  return messages.length;
};`;
const cases = `const {test}=require('node:test'),assert=require('node:assert/strict'),{observe,lock}=require('./proof-fixture-helper.cjs');
test('原单重投',t=>{
  assert.equal(Boolean(lock.earlierFailure),false,'首次拒绝前置断言');
  const actual=observe(),expected=1;
  t.diagnostic('observation:'+JSON.stringify({actual,expected})); assert.equal(actual,expected,'原单重投');
});
test('未选中的其他用例',()=>{ assert.fail('不应执行'); });`;
function project(t: TestContext, {old = "bug", dep = "old", earlierFailure = false, buildError = false}: {
  old?: "bug" | "fixed"; dep?: string | null; earlierFailure?: boolean; buildError?: boolean;
} = {}) {
  const f = fixture(t,{test:"true",config:{proofTestDirs:["test"],setup:"node src/build.cjs"}});
  write(join(f.repo,"src/inbox.cjs"),inbox(old)); write(join(f.repo,"src/build.cjs"),build);
  write(join(f.repo,"src/lock.json"),JSON.stringify({dep,earlierFailure}));
  write(join(f.repo,"src/compile.cjs"),buildError ? "const = syntax failure\n" : "// valid\n");
  write(join(f.repo,".gitignore"),readText(join(f.repo,".gitignore"))+"node_modules/\n");
  f.git("add","src",".gitignore"); f.git("commit","-m","historical product");
  const oldCommit = f.git("rev-parse","HEAD"), batch = join(f.repo,"结果.md");
  const start = async (proofs: unknown[]) => {
    write(f.card,JSON.stringify({...f.raw,tasks:[{...f.raw.tasks[0],scope:["src/**","test/**"],proofs}]})); return f.prepare();
  };
  const submit = (task: ReturnType<typeof taskOf>, kind: "bug" | "fixed" = "fixed", extraStarts = 0) => {
    const w = task.worktree;
    write(join(w,"src/inbox.cjs"),inbox(kind,extraStarts)); write(join(w,"src/lock.json"),'{"dep":"fixed"}'); write(join(w,"src/compile.cjs"),"// valid\n");
    for (const name of ["proof-scenario.cjs","proof-unit.cjs"]) write(join(w,"test",name),readText(join(ROOT,"test",name)));
    write(join(w,"test/proof-fixture-helper.cjs"),helper); write(join(w,"test/proof-cases.cjs"),cases);
    mkdirSync(join(w,testDir),{recursive:true}); writeFileSync(join(w,testDir,"order.bin"),seed);
    return deliver(task.dir).commit;
  };
  const run = async (task: ReturnType<typeof taskOf>, extraEnv?: NodeJS.ProcessEnv) =>
    getOutput(await f.cli(["证明",task.executionId,"--json"],f.repo,extraEnv)).proofs;
  return {...f,oldCommit,batch,start,submit,run};
}
const getOutput = ({stdout}: {stdout: string}) => JSON.parse(stdout);
const checks = (dir: string) => checksOf(dir).filter(c => c.step === "防复发证明");
const batchCount = (p: string) => [...readText(p).matchAll(/<!-- dev-loop-proof:/g)].length;

test("A8：实际原单重投及定向单元测试；两版隔离、开工快照、释放后仍绑定交付", async t => {
  const f = project(t);
  const task = await f.start([{...scene,before:f.oldCommit.slice(0,8)},unit]);
  assert.deepEqual(taskOf(task.dir).proofs?.map(p => p.before),[f.oldCommit,task.baseCommit]);
  const commit = f.submit(task); await settle(task.dir); assert.equal(checked(task.dir,commit),true);
  assert.equal(getOutput(await f.cli(["释放",task.executionId,"--json"])).released,true);
  write(f.card,"源卡不可再读"); write(join(f.repo,".autoreview.json"),"修改当前配置，不应读取");
  write(join(f.repo,"src/inbox.cjs"),"用户改动\n"); write(join(f.repo,"dist/inbox.cjs"),"不能用这个编译产物\n");
  const status = statusOf(task.dir), worktrees = f.git("worktree","list","--porcelain");
  const results = await f.run(task,{PROD_TOKEN:"not for proof",NODE_PATH:join(f.repo,"node_modules"),GIT_WORK_TREE:f.repo});
  assert.deepEqual(results.map((r: any) => r.result),["已证明","已证明"]);
  for (const r of results) {
    assert.equal(r.commit,commit); assert.equal(r.proof.before,f.oldCommit);
    assert.deepEqual(r.beforeRun.observation,{status:"失败",actual:0,expected:1});
    assert.deepEqual(r.afterRun.observation,{status:"通过",actual:1,expected:1});
    assert.equal(r.materials.find((m: any) => m.path.endsWith("order.bin")).sha256,digest(seed));
    assert.equal(r.materialDigest,digest(JSON.stringify(r.materials)));
    const observed = [r.beforeRun,r.afterRun].map(side => JSON.parse(readText(side.log).split("\n").find(s => s.startsWith('{"cwd"'))!));
    assert.deepEqual(observed.map(o => [o.dep,o.key]),[["old",seed.toString("hex")],["fixed",seed.toString("hex")]]);
    for (const key of ["cwd","tmp","home"]) { assert.notEqual(observed[0][key],observed[1][key]); assert.ok(observed.every(o => !existsSync(o[key]))); }
    assert.ok(checks(task.dir).find(c => c.attempt === r.attempt)?.evidence.includes(r.report));
    assert.ok(readText(f.batch).includes(r.attempt));
  }
  assert.match(readText(results[1].beforeRun.log),/ERR_ASSERTION/);
  assert.equal(f.git("worktree","list","--porcelain"),worktrees); assert.deepEqual(statusOf(task.dir),status);
  assert.equal(readText(join(f.repo,"src/inbox.cjs")),"用户改动\n"); assert.equal(readText(join(f.repo,"local.txt")),"local secret fixture\n");
  assert.equal(readText(join(f.repo,"outside.txt")),"protected\n"); assert.equal(existsSync(task.worktree),false);
  assert.match(readText(join(task.dir,"summary.md")),/防复发证明.*已证明/); assert.equal(f.git("rev-parse","dev"),f.oldCommit);
  const reused = await f.run(task);
  assert.deepEqual(reused.map((r: any) => [r.attempt,r.reused]),results.map((r: any) => [r.attempt,true]));
  assert.equal(checks(task.dir).length,2); assert.equal(batchCount(f.batch),2);
});

test("A9：定向名未选中、编译失败、前置断言失败都没有红证据", async t => {
  const f = project(t,{earlierFailure:true,buildError:true});
  const task = await f.start([
    {...unit,issue:"未选中",test:unit.test+" '^not selected$'"},
    {...unit,issue:"编译",test:"node --check src/compile.cjs && "+unit.test},
    {...unit,issue:"先失败"},
  ]);
  const commit = f.submit(task); assert.equal(checked(task.dir,commit),false);
  const results = await f.run(task);
  assert.deepEqual(results.map((r: any) => r.result),["未证明","未证明","未证明"]);
  assert.match(readText(results[0].beforeRun.log),/未取得唯一目标断言/);
  assert.match(readText(results[1].beforeRun.log),/SyntaxError/);
  assert.match(readText(results[2].beforeRun.log),/首次拒绝前置断言/);
  for (const r of results) { assert.equal(r.beforeRun.observation,undefined); assert.ok(r.reason.includes("result.json")); }
  assert.equal(results[1].afterRun.observation.actual,1); assert.equal(results[2].afterRun.observation.actual,1);
  assert.equal(checked(task.dir,commit),false); assert.equal(statusOf(task.dir).loop.phase,"已交付");
});

for (const [old,fixed,extra,expected,reason] of [
  ["fixed","fixed",0,[1,1],/旧版也通过/], ["bug","bug",0,[0,0],/修复版目标断言仍失败/],
  ["fixed","fixed",1,[1,2],/修复版目标断言仍失败/],
] as const) test(`A9：未证明不改合入资格，保留实得与重试 ${expected}`, async t => {
  const f = project(t,{old}), task = await f.start([scene]); const commit = f.submit(task,fixed,extra);
  await settle(task.dir); const original = statusOf(task.dir); assert.equal(checked(task.dir,commit),true);
  const [first] = await f.run(task), [second] = await f.run(task);
  assert.equal(first.result,"未证明"); assert.match(first.reason,reason);
  assert.deepEqual([first.beforeRun.observation.actual,first.afterRun.observation.actual],expected);
  assert.notEqual(first.attempt,second.attempt); assert.equal(second.reused,false);
  assert.equal(getJson(first.report).attempt,first.attempt); assert.equal(checks(task.dir).length,2); assert.equal(batchCount(f.batch),2);
  assert.equal(checked(task.dir,commit),true); assert.deepEqual(statusOf(task.dir),original);
});

test("旧版是其他错误值、或报告失败但退出 0，均不能当作红", async t => {
  const f = project(t), task = await f.start([{...scene,issue:"其他错误",beforeActual:2},{...scene,issue:"退出码",test:scene.test+" wrong-exit"}]);
  f.submit(task); const [wrong,exit] = await f.run(task);
  assert.match(wrong.reason,/旧版实得不符合.*2/); assert.equal(wrong.beforeRun.observation.actual,0);
  assert.match(exit.reason,/不一致/); assert.equal(exit.beforeRun.code,0);
  assert.equal(wrong.result,"未证明"); assert.equal(exit.result,"未证明");
});

test("A4：越界、交付链接、历史目录链接拒绝；不可得依赖保留前置原文", async t => {
  const f = project(t); const outside = join(f.base,"unrelated"); mkdirSync(outside);
  write(join(outside,"order.bin"),"用户数据\n"); mkdirSync(join(f.repo,"test")); symlinkSync(outside,join(f.repo,testDir));
  f.git("add","test"); f.git("commit","-m","old checkout contains escaping directory");
  const task = await f.start([
    {...scene,issue:"产品文件",testFiles:["src/inbox.cjs"]}, {...scene,issue:"路径逃逸",testFiles:["test/../src/inbox.cjs"]},
    {...scene,issue:"交付链接",testFiles:["test/link.cjs"]}, {...scene,issue:"历史链接"},
  ]);
  rmSync(join(task.worktree,testDir)); symlinkSync(join(f.repo,"outside.txt"),join(task.worktree,"test/link.cjs")); f.submit(task);
  const refs = f.git("worktree","list","--porcelain"), index = f.git("ls-files","--stage");
  const results = await f.run(task);
  assert.deepEqual(results.map((r: any) => r.result),Array(4).fill("未证明"));
  [/不在项目登记/,/路径不合法或越界/,/不接受链接/,/旧版：临时检出中的链接越出本版本：test\/种子/].forEach((msg,i) => assert.match(results[i].reason,msg));
  assert.equal(readText(join(outside,"order.bin")),"用户数据\n"); assert.equal(f.git("worktree","list","--porcelain"),refs); assert.equal(f.git("ls-files","--stage"),index);
  const g = project(t,{dep:null});
  // 登记一个能开工的基线，另选缺依赖的历史提交。
  write(join(g.repo,"src/lock.json"),'{"dep":"setup-ready"}'); g.git("add","src/lock.json"); g.git("commit","-m","setup-ready");
  const missing = await g.start([{...unit,before:g.oldCommit}]); g.submit(missing);
  const [attempt] = await g.run(missing); assert.equal(attempt.result,"未证明"); assert.match(attempt.reason,/setup[\s\S]*queue@old/);
  assert.match(readText(attempt.beforeRun.log),/离线依赖不可得：queue@old/); assert.equal(attempt.afterRun.observation.actual,1);
});

test("历史构建目录指向用户目录时，不运行 setup；不执行外部检出 hook 和过滤器", async t => {
  const f = project(t), outside = join(f.base,"shared-build"), sentinel = join(outside,"inbox.cjs"); write(sentinel,"原用户产物\n");
  symlinkSync(outside,join(f.repo,"dist")); write(join(f.repo,".gitattributes"),"src/inbox.cjs filter=isolated-proof\n");
  f.git("add","-f","dist",".gitattributes"); f.git("commit","-m","historical build links to shared output");
  const before = f.git("rev-parse","HEAD"); rmSync(join(f.repo,"dist")); f.git("add","-u","dist"); f.git("commit","-m","local build outputs");
  const task = await f.start([{...scene,before}]); f.submit(task);
  const hooks = join(f.repo,".git","proof-hooks"), ran = join(f.base,"ran-outside"); mkdirSync(hooks);
  writeFileSync(join(hooks,"post-checkout"),`#!/bin/sh\ntouch '${ran}'\n`,{mode:0o755});
  f.git("config","core.hooksPath",hooks); f.git("config","filter.isolated-proof.smudge",`touch '${ran}'; exit 17`);
  f.git("config","filter.isolated-proof.required","true");
  const [attempt] = await f.run(task);
  assert.equal(attempt.result,"未证明"); assert.match(attempt.reason,/旧版：.*链接越出本版本：dist/);
  assert.equal(attempt.afterRun.observation.actual,1); assert.equal(readText(sentinel),"原用户产物\n"); assert.equal(existsSync(ran),false);
});

test("A5：并发只跑一次，快照绑定原交付且不阻塞新交付", async t => {
  const f = project(t), task = await f.start([{...scene,test:scene.test+" hold"}]);
  const commit = f.submit(task), root = join(task.dir,"proofs"), running = f.run(task);
  const flag = await until<string | undefined>(task.dir,() => readdirSync(root).map(attempt => join(root,attempt,"before","started")).find(existsSync),Boolean);
  assert.ok(flag);
  try {
    await assert.rejects(f.run(task),/本执行正在跑证明/); assert.deepEqual(checks(task.dir),[]);
    // 正常交付不必等待证明；旧尝试仍只针对原登记提交。
    write(join(task.worktree,"src/inbox.cjs"),inbox("fixed",1)); const second = deliver(task.dir).commit;
    write(join(dirname(flag),"go"),""); const [first] = await running;
    assert.equal(first.commit,commit); assert.equal(first.result,"已证明"); assert.equal(checked(task.dir,commit),false);
    assert.equal(statusOf(task.dir).loop.delivery?.commit,second); assert.equal(batchCount(f.batch),1);
    assert.equal(checks(task.dir).length,1); assert.equal(readdirSync(root).length,1);
  } finally { write(join(dirname(flag),"go"),""); await running; }
});

test("批次摘要登记中断后补写同一尝试，不覆盖原文件或重复登记", async t => {
  const f = project(t), task = await f.start([scene]); f.submit(task);
  const innocent = join(f.base,"user.md"); write(innocent,"用户原文\n"); symlinkSync(innocent,f.batch);
  await assert.rejects(f.run(task),/ELOOP/); const [written] = checks(task.dir);
  assert.equal(written.result,"已证明"); assert.equal(readText(innocent),"用户原文\n");
  rmSync(f.batch); write(f.batch,"原收尾摘要\n");
  const [result] = await f.run(task);
  assert.equal(result.attempt,written.attempt); assert.equal(result.reused,true); assert.deepEqual(checks(task.dir),[written]);
  assert.equal(batchCount(f.batch),1); assert.ok(readText(f.batch).startsWith("原收尾摘要\n"));
});

test("证明只接受执行号；未交付拒绝，未声明不建证明目录；不存在的旧 SHA 不开工", async t => {
  const f = project(t), task = await f.start([scene]);
  await assert.rejects(f.run(task),/尚未登记交付/); assert.equal(existsSync(join(task.dir,"proofs")),false);
  await assert.rejects(f.cli(["证明",task.card]),/须指定一个执行编号/);
  const legacy = fixture(t), old = await legacy.prepare(); deliver(old.dir); await settle(old.dir);
  assert.deepEqual(getOutput(await legacy.cli(["证明",old.executionId,"--json"])).proofs,[]);
  assert.equal(existsSync(join(old.dir,"proofs")),false); assert.equal(existsSync(join(legacy.repo,"结果.md")),false);
  const raw = getJson(f.card); raw.tasks[0].proofs[0].before = "refs/heads/not-present"; write(f.card,JSON.stringify(raw));
  assert.throws(() => createTask(f.card,f.root),/Needed a single revision/); assert.deepEqual(readdirSync(f.root),[task.executionId]);
});
