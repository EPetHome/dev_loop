import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, getJson, ROOT } from "./helpers.ts";
import { registerPi } from "../src/hosts/pi.ts";
import { handleHook } from "../src/hosts/hook.ts";
import { lastAssistantMessage, sessionIdOf } from "../src/hosts/hook-event.ts";
import { deliver } from "../src/core/deliver.ts";
import { statusOf, checksOf } from "../src/core/store.ts";
function fakePi(dir: string, cwd: string, reply: string) {
  const events: Record<string, any> = {}, messages: any[] = [], callbacks: (()=>void)[] = [];
  let cleared = 0, interval = 0;
  const pi = {on: (name: string, handler: any) => {events[name] = handler;}, sendMessage: (m: any) => messages.push(m)};
  const ctx = {cwd,sessionManager:{getSessionId:()=>"fake-pi",getSessionFile:()=>join(dir,"session.jsonl"),
    getBranch:()=>[{message:{role:"assistant",content:[{type:"text",text:reply}]}}]}};
  registerPi(pi, {env:{LOOP_TASK_DIR:dir},every:(cb,ms)=>{callbacks.push(cb);interval=ms;return {unref(){}};},clear:()=>{cleared++;}});
  return {events,ctx,messages,callbacks,get cleared(){return cleared;},get interval(){return interval;}};
}
for (const host of ["pi","claude","codex"]) {
  test("A2 宿主 " + host + "：成功路径写两条检查记录", async (t) => {
    const f=fixture(t), task=await f.prepare();
    write(join(task.worktree,"src/app.txt"),"good "+host+"\n");const d=deliver(task.dir);
    if(host==="pi") {
      const p=fakePi(task.dir,task.worktree,"已交付");
      p.events.session_start({},p.ctx);
      assert.match(p.messages[0].content,new RegExp(ROOT+"/bin/loop 交付"));
      assert.equal(p.interval,60000);
      assert.equal(await p.events.agent_before_settle({},p.ctx),undefined);
      const seq=statusOf(task.dir).seq;p.callbacks[0]();
      assert.equal(statusOf(task.dir).seq,seq); // 已完成不再心跳。
      p.events.session_shutdown({},p.ctx);assert.equal(p.cleared,1);
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
