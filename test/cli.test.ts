import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, until, getJson, ROOT, NODE } from "./helpers.ts";
import { statusOf, checksOf, taskOf } from "../src/core/store.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { resume, stop } from "../src/core/lifecycle.ts";
import { execFileSync } from "node:child_process";
test("A1：启动先返回回执/status，后台 worktree、localFiles、setup、会话",async(t)=>{
  const f=fixture(t,{config:{setup:"node setup.cjs"}});
  write(join(f.repo,"setup.cjs"),'const fs=require("fs");const p=process.env.LOOP_TASK_DIR;fs.writeFileSync(p+"/setup-started","yes");const done=()=>{if(fs.existsSync(p+"/release-setup")){w.close();process.exit(0);}};const w=fs.watch(p,done);done();\n');
  f.git("add","setup.cjs");f.git("commit","-m","controlled setup");
  const start=performance.now(), receipt=JSON.parse((await f.cli(["启动",f.card,"--派单编号","PA-1","--指令编号","start-1","--json"])).stdout);
  assert.ok(performance.now()-start<5000,"回执不等待 setup");assert.match(receipt.executionId,/^[A-Za-z0-9_-]+-[a-f0-9]{6}$/);
  const dir=receipt.taskDir;assert.equal(statusOf(dir).state,"working");assert.equal(statusOf(dir).dispatchId,"PA-1");
  await until(dir,()=>existsSync(join(dir,"setup-started")),Boolean);
  assert.equal(existsSync(join(dir,"opened.json")),false);
  const task=taskOf(dir);assert.ok(existsSync(join(task.worktree,".git")));
  assert.equal(f.git("show-ref","--verify","refs/heads/"+task.branch).split(" ")[0],task.baseCommit);
  assert.equal(readFileSync(join(task.worktree,"local.txt"),"utf8"),"local secret fixture\n");
  write(join(dir,"release-setup"),"go");
  const opened=await until(dir,()=>getJson(join(dir,"opened.json")),v=>Boolean(v.task));
  assert.equal(opened.cwd,task.worktree);assert.equal(opened.task,dir);
  assert.match(readFileSync(join(dir,"developer-prompt.md"),"utf8"),new RegExp(ROOT+"/bin/loop 交付"));
  const second=JSON.parse((await f.cli(["启动",f.card,"--指令编号","start-1","--json"])).stdout);
  assert.equal(second.executionId,receipt.executionId);assert.equal(readdirSync(f.root).filter(n=>!n.endsWith(".lock")).length,1);
});
test("A5：原目录规则、聊天、忽略产物与证据丢失都不作废；查询/停下/续跑沿用",async(t)=>{
  const f=fixture(t),task=await f.prepare();write(join(task.worktree,"src/app.txt"),"good delivered\n");const d=deliver(task.dir);
  await settle(task.dir);const order=readFileSync(join(task.dir,"order"),"utf8");
  write(join(f.repo,"AGENTS.md"),"新的原目录规则");write(join(task.worktree,"dist/app.js"),"build");
  for(const c of checksOf(task.dir))for(const path of c.evidence)rmSync(path,{force:true});
  const q=JSON.parse((await f.cli(["查询","--all","--brief","--json"])).stdout);
  assert.equal(q.complete,true);assert.equal(q.executions[0].state,"completed");
  await settle(task.dir,"完成了吗？");const resumed=resume(task.dir);assert.equal(resumed.reused,true);
  assert.equal(statusOf(task.dir).state,"completed");assert.equal(statusOf(task.dir).loop.commit,d.commit);
  assert.equal(readFileSync(join(task.dir,"order"),"utf8"),order);assert.match(readFileSync(join(task.dir,"summary.md"),"utf8"),/沿用/);
});
test("A6 CLI：环境变量优先，cwd 回退定位，越界命令失败不提交",async(t)=>{
  const f=fixture(t),task=await f.prepare(),before=f.git("rev-parse",task.branch);
  write(join(task.worktree,"outside.txt"),"out of scope");
  await assert.rejects(f.cli(["交付","--json"],task.worktree),e=>{assert.match(String((e as any).stderr),/outside.txt/);return true;});
  assert.equal(f.git("rev-parse",task.branch),before);
  execFileSync("git",["restore","outside.txt"],{cwd:task.worktree});
  write(join(task.worktree,"src/new file.txt"),"good");
  const delivered=JSON.parse((await f.cli(["交付","--说明","通过 env 交付","--json"],f.repo,{LOOP_TASK_DIR:task.dir})).stdout);
  assert.ok(delivered.commit);assert.equal(statusOf(task.dir).loop.delivery?.note,"通过 env 交付");
});
test("A9：完整列表、PA 全字段、seq 单调、总结一屏、task 只写一次",async(t)=>{
  const f=fixture(t),a=await f.prepare(),b=await f.prepare(),initial=readFileSync(join(a.dir,"task.json"),"utf8"),before=statusOf(a.dir).seq;
  write(join(a.worktree,"src/app.txt"),"good a");deliver(a.dir);await settle(a.dir);
  const q=JSON.parse((await f.cli(["查询","--all","--brief","--json"])).stdout);
  assert.equal(q.complete,true);assert.equal(q.executions.length,2);
  for(const s of q.executions){
    for(const field of ["protocol","source","executionId","dispatchId","batchId","state","message","updatedAt","seq","generation","heartbeatSec","timeLimitSec","refs","error","evidence","actions","loop"])assert.ok(Object.hasOwn(s,field),field);
    assert.equal(s.protocol,"loop-status/1");assert.ok(["working","input_required","completed","failed","cancelled"].includes(s.state));
    assert.deepEqual(Object.keys(s.loop.durations).sort(),["developmentMs","inputMs","reviewMs","selfMs","testMs"]);
  }
  assert.ok(statusOf(a.dir).seq>before);assert.equal(readFileSync(join(a.dir,"task.json"),"utf8"),initial);
  const sum=readFileSync(join(a.dir,"summary.md"),"utf8");
  assert.ok(sum.trim().split("\n").length<=20);
  for(const label of ["开发","复测","评审","等你","dev-loop 自身"])assert.ok(sum.includes(label));
  assert.equal(statusOf(b.dir).state,"working");
});
for(const [label,change,pattern] of [
  ["多任务",(r:any)=>{r.tasks.push({...r.tasks[0],name:"second"});},/多任务.*第 3 步/],
  ["提交",(r:any)=>{r.flow.push("提交");},/flow 不写提交：请改写合入，提交已由 bin\/loop 交付完成/],
  ["验收",(r:any)=>{r.flow.push("验收");},/验收.*第 3 步/],
  ["部署登记",(r:any)=>{r.flow.push("合入","部署");},/自动部署须登记 deploy.cmd、check、rollback/],
] as const) test("A10："+label+"启动明确拒绝，不建执行目录",async(t)=>{
  const f=fixture(t);change(f.raw);write(f.card,JSON.stringify(f.raw));
  await assert.rejects(f.cli(["启动",f.card,"--json"]),e=>{assert.match((e as any).stderr,pattern);return true;});
  assert.deepEqual(readdirSync(f.root),[]);
});
test("帮助：合入可选推送、部署配置与参数可见",async(t)=>{
  const f=fixture(t),help=(await f.cli(["帮助"])).stdout;
  assert.match(help,/合入 <执行编号或卡路径> \[--commit <sha>\] \[--接受未验证\] \[--推送\]/);
  assert.match(help,/部署 <执行编号或卡路径> \[--commit <sha>\]/);assert.match(help,/默认仅本地/);assert.match(help,/deploy.cmd/);
});
test("停止/续跑/放弃：沿用执行号，保留分支证据，删除 worktree",async(t)=>{
  const f=fixture(t),task=await f.prepare(),id=task.executionId;
  const stopped=JSON.parse((await f.cli(["停止",id,"--json"])).stdout);assert.equal(stopped.state,"cancelled");
  const resumed=JSON.parse((await f.cli(["续跑",id,"--json"])).stdout);assert.equal(resumed.executionId,id);
  await until(task.dir,()=>existsSync(join(task.dir,"opened.json")),Boolean);
  assert.equal(statusOf(task.dir).state,"working");
  await until(task.dir,()=>statusOf(task.dir),s=>s.loop.launcher===null);
  const abandoned=JSON.parse((await f.cli(["放弃",id,"--json"])).stdout);
  assert.equal(abandoned.state,"cancelled");assert.equal(existsSync(task.worktree),false);
  assert.ok(f.git("show-ref","--verify","refs/heads/"+task.branch));assert.ok(existsSync(join(task.dir,"checks.jsonl")));
  await assert.rejects(f.cli(["续跑",id,"--json"]),/Command failed/);
});
test("bin/pi-dev：sol/max、权限扩展及自己的扩展，精确恢复参数，无真实模型调用",async(t)=>{
  const f=fixture(t);
  const text=execFileSync(join(ROOT,"bin/pi-dev"),["--cwd",f.repo,"--dry-run",join(f.repo,"prompt.md")],{env:f.env,encoding:"utf8"});
  assert.match(text,/--model openai-codex\/gpt-6\.2-sol/);assert.match(text,/--thinking max/);assert.match(text,/pi-permission-system/);
  assert.match(text,/src\/hosts\/pi.ts/);assert.match(text,/--no-extensions/);assert.doesNotMatch(text,/ponytail|autoreview.ts/);
  const resumed=execFileSync(join(ROOT,"bin/pi-dev"),["--cwd",f.repo,"--session","exact-id","--dry-run"],{env:f.env,encoding:"utf8"});
  assert.match(resumed,/--session exact-id/);assert.doesNotMatch(resumed,/--continue/);
});
