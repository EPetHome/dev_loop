import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, until, write, sq, MUST, PASS, getJson, ROOT, NODE, writeFixtureScript } from "./helpers.ts";
import { Ledger, locked, PHASES, type Task } from "../src/core/store.ts";
import { jsonLines } from "../src/infra/files.ts";
import { gitText } from "../src/infra/git.ts";
import { state } from "../src/core/state.ts";
import { decide } from "../src/cli/tick.ts";
import { timerPlist } from "../src/cli/inspect.ts";
const fgit=(t:Task,...args:string[])=>gitText(t.worktree,args);
const stat=(l:Ledger)=>state(l), append=(path:string,value:any)=>appendFileSync(path,JSON.stringify(value)+"\n");
async function control(t:Task,fields:any) {
  const pid=stat(new Ledger(t.dir)).window?.owner?.pid, id=randomUUID();assert(pid);
  append(join(t.dir,"window-control.jsonl"),{id,pid,...fields});
  if (fields.type==="close") await until(t.dir,()=>stat(new Ledger(t.dir)).windowLive,v=>!v);
  else await until(t.dir,()=>jsonLines<any>(join(t.dir,"window-control-ack.jsonl")),rows=>rows.some(r=>r.id===id));
}
const inbox=(t:Task)=>jsonLines<{pid:number;content:string}>(join(t.dir,"inbox.jsonl"));
const wakeToWindow=async(f:ReturnType<typeof fixture>,dir:string)=>(await f.pump(dir,l=>stat(l).busy)).task;
const change=(t:Task,text="repaired\n")=>write(join(t.worktree,"src/app.txt"),text);
const deliver=(f:ReturnType<typeof fixture>,t:Task,...opts:string[])=>f.call(["交付",...opts],t.worktree,{LOOP_TASK_DIR:t.dir,LOOP_ROLE:"development"});
const wait=(f:ReturnType<typeof fixture>,t:Task)=>f.pump(t.dir,l=>!!stat(l).wait);

test("A1 · 六步真实 SIGKILL 后靠 tick 接上；重开原窗口，合入副作用不重复",async t=>{
  const f=fixture(t,{card:{flow:["开发评审","测试","合入"]}});
  const hook=write(join(f.base,"kill-once.mjs"),`
import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const orig=fs.appendFileSync, spawn=cp.spawnSync;
const mark=(path)=>{try{fs.closeSync(fs.openSync(path,'wx'));return true}catch(e){if(e.code!=='EEXIST')throw e;return false;}};
const steps=['准备','开窗口','收货','复测','评审','合入'];
fs.appendFileSync=function(path,bytes,...rest){
  orig(path,bytes,...rest); if(typeof path!=='string'||!path.endsWith('/ledger.jsonl'))return;
  const r=JSON.parse(bytes); if(!steps.includes(r.step))return;
  const base=path.slice(0,-12);
  if(r.type==='调度'&&r.owner&&mark(base+'/tick-killed-'+r.step)||r.type==='开始'&&r.step!=='合入'&&mark(base+'/tool-killed-'+r.step))process.kill(process.pid,'SIGKILL');
};
cp.spawnSync=function(cmd,args,...rest){
  const result=spawn(cmd,args,...rest);if(cmd==='git'&&args.includes('--ff-only')&&!result.status&&process.env.LOOP_JOB&&mark(process.cwd()+'/../tool-killed-合入'))process.kill(process.pid,'SIGKILL');return result;
}; syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS=[f.env.NODE_OPTIONS,"--import="+new URL("file://"+hook).href].filter(Boolean).join(" ");
  const {taskDir:dir}=await f.call(["启动",f.card]);
  const bump=async(pick:(l:Ledger)=>boolean)=>{
    for(let i=0;i<120;i++) {const l=new Ledger(dir);if(pick(l))return l;try {const r=await f.call(["tick","--all"]);assert(!r.errors.length,JSON.stringify(r.errors));}catch(e:any){if(e.signal!=="SIGKILL")throw e;}await delay(15);}
    assert.fail(readFileSync(join(dir,"ledger.jsonl"),"utf8").slice(-4050));
  };
  let l=await bump(l=>stat(l).busy), x=l.task, original=stat(l).window!;
  change(x,"recovered after kill\n");await assert.rejects(deliver(f,x),{signal:"SIGKILL"});
  process.kill(original.owner!.pid,"SIGKILL");
  l=await bump(l=>stat(l).busy && stat(l).window?.n!==original.n);assert.equal(stat(l).window?.file,original.file);assert.match(inbox(x).at(-1)!.content,/按开发卡开发/);
  await control(x,{type:"settle"});l=await bump(l=>stat(l).done);
  for(const step of ["准备","开窗口","收货","复测","评审","合入"]) assert(l.rows.some(r=>r.type===step && r.kind==="重试"),step);
  for(const type of ["准备好","提交","复测","评审","完成","合入"]) assert.equal(l.rows.filter(r=>r.type===type && !r.kind).length,1,type);
  assert.equal(f.git("rev-list","--count","--merges","dev"),"1");
});

test("T12 · 自行 Git commit 崩窗后不进复测，续原会话先提醒再分诊",async t=>{
  const f=fixture(t), x=await open(f), original=stat(new Ledger(x.dir)).window!;
  change(x,"未收货\n");fgit(x,"commit","-am","开发自己提交");process.kill(original.owner!.pid,"SIGKILL");
  await f.pump(x.dir,l=>stat(l).busy && stat(l).window?.n!==original.n);
  assert.equal(stat(new Ledger(x.dir)).window?.file,original.file);assert(!new Ledger(x.dir).delivery);
  await control(x,{type:"settle",text:"这是已做好的版本。"});await f.pump(x.dir,l=>!!l.last("提醒") && stat(l).busy);
  assert(!new Ledger(x.dir).last("复测"));write(join(x.dir,"model"),"收货");
  await control(x,{type:"settle",text:"这是已做好的版本。"});const l=await f.pump(x.dir,l=>!!l.last("完成"));assert.equal(l.delivery?.commit,fgit(x,"rev-parse","HEAD"));
});
const status=async(f:ReturnType<typeof fixture>,t:Task)=>(await f.call(["查询",t.executionId])).executions[0];
const open=async(f:ReturnType<typeof fixture>)=>wakeToWindow(f,(await f.call(["启动",f.card])).taskDir);
const received=async(f:ReturnType<typeof fixture>,text="repaired\n")=>{const t=await f.prepare();change(t,text);return {t,...await deliver(f,t)};};

 test("A2 · 伪造完成、删改 status/checks 都不能让合入和部署放行",async t=>{
  const f=fixture(t), {t:x,commit}=await received(f); const dev=f.git("rev-parse","dev");
  locked(x.dir,l=>l.add({type:"完成",sha:commit}));
  write(join(x.dir,"checks.jsonl"),'{"step":"复测","result":"通过"}\n{"step":"评审","result":"通过"}\n');
  write(join(x.dir,"status.json"),'{"state":"completed"}');
  for (const op of ["合入","部署"]) await assert.rejects(f.call([op,x.executionId]),(e:any)=>/放行资格不足/.test(e.stderr));
  assert.equal(f.git("rev-parse","dev"),dev); assert.equal((await status(f,x)).ledger.audit[0].step,"完成");
  await f.pump(x.dir,l=>!!l.last("评审"));
});

test("A3/T5/T8 · 提醒一次、历史提问分诊、窗口原话和正式答复分别留痕，交付跳过分诊",async t=>{
  const f=fixture(t), x=await open(f);change(x);
  write(join(x.dir,"model"),"重跑");
  const question="按开发卡要求暂停：两处契约需要确认，未修改代码或契约，未运行测试或 `loop 交付`。\n\n1. **退出后的重试返回 200 还是 404？**"; // V2-3f11aa 的历史窗口提问
  await control(x,{type:"settle",text:question});
  await f.pump(x.dir,l=>l.rows.some(r=>r.type==="提醒") && inbox(x).length>=2 && stat(l).busy);
  await control(x,{type:"settle",text:question});
  let l=await wait(f,x);assert.equal(stat(l).wait?.wait,"需求疑问");assert.equal(l.rows.filter(r=>r.type==="提醒").length,1);
  assert(!l.delivery && !l.last("复测")); await f.call(["答复",x.executionId,"--话","只做第一种"]);
  await until(x.dir,()=>inbox(x),items=>items.some(r=>r.content.includes("只做第一种"))); 
  await f.call(["提问","第一种是否包含旧配置？"],x.worktree,{LOOP_TASK_DIR:x.dir,LOOP_ROLE:"development"});
  await control(x,{type:"input",text:"  兼容旧配置  "}); assert.equal((await status(f,x)).ledger.waiting,null);
  await deliver(f,x); await control(x,{type:"settle"});
  l=await f.pump(x.dir,l=>!!l.last("完成"));assert.equal(l.rows.filter(r=>r.type==="分诊").length,1);
  const input=readFileSync(l.last("评审")!.check!.evidence.find(p=>p.includes("review-input"))!,"utf8");assert.match(input,/只做第一种/);assert.match(input,/  兼容旧配置  /);
});

test("A4/T11/T13 · agent_end 不补步骤；error 三档；Esc 停住且答复后续用会话",async t=>{
  const f=fixture(t,{config:{retry:{times:3,delaysMin:[.1,.4,1.6]}}}), x=await open(f);change(x,"半成品\n");
  await control(x,{type:"pre-retry"}); assert.equal(decide(new Ledger(x.dir))?.rule,2);assert.equal(inbox(x).length,1);
  for(const [i,min] of [.1,.4,1.6].entries()) {
    await control(x,{type:"settle",reason:"error",error:"fetch failed"}); const l=new Ledger(x.dir), at=Date.parse(stat(l).settled!.at)+min*60000;
    assert.match(decide(l,at-1)?.text || "",/退避/);const row=decide(l,at)!;assert(row.retry);locked(x.dir,book=>book.add(row,at));
    await until(x.dir,()=>stat(new Ledger(x.dir)).busy,Boolean);assert.equal(inbox(x).length,i+2);
  }
  await control(x,{type:"settle",reason:"error",error:"fetch failed"});let l=await wait(f,x);assert.equal(stat(l).wait?.wait,"环境修不好");
  await f.call(["tick","--all"]);assert.equal(new Ledger(x.dir).rows.filter(r=>r.wait).length,1);assert(!l.delivery && !l.last("评审") && !l.last("复测"));
  await f.call(["续跑",x.executionId,"--话","网络好了"]);
  await until(x.dir,()=>stat(new Ledger(x.dir)).busy,Boolean);assert.match(inbox(x).at(-1)!.content,/网络好了/);
  await control(x,{type:"settle",reason:"aborted",aborted:true});
  const previous=stat(new Ledger(x.dir)).window!;await control(x,{type:"close"});await f.call(["tick","--all"]);
  assert.equal((await status(f,x)).message,"本人中止，等本人说话");assert.equal(stat(new Ledger(x.dir)).window?.n,previous.n);
  await f.call(["答复",x.executionId,"--话","继续"]);l=await f.pump(x.dir,l=>stat(l).busy && stat(l).window?.n!==previous.n);
  assert.equal(stat(l).window?.file,previous.file);assert.match(inbox(x).at(-1)!.content,/本人答复：继续/);
});

for (const op of ["续跑","答复"]) test(`R2-1 · 开发错误耗尽后${op}唤起仍存活的窗口`,async t=>{
  const f=fixture(t,{config:{retry:{times:0}}}),x=await open(f), initial=stat(new Ledger(x.dir)).window!.n;
  change(x);await control(x,{type:"settle",reason:"error",error:"fetch failed"});
  assert.equal(stat(await wait(f,x)).wait?.step,"开窗口");
  await f.call([op,x.executionId,...(op==="答复" ? ["--话","网络已恢复"] : [])]);
  await until(x.dir,()=>stat(new Ledger(x.dir)).busy,Boolean);assert.equal(stat(new Ledger(x.dir)).window!.n,initial);
  assert.match(inbox(x).at(-1)!.content,op==="答复" ? /网络已恢复/ : /继续/);
  await deliver(f,x);await control(x,{type:"settle"});await f.pump(x.dir,l=>!!l.last("完成"));
});

for (const manual of [true,false]) test(`R2-2 · 阻断疑问答复后${manual ? "原样交付" : "分诊收货"}在同 SHA 重评`,async t=>{
  const blocker=PASS.replace("- 疑问示例","- 阻断：是否保留旧配置？"), words="保留旧配置即可，不改代码", f=fixture(t,{reviewer:`if grep -Fq ${sq(words)} "$2"; then printf %s ${sq(PASS)}; else printf %s ${sq(blocker)}; fi`});
  const x=await open(f);change(x);const first=await deliver(f,x);await control(x,{type:"settle"});
  let l=await wait(f,x);assert.match(stat(l).wait?.text || "",/阻断/);assert.equal(stat(l).returned("评审").length,0);
  const retest=l.last("复测")!.n;
  await f.call(["答复",x.executionId,"--话",words]);await until(x.dir,()=>stat(new Ledger(x.dir)).busy,Boolean);
  if (manual) assert.equal((await deliver(f,x)).commit,first.commit); else write(join(x.dir,"model"),"收货");
  await control(x,{type:"settle",text:"已按澄清检查，无需代码改动。"});
  l=await f.pump(x.dir,l=>!!l.last("完成"),32);
  assert.equal(l.rows.filter(r=>r.type==="提交").length,1);assert.equal(l.last("复测")!.n,retest);
  assert.deepEqual(l.rows.filter(r=>r.type==="评审").map(r=>[r.sha,!!r.blocker]),[[first.commit,true],[first.commit,false]]);
  assert.equal(stat(l).todo.length,0);assert.equal(stat(l).wait,undefined);
});

test("R2-3 · 接受未验证关闭旧待办并续完授权收尾，不吞之后的指令",async t=>{
  const flow=["开发评审","测试","合入","部署","推送"], f=fixture(t,{reviewer:`printf %s ${sq(MUST)}`,card:{flow,limits:{开发评审:{maxRepairs:1}}},config:{deploy:{cmd:"deploy.sh",check:"check.sh",rollback:"rollback.sh"}}});
  for (const script of ["deploy","check","rollback"]) writeFixtureScript(join(f.repo,script+".sh"),"sh","exit 0\n");
  f.git("add",".");f.git("commit","-m","fixtures");const origin=join(f.base,"origin.git");f.git("init","--bare",origin);f.git("remote","add","origin",origin);f.git("push","origin","dev");
  const x=await open(f);change(x);const {commit}=await deliver(f,x);await control(x,{type:"settle"});
  const waiting=await wait(f,x);assert.equal(stat(waiting).wait?.wait,"轮数用完");assert(stat(waiting).todo.length);
  const before=inbox(x).length;assert((await f.call(["合入",x.executionId,"--接受未验证","--话","确认结束此版返修，接受未验证"])).unverified);
  const l=await f.pump(x.dir,l=>stat(l).done,32);assert.equal(inbox(x).length,before);
  assert.equal(stat(l).side("部署")?.sha,commit);assert.equal(stat(l).side("推送")?.sha,commit);assert.equal(stat(l).returned("评审").length,1);
  const intent=l.last("接受未验证")!;l.rows.push({type:"答复",n:l.rows.at(-1)!.n+1,at:intent.at,todo:"后来的一项请求"});
  assert.deepEqual(stat(l).todo.map(r=>r.todo),["后来的一项请求"]);
});

test("A5/T10 · 三次 fetch failed 后同一评审成功；只有一次结论，决定可查询",async t=>{
  const f=fixture(t,{reviewer:`[ "$(grep -c review "$LOOP_TASK_DIR/order")" -gt 3 ] || { echo 'fetch failed' >&2; exit 1; }\nprintf '%s' ${sq(PASS)}`}),{t:x}=await received(f);
  const l=await f.pump(x.dir,l=>!!l.last("完成")), s=await status(f,x);
  assert.equal(l.rows.filter(r=>r.type==="评审" && r.result==="通过").length,1);assert.equal(l.rows.filter(r=>r.type==="评审" && r.kind==="重试").length,3);assert.equal(s.ledger.waiting,null);assert.equal(s.ledger.recovery.retries,3);
  for(const rule of [6,7,8]) assert(s.ledger.decisions.some((r:any)=>r.rule===rule));
});

test("A6 · W3-C 首轮原文缺触发标签；重排企图改通过也保留七条必修",async t=>{
  const original=readFileSync(join(ROOT,"test/fixtures/w3c-first-review.md"),"utf8"), f=fixture(t,{reviewer:`case "$2" in *reformat*) printf %s ${sq(PASS)};; *) printf %s ${sq(original)};; esac`});
  const {t:x}=await received(f), l=await f.pump(x.dir,l=>!!l.last("发回")), r=l.last("评审");
  assert.equal(r?.result,"必修");assert.equal(r?.value.items.length,7);assert.equal(r?.check?.evidence.filter(p=>p.includes("-重排原文")).length,1);assert(!r?.kind);
});

test("A7/T15/T16 · 未授权无写入；重复开工返回同号；依赖推迟取 dev 起点并随上游停止",async t=>{
  const f=fixture(t), bpath=write(join(f.repo,"B.json"),JSON.stringify({...f.raw,name:"B",tasks:[{...f.raw.tasks[0],name:"B"}]}));
  const args=["开工",f.card,bpath,"--依赖","2=1","--话","本人同意开工"];
  await assert.rejects(f.call(args),(e:any)=>/没有授权合入/.test(e.stderr));assert(!existsSync(f.root));
  write(f.card,JSON.stringify({...f.raw,flow:[...f.raw.flow,"合入"]}));
  const a=await f.call(args), repeated=await f.call(args);assert.equal(a.executionId,repeated.executionId);
  const dependent=join(f.root,a.executions[1]),x=await wakeToWindow(f,a.taskDir);
  await f.call(["提问","核对边界"],x.worktree,{LOOP_TASK_DIR:x.dir});await f.call(["tick","--all"]);assert(!new Ledger(dependent).last("准备好"));
  await f.call(["停止",x.executionId]);assert.equal((await status(f,new Ledger(dependent).task)).state,"cancelled");
  const changed=await f.call(["开工",f.card,bpath]);assert.notEqual(changed.executionId,a.executionId);
  const a2=await wakeToWindow(f,changed.taskDir);change(a2);await deliver(f,a2);await control(a2,{type:"settle"});
  const next=join(f.root,changed.executions[1]);const prepared=await f.pump(next,l=>!!l.last("准备好"));assert.equal(prepared.task.baseCommit,f.git("rev-parse","dev"));
  assert.equal(new Ledger(a2.dir).rows.filter(r=>r.type==="窗口" && r.status==="开").length,1);
});

test("A8 · 冲突清单发回，合入 dev 后起点前移、他人文件不进 diff，重新检查再合入",async t=>{
  const f=fixture(t,{card:{flow:["开发评审","测试","合入"]}}), x=await open(f);
  change(x,"开发方版本\n");await deliver(f,x);await control(x,{type:"settle"});
  write(join(f.repo,"src/app.txt"),"dev 版本\n");write(join(f.repo,"outside.txt"),"他人独立改动\n");f.git("add",".");f.git("commit","-m","dev advancing");
  let l=await f.pump(x.dir,l=>l.rows.some(r=>r.type==="发回" && r.step==="合入") && stat(l).busy);
  assert.match(inbox(x).at(-1)!.content,/src\/app\.txt/);assert.equal(stat(l).returned("评审").length,0);
  assert.throws(()=>fgit(x,"merge","dev"));change(x,"解决冲突\n");fgit(x,"add","src/app.txt");fgit(x,"commit","--no-edit");
  const {commit}=await deliver(f,x);await control(x,{type:"settle"});l=await f.pump(x.dir,l=>!!stat(l).side("合入") && stat(l).done);
  assert.equal(l.last("评审")?.sha,commit);assert.doesNotMatch(readFileSync(l.last("评审")!.check!.evidence.find(p=>p.includes("review-input"))!,"utf8"),/他人独立改动|outside\.txt/);
  assert.equal(f.git("rev-parse","dev^2"),commit);
});

test("A9 · 四轮后只等一次、显示收敛与四选项；加两轮后按新交付再评审",async t=>{
  const f=fixture(t,{reviewer:`printf %s ${sq(MUST)}`}),x=await open(f);
  for(let i=1;i<=4;i++) {
    change(x,`fix ${i}\n`);await deliver(f,x);await control(x,{type:"settle"});
    await f.pump(x.dir,l=>stat(l).returned("评审").length===i && (i===4 || stat(l).busy));
  }
  const s=await status(f,x);assert.equal(s.ledger.waiting.options.length,4);assert.match(s.message,/4\/4.*轮[\s\S]*1 → 1 → 1 → 1.*src\/app.txt/);
  await f.call(["tick","--all"]);assert.equal(new Ledger(x.dir).rows.filter(r=>r.wait).length,1);
  await assert.rejects(f.call(["评审",x.executionId]));await f.call(["加轮",x.executionId,"2"]);
  await until(x.dir,()=>stat(new Ledger(x.dir)).busy,Boolean);change(x,"fifth\n");await deliver(f,x);await control(x,{type:"settle"});
  const l=await f.pump(x.dir,l=>stat(l).returned("评审").length===5);assert.equal(stat(l).allowance("评审"),6);assert.equal(stat(l).wait,undefined);
});
