import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { finish } from "../src/cli/finish.ts";
import { join } from "node:path";
import { fixture, write, getJson, NODE, until, PASS, sq } from "./helpers.ts";
import { companion } from "../src/cli/companion.ts";
import { comparison, releaseWorktree } from "../src/cli/inspect.ts";
import { createTask, statusOf, checksOf, transition } from "../src/core/store.ts";
import { prepare, resume } from "../src/core/lifecycle.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { deploy } from "../src/steps/deploy.ts";
import { compare } from "../src/infra/snapshot.ts";
import { gitText } from "../src/infra/git.ts";
import { startCompanion } from "../src/hosts/after-settle.ts";
function snapshotFixture(t: Parameters<typeof fixture>[0], body?: string) {
  const f=fixture(t,{config:{snapshot:"snapshot.cjs",setup:"test -f local.txt",deploy:{cmd:"deploy.cjs",check:"check.cjs",rollback:"check.cjs"}}});
  const scripts={
    "snapshot.cjs":body || "const value=e.LOOP_SNAPSHOT_MODE==='scenario'?fs.readFileSync('src/app.txt','utf8').trim():fs.readFileSync(e.LOOP_REPO+'/live-value','utf8');fs.writeFileSync(e.LOOP_SNAPSHOT_OUT,JSON.stringify({value,mode:e.LOOP_SNAPSHOT_MODE}));",
    "deploy.cjs":"fs.writeFileSync(e.LOOP_REPO+'/live-value',e.LOOP_DEPLOY_COMMIT);",
    "check.cjs":""};
  for(const [path,code] of Object.entries(scripts)){write(join(f.repo,path),"#!"+NODE+"\nconst fs=require('fs'),e=process.env;"+code+"\n");chmodSync(join(f.repo,path),0o755);}
  write(join(f.repo,"package-lock.json"),"{\"lockfileVersion\":3}\n");f.git("add",".");f.git("commit","-m","snapshot substitutes");write(join(f.repo,"live-value"),"live base");
  return f;
}
test("比较纯函数：新增/减少/变化、数组、空对象和特殊路径，不解释数值",()=>{
  assert.deepEqual(compare({a:1,b:[],gone:true,"a.b":1},{a:2,b:[1],new:false,"a.b":1}),["变化 /a：1 → 2","减少 /b：[]","新增 /b/0：1","减少 /gone：true","新增 /new：false"]);
  assert.deepEqual(compare({"a/b":{"~":1}},{"a/b":{"~":2}}),["变化 /a~1b/~0：1 → 2"]);assert.deepEqual(compare({},{}),[]);
});
test("陪跑：同源独立工作区、localFiles/setup、基线存任务目录、删除检出且不改状态",async t=>{
  const f=snapshotFixture(t),task=await f.prepare(),before=statusOf(task.dir),trees=f.git("worktree","list","--porcelain");
  write(join(task.worktree,"src/app.txt"),"good developer change\n");await companion(task.dir);
  assert.deepEqual(getJson(join(task.dir,"snapshot-base.json")),{value:"good",mode:"scenario"});assert.equal(statusOf(task.dir).seq,before.seq);
  assert.equal(existsSync(join(task.dir,"companion")),false);assert.equal(f.git("worktree","list","--porcelain"),trees);assert.equal(readFileSync(join(task.worktree,"src/app.txt"),"utf8"),"good developer change\n");
  assert.equal(checksOf(task.dir).at(-1)!.result,"基线已存");assert.equal(getJson(join(task.dir,"snapshot-base-static.json")).commit,task.baseCommit);
  const d=deliver(task.dir);await settle(task.dir);assert.equal(statusOf(task.dir).state,"completed");
  const material=readFileSync(join(task.dir,"review-input-r1.md"),"utf8");assert.match(material,/运行差异[\s\S]*src\/app.txt[\s\S]*变化 \/value："good" → "good developer change"/);
  assert.equal(getJson(join(task.dir,"snapshot-"+d.commit+".json")).mode,"scenario");assert.equal(readdirSync(task.worktree).some(p=>p.startsWith(".loop-snapshot-")),false);
});
test("陪跑未登记/脚本缺失跳过；配置、setup、脚本失败均只记记录，不影响开发复测评审",async t=>{
  const plain=fixture(t),task=await plain.prepare(),before=statusOf(task.dir);await companion(task.dir);assert.equal(checksOf(task.dir).at(-1)!.result,"跳过");assert.equal(statusOf(task.dir).seq,before.seq);
  for(const kind of ["missing","invalid","script","setup"]){
    const f=snapshotFixture(t,kind==="script"?"process.exit(9);":undefined);
    const cfg=getJson(join(f.repo,".autoreview.json"));if(kind==="missing")cfg.snapshot="not-in-base.cjs";if(kind==="invalid")cfg.snapshot="../outside";
    const task=await f.prepare();if(kind==="setup")cfg.setup="exit 8";
    // setup 快照只影响陪跑，用新执行承接当前配置；开发方已有 ready 不受影响。
    write(join(f.repo,".autoreview.json"),JSON.stringify(cfg));
    const actual=kind==="setup"?createTask(f.card,f.root):task,initial=statusOf(actual.dir);
    await companion(actual.dir);assert.equal(statusOf(actual.dir).seq,initial.seq);assert.equal(existsSync(join(actual.dir,"companion")),false);
    assert.equal(checksOf(actual.dir).at(-1)!.result,kind==="missing"?"跳过":"失败");
    if(kind!=="setup"){write(join(task.worktree,"src/app.txt"),"good updated\n");deliver(task.dir);await settle(task.dir);assert.equal(statusOf(task.dir).state,"completed");}
  }
});
test("宿主拉起并行陪跑，不等开发完成；进程完成后工作区清理",async t=>{
  const f=snapshotFixture(t),task=await f.prepare(), trees=f.git("worktree","list","--porcelain");await startCompanion(task.dir,f.env);
  await until(task.dir,()=>checksOf(task.dir),records=>records.some(c=>c.step==="陪跑"));
  await until(task.dir,()=>existsSync(join(task.dir,"companion.lock")),v=>!v);assert.equal(f.git("worktree","list","--porcelain"),trees);
  assert.equal(statusOf(task.dir).loop.phase,"开发中");assert.equal(existsSync(join(task.dir,"snapshot-base.json")),true);
});
test("部署前后 live、静态依赖摘要；对比一个/两个执行、释放保留证据分支且禁续跑",async t=>{
  const f=snapshotFixture(t),task=await f.prepare();write(join(task.worktree,"src/app.txt"),"good version one\n");const c1=deliver(task.dir).commit;await settle(task.dir);
  const a=await deploy(task.dir,{commit:c1});assert.equal(getJson(join(a.evidenceDir,"snapshot-before.json")).value,"live base");assert.equal(getJson(join(a.evidenceDir,"snapshot-after.json")).value,c1);
  const metadata=getJson(join(a.evidenceDir,"snapshot-static.json"));assert.equal(metadata.commit,c1);assert.match(metadata.dependencies["package-lock.json"],/^[a-f0-9]{64}$/);
  write(join(f.repo,"live-value"),"later live");const one=JSON.parse((await f.cli(["对比",task.executionId,"--json"])).stdout);assert.match(one.diff,/变化 \/value[\s\S]*later live/);assert.ok(existsSync(one.report));
  const second=createTask(f.card,f.root);await prepare(second.dir);write(join(second.worktree,"src/app.txt"),"good version two\n");const c2=deliver(second.dir).commit;await settle(second.dir);const b=await deploy(second.dir,{commit:c2});
  const two=JSON.parse((await f.cli(["对比",task.executionId,second.executionId,"--json"])).stdout);assert.match(two.diff,/变化 \/value/);assert.ok(two.diff.includes(c1));assert.ok(two.diff.includes(c2));
  assert.deepEqual(getJson(join(b.evidenceDir,"snapshot-static.json")).files,["src/app.txt"]);
  transition(second.dir,"working","开发中","working",null);assert.throws(()=>releaseWorktree(second.dir),/未完成/);
  const released=JSON.parse((await f.cli(["释放",task.executionId,"--json"])).stdout);assert.deepEqual(released,{executionId:task.executionId,released:true});assert.equal(existsSync(task.worktree),false);assert.equal(statusOf(task.dir).loop.phase,"已部署");
  assert.equal(existsSync(a.evidenceDir),true);assert.ok(f.git("show-ref","--verify","refs/heads/"+task.branch));assert.equal(existsSync(join(task.dir,"checks.jsonl")),true);
  assert.deepEqual(checksOf(task.dir).filter(c=>c.step==="释放").map(c=>c.result),["已释放"]);
  assert.throws(()=>resume(task.dir),/已释放/);assert.throws(()=>releaseWorktree(task.dir),/已释放/);await settle(task.dir);assert.equal(statusOf(task.dir).state,"completed");
});
test("手工释放拒绝未跟踪、已暂存和未暂存文件，不改文件、状态或检查记录", async t => {
  const f = fixture(t), task = await f.prepare(), cwd = task.worktree;
  write(join(cwd,"src/app.txt"),"good delivered\n"); deliver(task.dir); await settle(task.dir);
  f.git("config","status.showUntrackedFiles","no");
  const before = statusOf(task.dir), records = readFileSync(join(task.dir,"checks.jsonl"),"utf8");
  assert.equal(before.state,"completed");
  const rejectRelease = (...paths: string[]) => assert.rejects(f.cli(["释放",task.executionId,"--json"]),(e: {code: number; stderr: string})=>{
    assert.equal(e.code,1);
    const {error} = JSON.parse(e.stderr);
    assert.equal(error.category,"输入问题"); assert.match(error.raw,/工作区有未提交文件/);
    for (const path of paths) assert.ok(error.raw.includes(path));
    return true;
  });
  gitText(cwd,["update-index","--assume-unchanged","src/app.txt"]); write(join(cwd,"src/app.txt"),"unstaged\n");
  const index = gitText(cwd,["rev-parse","--git-path","index"]), original = readFileSync(index);
  assert.equal(gitText(cwd,["status","--porcelain=v1"]),""); await rejectRelease("src/app.txt");
  assert.deepEqual(readFileSync(index),original);
  assert.equal(readFileSync(join(cwd,"src/app.txt"),"utf8"),"unstaged\n");
  write(join(cwd,"中文 draft.txt"),"untracked\n"); write(join(cwd,"outside.txt"),"staged\n"); gitText(cwd,["add","outside.txt"]);
  await rejectRelease("中文 draft.txt","outside.txt","src/app.txt");
  assert.equal(readFileSync(join(cwd,"中文 draft.txt"),"utf8"),"untracked\n");
  assert.equal(readFileSync(join(cwd,"outside.txt"),"utf8"),"staged\n"); assert.equal(gitText(cwd,["show",":outside.txt"]),"staged");
  assert.equal(readFileSync(join(cwd,"src/app.txt"),"utf8"),"unstaged\n");
  assert.deepEqual(statusOf(task.dir),before); assert.equal(readFileSync(join(task.dir,"checks.jsonl"),"utf8"),records);
});
test("live 留痕失败只记记录；缺基线对比不影响状态，没登记脚本不阻断部署",async t=>{
  const f=snapshotFixture(t,"console.log('snapshot broken');process.exit(7);"),task=await f.prepare();transition(task.dir,"completed","完成","ready",null);
  const r=await deploy(task.dir);assert.equal(r.result,"已部署");assert.equal(statusOf(task.dir).loop.phase,"已部署");assert.equal(checksOf(task.dir).filter(c=>c.step==="留痕" && c.result==="失败").length,2);
  const seq=statusOf(task.dir).seq,out=await comparison(task.dir);assert.equal(out.diff,"没有基线");assert.equal(statusOf(task.dir).seq,seq);
});
test("留痕 A1–A3：四个时机读取 deploy.env，覆盖宿主且保留框架变量和独立 TMPDIR",async t=>{
  const previous=process.env.PROBE;process.env.PROBE="0";t.after(()=>{if(previous===undefined)delete process.env.PROBE;else process.env.PROBE=previous;});
  const f=snapshotFixture(t,"fs.writeFileSync(e.LOOP_SNAPSHOT_OUT,JSON.stringify({probe:e.PROBE,tmp:e.TMPDIR,mode:e.LOOP_SNAPSHOT_MODE,task:e.LOOP_TASK_DIR,repo:e.LOOP_REPO,commit:e.LOOP_SNAPSHOT_COMMIT,out:e.LOOP_SNAPSHOT_OUT,isolated:fs.statSync(e.TMPDIR).isDirectory()}));");
  const cfg=getJson(join(f.repo,".autoreview.json"));cfg.deploy.env={PROBE:"1",TMPDIR:join(f.base,"别处")};write(join(f.repo,".autoreview.json"),JSON.stringify(cfg));
  const task=await f.prepare();await companion(task.dir);write(join(task.worktree,"src/app.txt"),"good env snapshot\n");const {commit}=deliver(task.dir);await settle(task.dir);
  assert.equal(statusOf(task.dir).state,"completed");const r=await deploy(task.dir,{commit});assert.equal(r.result,"已部署");
  const outputs=[
    [join(task.dir,"snapshot-base.json"),"scenario",task.baseCommit],
    [join(task.dir,"snapshot-"+commit+".json"),"scenario",commit],
    [join(r.evidenceDir,"snapshot-before.json"),"live",commit],
    [join(r.evidenceDir,"snapshot-after.json"),"live",commit]
  ];
  for(const [out,mode,sha] of outputs){
    const value=getJson(out);assert.equal(value.probe,"1");assert.equal(value.mode,mode);assert.equal(value.task,task.dir);assert.equal(value.repo,task.repo);assert.equal(value.commit,sha);assert.equal(value.out,out);
    assert.notEqual(value.tmp,cfg.deploy.env.TMPDIR);assert.match(value.tmp,/[/\\]\.loop-snapshot-/);assert.equal(value.isolated,true);
    await until(task.dir,()=>!existsSync(value.tmp),Boolean,value.tmp);
  }
  const records=checksOf(task.dir).filter(c=>c.step==="留痕");assert.deepEqual(records.map(c=>c.result),["已存","已存","已存","已存"]);assert.deepEqual(records.map(c=>c.evidence[0]),outputs.map(([out])=>out));assert.equal(process.env.PROBE,"0");
});
test("留痕 A4：没有 deploy 段仍可陪跑和评审前采集",async t=>{
  const f=snapshotFixture(t),cfg=getJson(join(f.repo,".autoreview.json"));delete cfg.deploy;write(join(f.repo,".autoreview.json"),JSON.stringify(cfg));
  const task=await f.prepare();await companion(task.dir);write(join(task.worktree,"src/app.txt"),"good no deploy\n");const {commit}=deliver(task.dir);await settle(task.dir);
  assert.deepEqual(getJson(join(task.dir,"snapshot-base.json")),{value:"good",mode:"scenario"});assert.deepEqual(getJson(join(task.dir,"snapshot-"+commit+".json")),{value:"good no deploy",mode:"scenario"});
  assert.equal(statusOf(task.dir).state,"completed");assert.deepEqual(checksOf(task.dir).filter(c=>c.step==="留痕").map(c=>c.result),["已存","已存"]);
});
test("留痕 A5：deploy 登记不合法记录原因，不改陪跑阶段也不阻断开发复测评审",async t=>{
  const f=snapshotFixture(t),cfg=getJson(join(f.repo,".autoreview.json"));cfg.deploy.env={lower:"invalid"};write(join(f.repo,".autoreview.json"),JSON.stringify(cfg));
  const task=await f.prepare(),before=statusOf(task.dir);await companion(task.dir);assert.deepEqual(statusOf(task.dir),before);assert.equal(existsSync(join(task.dir,"snapshot-base.json")),false);assert.equal(existsSync(join(task.dir,"companion")),false);
  const records=checksOf(task.dir).filter(c=>c.step==="留痕");assert.equal(records.length,1);assert.equal(records[0].result,"失败");assert.match(records[0].detail!,/\.autoreview\.json 的 deploy 不合法：[\s\S]*env/);assert.deepEqual(records[0].evidence,[]);
  write(join(task.worktree,"src/app.txt"),"good invalid deploy\n");const {commit}=deliver(task.dir);await settle(task.dir);assert.equal(statusOf(task.dir).state,"completed");assert.equal(existsSync(join(task.dir,"snapshot-"+commit+".json")),false);
  assert.deepEqual(checksOf(task.dir).filter(c=>c.step==="留痕").map(c=>c.result),["失败","失败"]);
});
test("留痕 A6：live 对比读取仓库根目录最新 deploy.env，不用启动或检出中的旧登记",async t=>{
  const f=snapshotFixture(t,"fs.writeFileSync(e.LOOP_SNAPSHOT_OUT,JSON.stringify({probe:e.PROBE}));"),cfg=getJson(join(f.repo,".autoreview.json"));cfg.deploy.env={PROBE:"startup"};write(join(f.repo,".autoreview.json"),JSON.stringify(cfg));
  const task=await f.prepare();cfg.deploy.env.PROBE="1";write(join(f.repo,".autoreview.json"),JSON.stringify(cfg));const deployed=await deploy(task.dir);
  assert.deepEqual(getJson(join(deployed.evidenceDir,"snapshot-before.json")),{probe:"1"});assert.deepEqual(getJson(join(deployed.evidenceDir,"snapshot-after.json")),{probe:"1"});
  cfg.deploy.env.PROBE="2";write(join(f.repo,".autoreview.json"),JSON.stringify(cfg));const out=await comparison(task.dir);assert.equal(out.diff,'变化 /probe："1" → "2"');
  const records=checksOf(task.dir).filter(c=>c.step==="留痕");assert.deepEqual(records.map(c=>c.result),["已存","已存","已存"]);assert.deepEqual(getJson(records.at(-1)!.evidence[0]),{probe:"2"});
});
test("返修必修2：snapshot 输出目录不阻断陪跑、复测评审、部署和 dev 快进",async t=>{
  const f=snapshotFixture(t,"fs.mkdirSync(e.LOOP_SNAPSHOT_OUT);"),card={...f.raw,flow:["开发评审","测试","合入","部署"]};write(f.card,JSON.stringify(card));
  const task=await f.prepare(),before=statusOf(task.dir);await companion(task.dir);assert.equal(statusOf(task.dir).seq,before.seq);assert.equal(existsSync(join(task.dir,"snapshot-base.json")),false);
  write(join(task.worktree,"src/app.txt"),"good directory-output\n");const {commit}=deliver(task.dir);await settle(task.dir);assert.equal(statusOf(task.dir).loop.phase,"收尾中");
  await finish(task.dir);assert.equal(statusOf(task.dir).state,"completed");assert.equal(statusOf(task.dir).loop.phase,"已部署");assert.equal(f.git("rev-parse","dev^2"),commit);
  const failed=checksOf(task.dir).filter(c=>c.step==="留痕" && c.result==="失败");assert.equal(failed.length,4);assert.ok(failed.every(c=>/EISDIR|directory/.test(c.detail!)));
  assert.equal(existsSync(join(task.dir,"snapshot-"+commit+".json")),false);
});
test("W1 r2 必修3：留痕改写已跟踪源码和复测产物后失败，评审仍读 B 与原产物", async t => {
  const f = snapshotFixture(t, `
    if (fs.readFileSync('dist/report','utf8') !== 'B\\n') throw Error('未拿到原复测产物');
    fs.writeFileSync('src/app.txt','C\\n'); fs.writeFileSync('dist/report','C\\n'); console.error('snapshot 真实失败'); process.exit(7);`);
  const repo = f.repo;
  write(join(repo,"reviewer.sh"), '#!/bin/sh\ncat src/app.txt dist/report > "$LOOP_TASK_DIR/review-read"\n' +
    'grep -qx B src/app.txt && grep -qx B dist/report || exit 11\nprintf %s ' + sq(PASS) + '\n');
  f.raw.tasks[0].test = "mkdir -p dist; cp src/app.txt dist/report"; write(f.card,JSON.stringify(f.raw));
  f.git("add","reviewer.sh"); f.git("commit","-m","review from source and report");
  const task = await f.prepare(); write(join(task.worktree,"src/app.txt"),"B\n");
  const {commit} = deliver(task.dir); await settle(task.dir);
  const s = statusOf(task.dir), checks = checksOf(task.dir).filter(c=>["复测","留痕","评审"].includes(c.step));
  const read = existsSync(join(task.dir,"review-read")) ? readFileSync(join(task.dir,"review-read"),"utf8") : null;
  t.diagnostic(JSON.stringify({commit, state:s.state, error:s.error, read, checks:checks.map(({step,result,detail})=>({step,result,detail}))}));
  assert.deepEqual(checks.map(c=>[c.step,c.result,c.commit]),[["复测","通过",commit],["留痕","失败",commit],["评审","通过",commit]]);
  assert.match(checks[1].detail!,/snapshot 真实失败/);
  assert.equal(read,"B\nB\n"); assert.equal(s.state,"completed");
  assert.equal(readFileSync(join(task.worktree,"src/app.txt"),"utf8"),"B\n");
  assert.equal(existsSync(join(task.worktree,"dist/report")),false);
});

for (const target of ["内部", "外部"]) test("W1 r3 必修1：留痕绝对软链接 · " + target, async t => {
  const f = snapshotFixture(t, `
    const before=fs.readFileSync('dist/latest','utf8');
    fs.writeFileSync('dist/latest','C\\n');
    fs.writeFileSync(e.LOOP_TASK_DIR+'/snapshot-read',before);
    console.error('留痕更新副本后退出'); process.exit(9);`);
  const external = join(f.base,"external-report"); write(external,"外部原文\n");
  f.raw.tasks[0].test = 'mkdir -p dist; printf "B\\n" > dist/report; ln -s ' + (target === "内部" ? '"$PWD/dist/report"' : sq(external)) + ' dist/latest';
  write(f.card,JSON.stringify(f.raw));
  write(join(f.repo,"reviewer.sh"), '#!/bin/sh\ncat dist/report > "$LOOP_TASK_DIR/review-read"\ngrep -qx B dist/report || exit 11\nprintf %s ' + sq(PASS) + '\n');
  f.git("add","reviewer.sh"); f.git("commit","-m","review reads raw coverage report");
  const task = await f.prepare(), {commit} = deliver(task.dir); await settle(task.dir);
  const s = statusOf(task.dir), read = (name: string) => existsSync(join(task.dir,name)) ? readFileSync(join(task.dir,name),"utf8") : null;
  const snapshot = checksOf(task.dir).find(c => c.step === "留痕");
  t.diagnostic(JSON.stringify({commit,target,phase:s.loop.phase,reviewer:read("review-read"),snapshot:read("snapshot-read"),detail:snapshot?.detail}));
  assert.equal(snapshot?.result,"失败"); assert.equal(read("review-read"),"B\n"); assert.equal(s.state,"completed");
  assert.equal(readFileSync(external,"utf8"),"外部原文\n");
  if (target === "外部") { assert.equal(read("snapshot-read"),null); assert.match(snapshot.detail!,/链接.*越出/); }
  else { assert.equal(read("snapshot-read"),"B\n"); assert.match(snapshot.detail!,/留痕更新副本后退出/); }
});

test("W1 r3 必修2：留痕副本准备期间耗尽复测时限，只记留痕失败并进入评审", async t => {
  const f = snapshotFixture(t, "fs.writeFileSync(e.LOOP_TASK_DIR+'/snapshot-ran','');");
  f.raw.host = "claude"; f.raw.limits = {测试:{timeoutMin:79},开发评审:{timeoutMin:1}};
  f.raw.tasks[0].test = "node gate-copy-test.cjs"; write(f.card,JSON.stringify(f.raw));
  write(join(f.repo,"gate-copy-test.cjs"), `
const fs=require('fs'),dir=process.env.LOOP_TASK_DIR;
const check=()=>{if(fs.existsSync(dir+'/allow-test'))watcher.close();};
const watcher=fs.watch(dir,check);fs.writeFileSync(dir+'/test-moving','');check();`);
  f.git("add","gate-copy-test.cjs"); f.git("commit","-m","controlled checkout deadline fixture");
  const task = await f.prepare(), {commit} = deliver(task.dir), preload = join(f.base,"hold-copy.mjs");
  write(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
if(process.argv.includes('--snapshot-copy')) {
  fs.cpSync=()=>{fs.writeFileSync(process.env.LOOP_TASK_DIR+'/copy-enter','');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
  syncBuiltinESMExports();
}`);
  const oldOptions = process.env.NODE_OPTIONS, original = fs.cpSync, epoch = Date.now();
  process.env.NODE_OPTIONS = "--import=" + preload;
  t.after(() => { if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=oldOptions; t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.timers.enable({apis:["Date","setTimeout"],now:epoch});
  t.mock.method(fs,"cpSync",(...args:Parameters<typeof original>)=>{
    if (String(args[0]) === join(task.dir,"check-worktree")) t.mock.timers.tick(62_000); // 旧版在 Stop 进程同步复制
    return original(...args);
  }); syncBuiltinESMExports();
  const marker = join(task.dir,"copy-enter"), done = join(task.dir,"settled"), active = settle(task.dir).then(r=>{write(done,"");return r;});
  await until(task.dir,()=>existsSync(join(task.dir,"test-moving")),Boolean);
  t.mock.timers.tick(79 * 60000 - 1000); write(join(task.dir,"allow-test"),"");
  await until(task.dir,()=>existsSync(marker)||existsSync(done),Boolean);
  if (existsSync(marker)) t.mock.timers.tick(1000);
  await active;
  const s=statusOf(task.dir), checks=checksOf(task.dir).filter(c=>["复测","留痕","评审"].includes(c.step));
  t.diagnostic(JSON.stringify({commit,elapsedMs:Date.now()-epoch,copyStarted:existsSync(marker),phase:s.loop.phase,checks:checks.map(c=>[c.step,c.result,c.detail])}));
  assert.deepEqual(checks.map(c=>[c.step,c.result]),[["复测","通过"],["留痕","失败"],["评审","通过"]]);
  assert.match(checks[1].detail!,/副本准备.*超时/);
  assert.equal(existsSync(marker),true); assert.equal(existsSync(join(task.dir,"snapshot-ran")),false);
  assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"review\n"); assert.equal(s.state,"completed");
  assert.ok(Date.now()-epoch < 80 * 60000);
});

test("返修必修2：异常输出清理再失败只追加失败记录，核心仍完成",async t=>{
  const f=snapshotFixture(t,"fs.mkdirSync(e.LOOP_SNAPSHOT_OUT);"),task=await f.prepare();write(join(task.worktree,"src/app.txt"),"good cleanup-failure\n");const {commit}=deliver(task.dir),out=join(task.dir,"snapshot-"+commit+".json"),original=fs.rmSync;let calls=0;
  t.mock.method(fs,"rmSync",(path: Parameters<typeof original>[0],options?: Parameters<typeof original>[1])=>{if(String(path)===out && ++calls>1)throw Object.assign(new Error("simulated output EACCES"),{code:"EACCES"});return original(path,options);});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await settle(task.dir);assert.equal(statusOf(task.dir).state,"completed");assert.ok(calls>=2);
  const failed=checksOf(task.dir).filter(c=>c.step==="留痕" && c.result==="失败");assert.equal(failed.length,1);assert.match(failed[0].detail!,/清理失败[\s\S]*EACCES/);
});
