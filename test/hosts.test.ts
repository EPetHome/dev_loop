import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, getJson, ROOT, until, PASS, sq } from "./helpers.ts";
import { registerPi } from "../src/hosts/pi.ts";
import { handleHook } from "../src/hosts/hook.ts";
import { lastAssistantMessage, sessionIdOf } from "../src/hosts/hook-event.ts";
import { deliver } from "../src/core/deliver.ts";
import { statusOf, checksOf, transition, update } from "../src/core/store.ts";
function fakePi(dir: string, cwd: string, reply: string) {
  const events: Record<string, any> = {}, messages: any[] = [], callbacks: (()=>void)[] = [];
  let cleared = 0;
  const intervals: number[] = [], statuses: (string | undefined)[] = [], titles: string[] = [];
  const pi = {on: (name: string, handler: any) => {events[name] = handler;}, sendMessage: (m: any) => messages.push(m)};
  const ctx = {cwd,sessionManager:{getSessionId:()=>"fake-pi",getSessionFile:()=>join(dir,"session.jsonl"),
    getBranch:()=>[{message:{role:"assistant",content:[{type:"text",text:reply}]}}]},
    ui: {setStatus(key: string, text?: string) {assert.equal(key,"dev-loop");statuses.push(text);},setTitle(title: string) {titles.push(title);}}};
  registerPi(pi, {env:{LOOP_TASK_DIR:dir},every:(cb,ms)=>{callbacks.push(cb);intervals.push(ms);return {unref(){}};},clear:()=>{cleared++;}});
  return {events,ctx,messages,callbacks,intervals,statuses,titles,get cleared(){return cleared;}};
}
for (const host of ["pi","claude","codex"]) {
  test("A2 宿主 " + host + "：成功路径写两条检查记录", async (t) => {
    const f=fixture(t), task=await f.prepare();
    write(join(task.worktree,"src/app.txt"),"good "+host+"\n");const d=deliver(task.dir);
    if(host==="pi") {
      const p=fakePi(task.dir,task.worktree,"已交付");
      p.events.session_start({},p.ctx);
      assert.match(p.messages[0].content,new RegExp(ROOT+"/bin/loop 交付"));
      assert.deepEqual(p.intervals,[60000,1000]);
      assert.equal(await p.events.agent_before_settle({},p.ctx),undefined);
      const seq=statusOf(task.dir).seq;p.callbacks[0]();
      assert.equal(statusOf(task.dir).seq,seq); // 已完成不再心跳。
      p.events.session_shutdown({},p.ctx);assert.equal(p.cleared,2);
    } else {
      const env={...f.env,LOOP_TASK_DIR:task.dir,LOOP_HOST:host};
      await handleHook({cwd:task.worktree,session_id:"fake-"+host,session_pid:process.pid},"SessionStart",env);
      const seq=statusOf(task.dir).seq;
      assert.equal(await handleHook({cwd:task.worktree},"UserPromptSubmit",env),"");
      assert.equal(statusOf(task.dir).seq,seq);
      assert.equal(await handleHook({cwd:task.worktree,last_assistant_message:"已交付"},"Stop",env),"");
    }
    const s=statusOf(task.dir);
    assert.equal(s.state,"completed");assert.equal(s.loop.session?.host,host);assert.equal(s.loop.session?.pid,process.pid);
    assert.ok(s.loop.session?.startedAt);
    assert.deepEqual(checksOf(task.dir).filter(c=>c.commit===d.commit && ["复测","评审"].includes(c.step)).map(c=>c.result),["通过","通过"]);
    assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\nreview\n");
  });
  test("A3 宿主 " + host + "：测试失败阻止停下",async(t)=>{
    const f=fixture(t),task=await f.prepare();write(join(task.worktree,"src/app.txt"),"bad\n");deliver(task.dir);
    let reason:string;
    if(host==="pi") {
      const p=fakePi(task.dir,task.worktree,"交付完成");p.events.session_start({},p.ctx);
      const r=await p.events.agent_before_settle({},p.ctx);assert.equal(r.continue,true);
      assert.equal(r.entries[0].type,"custom_message");reason=r.entries[0].content;p.events.session_shutdown({},p.ctx);
    }else{
      const r=JSON.parse(await handleHook({cwd:task.worktree,last_assistant_message:"已交付"},"Stop",{...f.env,LOOP_HOST:host}));
      assert.equal(r.decision,"block");reason=r.reason;
    }
    assert.match(reason,/命令：[\s\S]*输出最后 60 行：[\s\S]*error\/fail 行：/);
    assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\n");
  });
}
test("A8：pi 使用最后助手消息；Claude/Codex JSONL 回退兼容",async(t)=>{
  const f=fixture(t),task=await f.prepare(),p=fakePi(task.dir,task.worktree,"需要你确认输入数据");
  p.events.session_start({},p.ctx);await p.events.agent_before_settle({},p.ctx);
  assert.equal(statusOf(task.dir).message,"需要你确认输入数据");p.events.session_shutdown({},p.ctx);
  const transcript=join(f.base,"transcript.jsonl");
  write(transcript,[{type:"assistant",message:{role:"assistant",content:[{type:"text",text:"claude answer"}]}},
    {type:"response_item",payload:{role:"assistant",content:[{type:"output_text",text:"codex final"}]}}].map(x=>JSON.stringify(x)).join("\n"));
  assert.equal(lastAssistantMessage({transcript_path:transcript}),"codex final");
  assert.equal(lastAssistantMessage({transcript_path:transcript,last_assistant_message:"direct"}),"direct");
  assert.equal(sessionIdOf({transcript_path:transcript}),"transcript");
  assert.equal(existsSync(join(task.dir,"order")),false);
});
test("阶段 A9：pi 已交付→复测中→评审中→完成，外部变更下一次刷新可见",async(t)=>{
  const hold='const fs=require("fs"),p=process.env.LOOP_TASK_DIR,k=process.argv[2];fs.writeFileSync(p+"/"+k+"-started","");const w=fs.watch(p,()=>{if(fs.existsSync(p+"/"+k+"-go")){w.close();}});';
  const f=fixture(t,{test:'node hold.cjs test',reviewer:'node hold.cjs review; printf %s '+sq(PASS)});
  write(join(f.repo,"hold.cjs"),hold);f.git("add","hold.cjs");f.git("commit","-m","controlled phases");
  const task=await f.prepare(),p=fakePi(task.dir,task.worktree,"");p.events.session_start({},p.ctx);
  deliver(task.dir);p.callbacks[1]();const active=p.events.agent_before_settle({},p.ctx);
  await until(task.dir,()=>existsSync(join(task.dir,"test-started")),Boolean);p.callbacks[1]();write(join(task.dir,"test-go"),"");
  await until(task.dir,()=>existsSync(join(task.dir,"review-started")),Boolean);p.callbacks[1]();write(join(task.dir,"review-go"),"");await active;
  assert.deepEqual(p.statuses,["dev-loop【开发中】task","dev-loop【已交付】task","dev-loop【复测中】task","dev-loop【评审中】task · 第 1 轮","dev-loop【完成】task"]);
  assert.deepEqual(p.titles,["【开发中】task","【已交付】task","【复测中】task","【评审中】task","【完成】task"]);
  p.callbacks[1]();assert.equal(p.statuses.length,5);
  transition(task.dir,"completed","已合入","abc1234，未验证",null);p.callbacks[1]();assert.equal(p.statuses.at(-1),"dev-loop【已合入】task · abc1234，未验证");
  update(task.dir,s=>{s.loop.phase="等你";s.message="旧执行原因\n后文";delete s.loop.wait;});p.callbacks[1]();assert.match(p.statuses.at(-1)!,/ · 旧执行原因$/);
  const saved=readFileSync(join(task.dir,"status.json"),"utf8");
  write(join(task.dir,"status.json"),"bad json");assert.doesNotThrow(()=>p.callbacks[1]());assert.match(p.statuses.at(-1)!,/旧执行原因$/);
  write(join(task.dir,"status.json"),saved);p.events.session_shutdown();assert.equal(p.statuses.at(-1),undefined);
});
test("阶段显示：无 ui / hasUI=false 不影响宿主，关闭清理状态",async(t)=>{
  const f=fixture(t),task=await f.prepare(),p=fakePi(task.dir,task.worktree,"");
  p.events.session_start({}, {...p.ctx,hasUI:false});p.callbacks[1]();assert.deepEqual(p.statuses,[]);p.events.session_shutdown();assert.deepEqual(p.statuses,[]);
  p.events.session_start({}, {...p.ctx,ui:undefined});assert.doesNotThrow(()=>p.callbacks.at(-1)!());p.events.session_shutdown();
  p.events.session_start({},p.ctx);p.events.session_shutdown();assert.equal(p.statuses.at(-1),undefined);
});
test("A9：pi 心跳只在 working；Hook 心跳至少间隔 60 秒",async(t)=>{
  const f=fixture(t),task=await f.prepare(),p=fakePi(task.dir,task.worktree,"");
  p.events.session_start({},p.ctx);const seq=statusOf(task.dir).seq;p.callbacks[0]();
  assert.equal(statusOf(task.dir).seq,seq+1);p.events.session_shutdown({},p.ctx);
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  const env={...f.env,LOOP_TASK_DIR:task.dir};
  await handleHook({cwd:task.worktree,session_pid:process.pid},"SessionStart",env);
  const before=statusOf(task.dir).seq;
  await handleHook({cwd:task.worktree},"PostToolUse",env);assert.equal(statusOf(task.dir).seq,before);
  t.mock.timers.tick(60001);
  await handleHook({cwd:task.worktree},"PostToolUse",env);assert.equal(statusOf(task.dir).seq,before+1);
});
