import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { chmodSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { fixture, write, NODE, getJson, until } from "./helpers.ts";
import { deploy } from "../src/steps/deploy.ts";
import { deliver } from "../src/core/deliver.ts";
import { createTask, checksOf, statusOf, transition, type State } from "../src/core/store.ts";
import { loadDeploy, loadConfig } from "../src/infra/config.ts";
function script(name: string, body = "") {
  return "#!"+NODE+"\nconst fs=require('fs');fs.appendFileSync(process.env.LOOP_EVIDENCE_DIR+'/calls.jsonl',JSON.stringify({name:"+JSON.stringify(name)+",commit:process.env.LOOP_DEPLOY_COMMIT,repo:process.env.LOOP_REPO,evidence:process.env.LOOP_EVIDENCE_DIR,failed:process.env.LOOP_DEPLOY_FAILED,cwd:process.cwd()})+'\\n');console.log('stdout '+"+JSON.stringify(name)+");console.error('stderr '+"+JSON.stringify(name)+");\n"+body+"\n";
}
async function setup(t: Parameters<typeof fixture>[0], bodies: {cmd?: string; check?: string | false; rollback?: string | false} = {}) {
  const cfg={cmd:"scripts/deploy.sh",...(bodies.check===false?{}:{check:"scripts/check.sh"}),...(bodies.rollback===false?{}:{rollback:"scripts/rollback.sh"})};
  const f=fixture(t,{config:{deploy:cfg}});
  for(const name of ["cmd","check","rollback"] as const){
    const path=cfg[name];if(!path)continue;
    write(join(f.repo,path),script(name,typeof bodies[name]==="string"?bodies[name]:""));chmodSync(join(f.repo,path),0o755);
  }
  f.git("add",".");f.git("commit","-m","deployment scripts");const task=await f.prepare();
  transition(task.dir,"completed","完成","ready",null);return {...f,task,cfg};
}
const calls=(dir: string)=>readFileSync(join(dir,"calls.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
test("部署 A7：cmd/check 各一次、环境/日志正确、独立检出销毁，不改 dev/任务分支",async(t)=>{
  const f=await setup(t),before=f.git("rev-parse","dev"),trees=f.git("worktree","list","--porcelain");
  // 当前目录脚本变更不能替代 commit 中的脚本。
  write(join(f.repo,f.cfg.cmd),"#!/bin/sh\nexit 91\n");
  const r=JSON.parse((await f.cli(["部署",f.task.executionId,"--json"])).stdout);
  assert.equal(r.result,"已部署");assert.equal(r.commit,before);assert.equal(r.onDev,true);assert.equal(r.executionId,f.task.executionId);assert.ok(r.seconds>=0);
  assert.deepEqual(r.steps.map((s:any)=>[s.name,s.code,s.killed]),[["cmd",0,false],["check",0,false]]);assert.ok(r.steps.every((s:any)=>s.seconds>=0));
  const received=calls(r.evidenceDir);assert.deepEqual(received.map(x=>x.name),["cmd","check"]);
  for(const c of received){assert.equal(c.commit,before);assert.equal(c.repo,f.task.repo);assert.equal(c.evidence,r.evidenceDir);assert.equal(c.failed,undefined);assert.equal(existsSync(c.cwd),false);assert.equal(existsSync(dirname(c.cwd)),false);}
  assert.equal(f.git("worktree","list","--porcelain"),trees);assert.equal(f.git("rev-parse","dev"),before);assert.equal(f.git("rev-parse",f.task.branch),before);
  const log=readFileSync(r.log,"utf8");assert.match(log,/\$ scripts\/deploy.sh[\s\S]*stdout cmd[\s\S]*stderr cmd/);assert.match(log,/\$ scripts\/check.sh/);assert.match(log,/退出码 0/);
  assert.equal(statusOf(f.task.dir).loop.phase,"已部署");assert.equal(checksOf(f.task.dir).at(-1)!.step,"部署");assert.deepEqual(checksOf(f.task.dir).at(-1)!.evidence,[r.log,r.evidenceDir]);
  assert.match(readFileSync(join(f.task.dir,"summary.md"),"utf8"),/\| 部署 \| 已部署 \|/);assert.equal(existsSync(join(f.task.dir,"order")),false);assert.equal(existsSync(join(f.task.dir,"opened.json")),false);
});
test("部署 A8：check 失败自动 rollback 一次、FAILED=check、退出1、清理检出",async(t)=>{
  const f=await setup(t,{check:"process.exit(7);"});
  await assert.rejects(f.cli(["部署",f.task.executionId,"--json"]),(e:any)=>{
    assert.equal(e.code,1);const err=JSON.parse(e.stderr).error,r=err.result;assert.equal(err.category,"未知");assert.equal(r.result,"部署失败，已回退");
    assert.deepEqual(r.steps.map((x:any)=>[x.name,x.code]),[["cmd",0],["check",7],["rollback",0]]);
    const received=calls(r.evidenceDir);assert.deepEqual(received.map(x=>x.name),["cmd","check","rollback"]);assert.equal(received[2].failed,"check");assert.equal(existsSync(received[0].cwd),false);assert.match(err.raw,/退出码 7/);return true;
  });
  assert.equal(statusOf(f.task.dir).loop.phase,"部署失败");assert.equal(statusOf(f.task.dir).message,"已回退");
});
for(const [bodies,result,names] of [
  [{check:false,rollback:false},"已部署（未检查）",["cmd"]],
  [{cmd:"process.exit(8);"},"部署失败，已回退",["cmd","rollback"]],
  [{cmd:"process.exit(8);",rollback:"process.exit(9);"},"部署失败，回退也失败",["cmd","rollback"]],
  [{check:"process.exit(8);",rollback:false},"部署失败，未回退",["cmd","check"]],
] as const)test("部署结果："+result,async(t)=>{
  const f=await setup(t,bodies);let r;
  try{r=await deploy(f.task.dir);}catch(e:any){r=e.result;assert.equal(e.category,"未知");}
  assert.equal(r.result,result);assert.deepEqual(r.steps.map((s:any)=>s.name),names);
  const received=calls(r.evidenceDir);if((names as readonly string[]).includes("rollback"))assert.equal(received.at(-1).failed,"cmd");
  assert.equal(existsSync(received[0].cwd),false);
  if(result==="已部署（未检查）")assert.match(statusOf(f.task.dir).message,/未检查/);
});
test("部署：未登记/脚本不可执行/缺失均拒绝，不留记录或临时检出",async(t)=>{
  const plain=fixture(t),task=await plain.prepare(),count=checksOf(task.dir).length;
  await assert.rejects(deploy(task.dir),/项目没有登记部署脚本/);assert.equal(checksOf(task.dir).length,count);
  const f=await setup(t),before=f.git("worktree","list","--porcelain");
  chmodSync(join(f.repo,f.cfg.cmd),0o644);f.git("add",f.cfg.cmd);f.git("commit","-m","not executable");
  const length=checksOf(f.task.dir).length,seq=statusOf(f.task.dir).seq;
  await assert.rejects(deploy(f.task.dir),/脚本不存在或不可执行：scripts\/deploy.sh/);
  assert.equal(checksOf(f.task.dir).length,length);assert.equal(statusOf(f.task.dir).seq,seq);
  assert.equal(f.git("worktree","list","--porcelain").split("\n").filter(l=>l.startsWith("worktree ")).join("\n"),before.split("\n").filter(l=>l.startsWith("worktree ")).join("\n"));
  write(join(f.repo,".autoreview.json"),JSON.stringify({deploy:{cmd:"scripts/missing.sh"}}));
  await assert.rejects(deploy(f.task.dir),/脚本不存在或不可执行/);assert.equal(checksOf(f.task.dir).length,length);
});
test("部署：只运行仓库内普通可执行文件，软链接/目录不能作脚本",async(t)=>{
  const f=await setup(t);symlinkSync(f.cfg.cmd.split("/").at(-1)!,join(f.repo,"scripts/link.sh"));f.git("add","scripts/link.sh");f.git("commit","-m","symlink");
  for(const cmd of ["scripts/link.sh","scripts"]){write(join(f.repo,".autoreview.json"),JSON.stringify({deploy:{cmd}}));await assert.rejects(deploy(f.task.dir),/脚本不存在或不可执行/);}
  assert.equal(checksOf(f.task.dir).filter(c=>c.step==="部署").length,0);
});
test("部署：cmd 超时注入 200ms，按失败处理并删除临时检出",async(t)=>{
  const f=await setup(t,{cmd:"setInterval(()=>{},60000);",check:false,rollback:false}),before=f.git("worktree","list","--porcelain");
  await assert.rejects(deploy(f.task.dir,{timeoutMs:200}),(e:any)=>{
    const r=e.result;assert.equal(r.result,"部署失败，未回退");assert.deepEqual(r.steps.map((s:any)=>s.name),["cmd"]);assert.equal(r.steps[0].killed,true);assert.notEqual(r.steps[0].code,0);
    assert.match(readFileSync(r.log,"utf8"),/超时/);return true;
  });
  assert.equal(f.git("worktree","list","--porcelain"),before);
});
test("部署：cmd 超时仍自动回退一次，rollback 也超时则回退也失败",async(t)=>{
  const f=await setup(t,{cmd:"setInterval(()=>{},60000);",rollback:"setInterval(()=>{},60000);"});
  await assert.rejects(deploy(f.task.dir,{timeoutMs:200}),(e:any)=>{
    assert.equal(e.result.result,"部署失败，回退也失败");assert.deepEqual(e.result.steps.map((s:any)=>[s.name,s.killed]),[["cmd",true],["rollback",true]]);return true;
  });
});
test("部署配置：当前文件按需读取，错误不挡启动；路径/时限验证、默认20",async(t)=>{
  const f=fixture(t,{config:{deploy:{cmd:42}}});assert.doesNotThrow(()=>createTask(f.card,f.root));assert.equal(Object.hasOwn(loadConfig(f.repo),"deploy"),false);
  for(const value of [null,[],{}, {cmd:"../outside"},{cmd:"/absolute"},{cmd:".git/hook"},{cmd:"safe",check:""},{cmd:"safe",rollback:"../x"},
    ...[0,241,1.5,"20",null].map(timeoutMin=>({cmd:"safe",timeoutMin}))]){
    write(join(f.repo,".autoreview.json"),JSON.stringify({deploy:value}));assert.throws(()=>loadDeploy(f.repo),/\.autoreview.json 的 deploy 不合法/);
  }
  write(join(f.repo,".autoreview.json"),JSON.stringify({deploy:{cmd:"scripts/deploy.sh"}}));assert.equal(loadDeploy(f.repo)!.timeoutMin,20);
  write(join(f.repo,".autoreview.json"),JSON.stringify({deploy:{cmd:"scripts/deploy.sh",timeoutMin:240}}));assert.equal(loadDeploy(f.repo)!.timeoutMin,240);
  const task=await f.prepare();write(join(f.repo,".autoreview.json"),JSON.stringify({deploy:{cmd:"new-current.sh"}}));
  await assert.rejects(deploy(task.dir),/new-current.sh/);assert.equal(Object.hasOwn(getJson(join(task.dir,"task.json")).config,"deploy"),false);
});
test("部署：显式短 commit 不在 dev 上仍部署，只追加记录不改 working",async(t)=>{
  const f=await setup(t),before=f.git("rev-parse","dev");
  transition(f.task.dir,"working","开发中","develop", "developmentMs");write(join(f.task.worktree,"src/app.txt"),"good not on dev\n");const c=deliver(f.task.dir).commit,phase=statusOf(f.task.dir).loop.phase;
  const r=JSON.parse((await f.cli(["部署",f.task.executionId,"--commit",c.slice(0,9),"--json"])).stdout);
  assert.equal(r.commit,c);assert.equal(r.onDev,false);assert.equal(statusOf(f.task.dir).state,"working");assert.equal(statusOf(f.task.dir).loop.phase,phase);assert.equal(f.git("rev-parse","dev"),before);
  await assert.rejects(deploy(f.task.dir,{commit:"not-a-commit"}),/无法确定部署 commit/);
});
test("部署：同 commit 同秒重复仍执行，日志和证据各自保留",async(t)=>{
  const f=await setup(t,{check:false,rollback:false});t.mock.timers.enable({apis:["Date"],now:Date.now()});
  const a=await deploy(f.task.dir),b=await deploy(f.task.dir);
  assert.notEqual(a.evidenceDir,b.evidenceDir);assert.notEqual(a.log,b.log);
  assert.equal(calls(a.evidenceDir).length,1);assert.equal(calls(b.evidenceDir).length,1);
  assert.equal(checksOf(f.task.dir).filter(c=>c.step==="部署").length,2);
});
test("部署中阶段只更新 completed；脚本运行期间可查询，完成后正确记录",async(t)=>{
  const f=await setup(t,{cmd:"const ready=()=>{if(fs.existsSync(process.env.LOOP_EVIDENCE_DIR+'/go'))w.close();};const w=fs.watch(process.env.LOOP_EVIDENCE_DIR,ready);ready();",check:false,rollback:false});
  const active=deploy(f.task.dir);const s=await until(f.task.dir,()=>statusOf(f.task.dir),s=>s.loop.phase==="部署中");assert.equal(s.state,"completed");
  const {readdirSync}=await import("node:fs");const dir=await until(f.task.dir,()=>readdirSync(f.task.dir).find(n=>n.startsWith("deploy-")&&!n.endsWith(".log")),Boolean);
  await until(join(f.task.dir,dir!),()=>existsSync(join(f.task.dir,dir!,"calls.jsonl")),Boolean);write(join(f.task.dir,dir!,"go"),"");await active;assert.equal(statusOf(f.task.dir).loop.phase,"已部署");
});
