import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { finish } from "../src/cli/finish.ts";
import { join } from "node:path";
import { fixture, write, getJson, NODE, until } from "./helpers.ts";
import { companion } from "../src/cli/companion.ts";
import { comparison, releaseWorktree } from "../src/cli/inspect.ts";
import { createTask, statusOf, checksOf, transition } from "../src/core/store.ts";
import { prepare, resume } from "../src/core/lifecycle.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { deploy } from "../src/steps/deploy.ts";
import { compare } from "../src/infra/snapshot.ts";
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
  const f=snapshotFixture(t),task=await f.prepare();await startCompanion(task.dir,f.env);
  await until(task.dir,()=>checksOf(task.dir),records=>records.some(c=>c.step==="陪跑"));
  await until(task.dir,()=>existsSync(join(task.dir,"companion")),v=>!v);assert.equal(statusOf(task.dir).loop.phase,"开发中");assert.equal(existsSync(join(task.dir,"snapshot-base.json")),true);
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
  const released=JSON.parse((await f.cli(["释放",task.executionId,"--json"])).stdout);assert.equal(released.released,true);assert.equal(existsSync(task.worktree),false);assert.equal(statusOf(task.dir).loop.phase,"已部署");
  assert.equal(existsSync(a.evidenceDir),true);assert.ok(f.git("show-ref","--verify","refs/heads/"+task.branch));assert.equal(existsSync(join(task.dir,"checks.jsonl")),true);
  assert.throws(()=>resume(task.dir),/已释放/);assert.throws(()=>releaseWorktree(task.dir),/已释放/);await settle(task.dir);assert.equal(statusOf(task.dir).state,"completed");
});
test("live 留痕失败只记记录；缺基线对比不影响状态，没登记脚本不阻断部署",async t=>{
  const f=snapshotFixture(t,"console.log('snapshot broken');process.exit(7);"),task=await f.prepare();transition(task.dir,"completed","完成","ready",null);
  const r=await deploy(task.dir);assert.equal(r.result,"已部署");assert.equal(statusOf(task.dir).loop.phase,"已部署");assert.equal(checksOf(task.dir).filter(c=>c.step==="留痕" && c.result==="失败").length,2);
  const seq=statusOf(task.dir).seq,out=await comparison(task.dir);assert.equal(out.diff,"没有基线");assert.equal(statusOf(task.dir).seq,seq);
});
test("返修必修2：snapshot 输出目录不阻断陪跑、复测评审、部署和 dev 快进",async t=>{
  const f=snapshotFixture(t,"fs.mkdirSync(e.LOOP_SNAPSHOT_OUT);"),card={...f.raw,flow:["开发评审","测试","合入","部署"]};write(f.card,JSON.stringify(card));
  const task=await f.prepare(),before=statusOf(task.dir);await companion(task.dir);assert.equal(statusOf(task.dir).seq,before.seq);assert.equal(existsSync(join(task.dir,"snapshot-base.json")),false);
  write(join(task.worktree,"src/app.txt"),"good directory-output\n");const {commit}=deliver(task.dir);await settle(task.dir);assert.equal(statusOf(task.dir).loop.phase,"收尾中");
  await finish(task.dir);assert.equal(statusOf(task.dir).state,"completed");assert.equal(statusOf(task.dir).loop.phase,"已部署");assert.equal(f.git("rev-parse","dev^2"),commit);
  const failed=checksOf(task.dir).filter(c=>c.step==="留痕" && c.result==="失败");assert.equal(failed.length,4);assert.ok(failed.every(c=>/EISDIR|directory/.test(c.detail!)));
  assert.equal(existsSync(join(task.dir,"snapshot-"+commit+".json")),false);
});
test("返修必修2：异常输出清理再失败只追加失败记录，核心仍完成",async t=>{
  const f=snapshotFixture(t,"fs.mkdirSync(e.LOOP_SNAPSHOT_OUT);"),task=await f.prepare();write(join(task.worktree,"src/app.txt"),"good cleanup-failure\n");const {commit}=deliver(task.dir),out=join(task.dir,"snapshot-"+commit+".json"),original=fs.rmSync;let calls=0;
  t.mock.method(fs,"rmSync",(path: Parameters<typeof original>[0],options?: Parameters<typeof original>[1])=>{if(String(path)===out && ++calls>1)throw Object.assign(new Error("simulated output EACCES"),{code:"EACCES"});return original(path,options);});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await settle(task.dir);assert.equal(statusOf(task.dir).state,"completed");assert.ok(calls>=2);
  const failed=checksOf(task.dir).filter(c=>c.step==="留痕" && c.result==="失败");assert.equal(failed.length,1);assert.match(failed[0].detail!,/清理失败[\s\S]*EACCES/);
});
