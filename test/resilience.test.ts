import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fixture, write, sq, PASS, MUST, until, getJson, NODE, ROOT } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { createTask, statusOf, checksOf, update, checked } from "../src/core/store.ts";
import { resume, heartbeat } from "../src/core/lifecycle.ts";
import { lock, BusyError } from "../src/infra/files.ts";
import { createChildExec } from "../src/infra/exec.ts";

test("复测默认上限 3 次：连续失败转等你，不会调用评审",async(t)=>{
  const f=fixture(t),task=await f.prepare();
  for(let i=1;i<=3;i++){
    write(join(task.worktree,"src/app.txt"),"bad "+i+"\n");deliver(task.dir);
    assert.equal((await settle(task.dir)).continue,i<3);
  }
  const s=statusOf(task.dir);assert.equal(s.loop.testReturns,3);assert.equal(s.loop.reviewReturns,0);
  assert.equal(s.state,"input_required");assert.match(s.message,/复测退回 3 次/);assert.equal(s.loop.wait,"复测退回到上限");
  assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\ntest\ntest\n");
  assert.equal(resume(task.dir).reused,false);assert.equal(statusOf(task.dir).loop.testAllowance,4);assert.equal(statusOf(task.dir).loop.wait,null);
  write(join(task.worktree,"src/app.txt"),"good fixed\n");deliver(task.dir);await settle(task.dir);
  assert.equal(statusOf(task.dir).state,"completed");
});
test("评审默认上限 4 次；复测退回不消耗评审必修限额",async(t)=>{
  const f=fixture(t,{reviewer:"printf %s "+sq(MUST)}),task=await f.prepare();
  for(let i=1;i<=4;i++){
    write(join(task.worktree,"src/app.txt"),"good "+i+"\n");deliver(task.dir);
    assert.equal((await settle(task.dir)).continue,i<4);
  }
  const s=statusOf(task.dir);assert.equal(s.state,"input_required");assert.equal(s.loop.reviewReturns,4);assert.equal(s.loop.testReturns,0);
});
test("无测试：记录没验证，继续评审；不伪造测试通过",async(t)=>{
  const f=fixture(t,{test:"无：文档变更无可运行测试"}),task=await f.prepare();deliver(task.dir);await settle(task.dir);
  assert.equal(statusOf(task.dir).state,"completed");assert.match(statusOf(task.dir).message,/没验证/);
  assert.deepEqual(checksOf(task.dir).filter(c=>["复测","评审"].includes(c.step)).map(c=>c.result),["没验证","通过"]);
  assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"review\n");
});
test("评审调用失败重试一次；原始报错及成功原文都保留",async(t)=>{
  const body='if [ ! -e "$LOOP_TASK_DIR/attempt" ]; then touch "$LOOP_TASK_DIR/attempt"; echo "network original failure" >&2; exit 7; fi; printf %s '+sq(PASS);
  const f=fixture(t,{reviewer:body}),task=await f.prepare();deliver(task.dir);await settle(task.dir);
  assert.equal(statusOf(task.dir).state,"completed");assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\nreview\nreview\n");
  const c=checksOf(task.dir).find(c=>c.step==="评审")!;assert.equal(c.evidence.length,2);
  assert.match(readFileSync(c.evidence[0],"utf8"),/network original failure/);assert.match(readFileSync(c.evidence[1],"utf8"),/## 必修/);
});
test("连续调用失败和残缺输出都归临时故障，不放行",async(t)=>{
  const f=fixture(t,{reviewer:'echo "network failure, raw detail" >&2; exit 9'}),task=await f.prepare();deliver(task.dir);await settle(task.dir);
  let s=statusOf(task.dir);assert.equal(s.state,"failed");assert.equal(s.error?.category,"临时故障");assert.match(s.error!.raw,/network failure, raw detail/);
  assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\nreview\nreview\n");
  // 同一临时仓库的新执行验证结构残缺也不会被当作「无必修」。
  write(join(f.repo,"reviewer.sh"),"#!/bin/sh\nprintf '## 必修\\n- src/app.txt:1 触发：bad\\n'\n");
  f.git("add","reviewer.sh");f.git("commit","-m","malformed reviewer");
  const other=await f.prepare();deliver(other.dir);await settle(other.dir);s=statusOf(other.dir);
  assert.equal(s.state,"failed");assert.equal(s.error?.category,"临时故障");assert.equal(checked(other.dir,statusOf(other.dir).loop.commit!),false);
});
test("并发停下仅执行一圈；锁忙不重复检查",async(t)=>{
  const f=fixture(t,{test:"node controlled.cjs"});
  write(join(f.repo,"controlled.cjs"),'const fs=require("fs"),p=process.env.LOOP_TASK_DIR;fs.appendFileSync(p+"/order","test\\n");fs.writeFileSync(p+"/started","yes");const w=fs.watch(p,()=>{if(fs.existsSync(p+"/release")){w.close();process.exit(0);}});\n');
  f.git("add","controlled.cjs");f.git("commit","-m","controlled test");
  const task=await f.prepare();deliver(task.dir);
  const first=settle(task.dir);await until(task.dir,()=>existsSync(join(task.dir,"started")),Boolean);
  const duplicate=await settle(task.dir);assert.equal(duplicate.continue,false);assert.match(duplicate.reason,/正在处理中/);
  write(join(task.dir,"release"),"go");await first;
  assert.equal(statusOf(task.dir).state,"completed");assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\nreview\n");
});
test("运行中停止：结束复测进程，取消状态不被异步完成覆盖",async(t)=>{
  const f=fixture(t,{test:"node hold.cjs"});
  write(join(f.repo,"hold.cjs"),'require("fs").writeFileSync(process.env.LOOP_TASK_DIR+"/started","yes");setInterval(()=>{},60000);');
  f.git("add","hold.cjs");f.git("commit","-m","held test");
  const task=await f.prepare();deliver(task.dir);const active=settle(task.dir);
  await until(task.dir,()=>existsSync(join(task.dir,"started")),Boolean);
  await f.cli(["停止",task.executionId,"--json"]);await active;
  const s=statusOf(task.dir);assert.equal(s.state,"cancelled");assert.equal(s.loop.reviewRounds,0);
  assert.equal(checksOf(task.dir).filter(c=>c.step==="复测").at(-1)?.result,"已停止");
  assert.equal(existsSync(join(task.dir,"order")),false);
});
test("无交付有改动仅提醒一次；第二次停下转等你",async(t)=>{
  const f=fixture(t),task=await f.prepare();write(join(task.worktree,"src/app.txt"),"good changed");
  assert.equal((await settle(task.dir)).continue,true);assert.equal(statusOf(task.dir).state,"working");
  assert.equal((await settle(task.dir,"没有更多可做")).continue,false);assert.equal(statusOf(task.dir).state,"input_required");
  assert.equal(statusOf(task.dir).message,"没有更多可做");assert.equal(statusOf(task.dir).loop.testReturns,0);
});
test("提示词或验收标准哈希变化会重查；日志不是判定条件",async(t)=>{
  const f=fixture(t),task=await f.prepare();deliver(task.dir);await settle(task.dir);const commit=statusOf(task.dir).loop.commit!;
  assert.equal(checked(task.dir,commit),true);write(join(f.repo,"prompt.md"),"新的需求原文");
  assert.equal(checked(task.dir,commit),false);deliver(task.dir);await settle(task.dir);
  assert.equal(statusOf(task.dir).state,"completed");assert.equal(statusOf(task.dir).loop.reviewRounds,2);
  write(join(f.repo,"criteria.md"),"A1. 操作：新增场景\n预期：新的标准");
  assert.equal(checked(task.dir,commit),false);await settle(task.dir);
  assert.equal(statusOf(task.dir).loop.reviewRounds,3);
});
test("两进程状态并发更新，seq 不丢增量；死进程的操作锁可恢复",async(t)=>{
  const f=fixture(t),task=await f.prepare(),before=statusOf(task.dir).seq;
  const code='const {update}=await import('+JSON.stringify(join(ROOT,"src/core/store.ts"))+');for(let i=0;i<8;i++)update(process.argv[1],()=>{});';
  const children=Array.from({length:3},()=>spawn(NODE,["--input-type=module","-e",code,task.dir],{stdio:["ignore","pipe","pipe"]}));
  const results=await Promise.all(children.map(c=>once(c,"close")));assert.ok(results.every(([code])=>code===0));
  assert.equal(statusOf(task.dir).seq,before+24);
  const path=join(f.base,"dead.lock");
  execFileSync(NODE,["--input-type=module","-e",'const {lock}=await import('+JSON.stringify(join(ROOT,"src/infra/files.ts"))+');lock(process.argv[1]);',path]);
  const release=lock(path);assert.throws(()=>lock(path),BusyError);release();assert.equal(existsSync(path),false);
});
test("子进程中文长输出跨块仍保留原文",async(t)=>{
  const f=fixture(t),value="错误✓".repeat(50000),exec=createChildExec();
  const result=await exec(NODE,["-e",'process.stdout.write("错误✓".repeat(50000))'],{cwd:f.repo,timeoutMs:10000});
  assert.equal(result.code,0);assert.equal(result.stdout,value);assert.equal(result.output,value);
});
test("子进程整组取消与时限：不使用固定 sleep 等待",async(t)=>{
  const f=fixture(t),controller=new AbortController(),exec=createChildExec(),marker=join(f.base,"child.json");
  const script='const {spawn}=require("child_process"),fs=require("fs");const c=spawn(process.execPath,["-e","setInterval(()=>{},60000)"]);fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},60000);';
  const running=exec(NODE,["-e",script,marker],{cwd:f.repo,timeoutMs:10000,signal:controller.signal});
  await until(f.base,()=>getJson(marker),v=>Boolean(v.child));controller.abort();assert.equal((await running).killed,true);
  const timed=await exec(NODE,["-e","setInterval(()=>{},60000)"],{cwd:f.repo,timeoutMs:25});
  assert.equal(timed.killed,true);assert.notEqual(timed.code,0);
});
test("setup 失败如实记 failed，原文保留；卡错误不建执行",async(t)=>{
  const f=fixture(t,{config:{setup:'echo "setup original error" >&2; exit 3'}});
  const receipt=JSON.parse((await f.cli(["启动",f.card,"--json"])).stdout);
  const s=await until(receipt.taskDir,()=>statusOf(receipt.taskDir),s=>s.state==="failed");
  assert.match(s.error!.raw,/setup original error/);assert.equal(existsSync(join(receipt.taskDir,"opened.json")),false);
  const bad={...f.raw, tasks:[{...f.raw.tasks[0],scope:["../bad"]}]};write(f.card,JSON.stringify(bad));
  const before=readdirSync(f.root).length;assert.throws(()=>createTask(f.card,f.root),/scope/);assert.equal(readdirSync(f.root).length,before);
});
test("开发耗时不被心跳截短，自身推进另计时并留记录",async(t)=>{
  const f=fixture(t),task=await f.prepare();
  t.mock.timers.enable({apis:["Date"],now:statusOf(task.dir).loop.stepStartedAt});
  t.mock.timers.tick(1000);heartbeat(task.dir);t.mock.timers.tick(2500);
  write(join(task.worktree,"src/app.txt"),"good timed");deliver(task.dir);
  assert.equal(checksOf(task.dir).filter(c=>c.step==="开发").at(-1)?.durationMs,3500);
  assert.equal(statusOf(task.dir).loop.durations.developmentMs,3500);
  t.mock.timers.reset();await settle(task.dir);
  assert.ok(checksOf(task.dir).some(c=>c.step==="dev-loop 自身" && c.result==="推进"));
  assert.ok(statusOf(task.dir).loop.durations.selfMs>0);
});
test("需求哈希变化后的评审发送完整 diff，而非空的返修增量",async(t)=>{
  const f=fixture(t),task=await f.prepare();
  write(join(task.worktree,"src/app.txt"),"good delivered change\n");deliver(task.dir);await settle(task.dir);
  write(join(f.repo,"prompt.md"),"新增需求必须重新核对先前改动");deliver(task.dir);await settle(task.dir);
  const input=readFileSync(join(task.dir,"review-input-r2.md"),"utf8");
  assert.match(input,/需求已变化/);assert.match(input,/-good\n/);assert.match(input,/\+good delivered change/);
  assert.equal(statusOf(task.dir).state,"completed");
});
test("项目配置错误归输入问题，不创建执行目录",async(t)=>{
  const f=fixture(t);write(join(f.repo,".autoreview.json"),'{"localFiles":["../escape"]}');
  await assert.rejects(f.cli(["启动",f.card,"--json"]),e=>{assert.match((e as any).stderr,/"category":"输入问题"/);return true;});
  assert.deepEqual(readdirSync(f.root),[]);
});
test("默认评审调用只读、新上下文、astra/xhigh；不会加载旧 loop 或开发扩展",async(t)=>{
  const f=fixture(t,{config:{reviewerCmd:""}}),task=await f.prepare(),bin=join(f.base,"fake-pi.cjs"),old=process.env.PI_BIN;
  write(bin,"#!"+NODE+'\nconst fs=require("fs");fs.writeFileSync(process.env.LOOP_TASK_DIR+"/review-argv.json",JSON.stringify(process.argv.slice(2)));console.log('+JSON.stringify(PASS)+');\n');
  execFileSync("chmod",["+x",bin]);process.env.PI_BIN=bin;
  try {deliver(task.dir);await settle(task.dir);} finally {if(old===undefined)delete process.env.PI_BIN;else process.env.PI_BIN=old;}
  const args=getJson<string[]>(join(task.dir,"review-argv.json"));
  assert.equal(args[args.indexOf("--model")+1],"astra");assert.equal(args[args.indexOf("--thinking")+1],"xhigh");
  assert.equal(args[args.indexOf("--tools")+1],"read,grep,find,ls");
  for(const flag of ["-p","--session-id","--no-extensions","--no-context-files","--no-mcp","--append-system-prompt"])assert.ok(args.includes(flag));
  assert.ok(args.includes(join(ROOT,"src/core/review-prompt.md")));
});
