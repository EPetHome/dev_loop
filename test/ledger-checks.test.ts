import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, until, write, sq, PASS, MUST, ROOT, NODE, getJson, writeFixtureScript } from "./helpers.ts";
import { Ledger, locked, checksOf, PHASES } from "../src/core/store.ts";
import { state } from "../src/core/state.ts";
import { jsonLines } from "../src/infra/files.ts";
import { replay } from "./replay-history.ts";
const put=(file:string,v:unknown)=>appendFileSync(file,JSON.stringify(v)+"\n");
const text=(p:string)=>readFileSync(p,"utf8");
const receiver=(f:ReturnType<typeof fixture>,dir:string)=>f.call(["交付"],new Ledger(dir).task.worktree,{LOOP_TASK_DIR:dir});
const change=(l:Ledger,text:string)=>write(join(l.task.worktree,"src/app.txt"),text+"\n");
const latestReview=(l:Ledger)=>l.rows.findLast(r=>r.type==="评审" && r.check);
const complete=(l:Ledger)=>!!l.last("完成");
const thaw=(dir:string,name:string)=>write(join(dir,name),"1");

 test("T1/T2 · 同一测试首次超时重跑通过但记不稳；第二次不稳发回",async t=>{
  const f=fixture(t), x=await f.prepare();
  for(let n=1;n<=2;n++) {
    change(new Ledger(x.dir),`修复 ${n}`); const {commit}=await receiver(f,x.dir);
    const b=state(new Ledger(x.dir)).b!;
    // 直接注入被时钟判为超时的真实工具回执形状，不等 20 分钟。
    locked(x.dir,l=>{const j=l.add({type:"开始",step:"复测",sha:commit,key:b.key});l.add({type:"复测",step:"复测",sha:commit,key:b.key,ref:j.n,kind:"超时",result:"失败",text:"测试超时"});});
    const l=await f.pump(x.dir,l=>n===1 ? complete(l) : state(l).returned("复测").length===1);
    assert.equal(l.rows.filter(r=>r.type==="开始" && r.step==="复测" && r.sha===commit && r.retry).length,1);
    assert.equal(l.rows.filter(r=>r.flaky).length,n);
    if(n===1) {assert.equal(state(l).returned("复测").length,0); assert.match(text(latestReview(l)!.check!.evidence[0]),/不稳/);}
    else {assert.match(l.last("发回")!.todo!,/第二次不稳/);assert.equal(l.rows.filter(r=>r.type==="评审" && r.sha===commit).length,0);}
  }
});

test("R2-7 · 不稳重跑被杀后接管仍按第二次不稳发回",async t=>{
  const f=fixture(t,{test:`if [ -e "$LOOP_TASK_DIR/pause" ] && (set -C; : > "$LOOP_TASK_DIR/retest-started") 2>/dev/null; then while :; do sleep .03; done; fi`}), x=await f.prepare();
  const timeout=()=>locked(x.dir,l=>{const {sha,key}=state(l),j=l.add({type:"开始",step:"复测",sha,key});l.add({type:"复测",step:"复测",sha,key,ref:j.n,kind:"超时",result:"失败"});});
  change(new Ledger(x.dir),"第一次");await receiver(f,x.dir);timeout();const first=await f.pump(x.dir,complete);assert(first.last("复测")?.flaky);
  change(first,"第二次");const {commit}=await receiver(f,x.dir);timeout();thaw(x.dir,"pause");
  const pending=await f.pump(x.dir,()=>existsSync(join(x.dir,"retest-started")),32);process.kill(state(pending).running!.owner!.pid,"SIGKILL");
  const l=await f.pump(x.dir,l=>state(l).returned("复测").length || l.last("完成")?.sha===commit,32);
  assert(l.rows.some(r=>r.type==="复测" && r.sha===commit && r.kind==="重试" && !r.check));
  assert.match(l.last("复测")?.text || "",/第二次不稳/);assert(!l.rows.some(r=>r.type==="评审" && r.sha===commit));
});

test("R2-8 · ENOSPC 留下坏尾，查询保留历史，续跑再追加后短尾不变事实",async t=>{
  const f=fixture(t), x=await f.prepare(), dir=x.dir, path=join(dir,"ledger.jsonl"), original=text(path);
  const preload=write(join(f.base,"torn-write.mjs"),`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const append=fs.appendFileSync;fs.appendFileSync=(path,bytes,...opts)=>{if(path.endsWith('/ledger.jsonl')){append(path,Buffer.from(bytes).subarray(0,bytes.indexOf('止')+2),...opts);throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}return append(path,bytes,...opts);};syncBuiltinESMExports();`);
  await assert.rejects(f.call(["停止",x.executionId],f.repo,{NODE_OPTIONS:`--import=${new URL("file://"+preload).href}`}),/disk full/);
  const torn=readFileSync(path);assert(torn.length>Buffer.byteLength(original));assert.equal(torn.at(-1)===10,false);
  assert.equal((await f.call(["查询",x.executionId])).executions[0].loop.ready,true);assert.equal(new Ledger(dir).last("停"),undefined);
  await f.call(["续跑",x.executionId]);const repaired=readFileSync(path);assert(repaired.subarray(0,torn.length).equals(torn),"恢复不修改已有字节");
  const l=new Ledger(dir);assert.deepEqual(l.rows.map(r=>r.n),[1,2,3,4]);assert.equal(l.last("续跑")?.n,4);assert(!l.last("停"));
  await f.call(["停止",x.executionId]);assert.equal(new Ledger(dir).last("停")?.n,5);
});

test("T3/T4/T6 · 检查期间十次并发叫醒只启动一份；闲窗不分诊；迟到旧评审不扣轮",async t=>{
  const f=fixture(t,{test:'touch "$LOOP_TASK_DIR/test-running"; while [ ! -e "$LOOP_TASK_DIR/test-go" ]; do sleep .03; done',reviewer:`touch "$LOOP_TASK_DIR/review-running"; while [ ! -e "$LOOP_TASK_DIR/review-go" ]; do sleep .03; done\nif [ "$LOOP_JOB" = "$(cat "$LOOP_TASK_DIR/old-review")" ]; then printf %s ${sq(MUST)}; else printf %s ${sq(PASS)}; fi`});
  const {taskDir:dir}=await f.call(["启动",f.card]);let l=await f.pump(dir,l=>state(l).busy), pid=state(l).window!.owner!.pid;
  change(l,"第一版");const {commit:first}=await receiver(f,dir);
  put(join(dir,"window-control.jsonl"),{pid,type:"settle"});
  l=await f.pump(dir,l=>existsSync(join(dir,"test-running")));
  const inbox=join(dir,"inbox.jsonl"), before=text(inbox);
  const events=await Promise.all(Array.from({length:10},()=>f.call(["tick","--all"])));assert(events.every(r=>!r.errors.length));
  assert.equal(new Ledger(dir).rows.filter(r=>r.type==="开始" && r.step==="复测" && r.sha===first).length,1);
  thaw(dir,"test-go");l=await f.pump(dir,l=>existsSync(join(dir,"review-running")));
  const active=state(l).running!;assert.equal(active.step,"评审");write(join(dir,"old-review"),String(active.n));
  for(let i=0;i<3;i++)await f.call(["tick","--all"]); assert.equal(text(inbox),before);assert(!new Ledger(dir).last("分诊"));
  put(join(dir,"window-control.jsonl"),{pid,type:"turn"});await until(dir,()=>state(new Ledger(dir)).busy,Boolean);
  change(l,"第二版");const {commit:latest}=await receiver(f,dir);put(join(dir,"window-control.jsonl"),{pid,type:"settle"});
  thaw(dir,"review-go");l=await f.pump(dir,complete);
  assert.deepEqual(l.rows.filter(r=>r.type==="评审" && r.check).map(r=>[r.sha,r.result]),[[first,"必修"],[latest,"通过"]]);
  assert.equal(state(l).returned("评审").length,0);assert.equal(l.rows.filter(r=>r.type==="复测").length,2);assert.equal(text(inbox),before);
});

test("T7 · 同 SHA 改 test、localFiles 字节或评审提示词各重做两步",async t=>{
  const f=fixture(t), x=await f.prepare(), dir=x.dir;change(new Ledger(dir),"same sha");const {commit}=await receiver(f,dir);
  await f.pump(dir,complete);
  const card=getJson(f.card);card.tasks[0].test="echo 同一 SHA 新测试";write(f.card,JSON.stringify(card));
  await f.pump(dir,l=>l.rows.filter(r=>r.type==="完成").length===2);
  write(join(f.repo,"local.txt"),"new local material"); await f.pump(dir,l=>l.rows.filter(r=>r.type==="完成").length===3);
  // 隔离 runner 使用新的规则文件，不修改本仓库、不影响并行用例。
  const copy=join(f.base,"dev-loop");execFileSync("cp",["-R",join(ROOT,"src"),f.base]);rmSync(copy,{force:true});
  write(join(f.base,"config/defaults.json"),text(join(ROOT,"config/defaults.json")));
  const rules=join(f.base,"src/core/review-prompt.md");appendFileSync(rules,"\n新的评审规则。\n");
  for(const cmd of ["复测","评审"]) execFileSync(NODE,[join(f.base,"src/cli/main.ts"),cmd,x.executionId,"--json"],{env:f.env,stdio:["ignore","pipe","pipe"]});
  const l=new Ledger(dir);for(const step of ["复测","评审"]) {
    const rows=l.rows.filter(r=>r.type===step && r.check);assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.key)).size,4);assert(rows.every(r=>r.sha===commit));
  }
});

test("T9 · 同一命令在起点也失败算环境；起点通过算产品",async t=>{
  for(const same of [true,false]) {
    const f=fixture(t,{test:same?"echo environment >&2; exit 1":"grep -q '^good' src/app.txt"}),x=await f.prepare();change(new Ledger(x.dir),"bad");await receiver(f,x.dir);
    const l=await f.pump(x.dir,l=>same ? !!state(l).wait : state(l).returned("复测").length===1);
    assert.equal(state(l).returned("复测").length,same?0:1);assert.equal(state(l).wait?.wait,same?"环境修不好":undefined);
    const retest=l.last("复测")!;assert(retest.check!.evidence.some(f=>f.endsWith("-base.log")));assert.equal(retest.check!.result,same?"环境未验证":"失败");
  }
});

test("T14 · 三层覆盖固定；修改源配置不改变既有卡的模型与预算",async t=>{
  const f=fixture(t,{config:{reviewerThinking:"medium",cardRetryBudget:2,limits:{测试:{timeoutMin:11,maxRepairs:1},开发评审:{timeoutMin:9}}},card:{limits:{测试:{maxRepairs:6}}}});const x=await f.prepare();
  write(join(f.repo,".autoreview.json"),JSON.stringify({setup:"exit 1",reviewerThinking:"low",cardRetryBudget:0}));
  const {config}=new Ledger(x.dir).task;assert.equal(config.reviewerThinking,"medium");assert.equal(config.triageThinking,"xhigh");assert.equal(config.triageModel,"openai-codex/gpt-6.2-sol");
  assert.deepEqual(config.limits.测试,{timeoutMin:11,maxRepairs:6});assert.equal(config.limits.开发评审.timeoutMin,9);assert.equal(config.limits.开发评审.maxRepairs,4);assert.equal(config.cardRetryBudget,2);
});

test("T17 · PA 回执、公开阶段、等待翻译；显式未验证意图才放行部署",async t=>{
  const f=fixture(t,{config:{deploy:{cmd:"deploy.sh",check:"check.sh",rollback:"rollback.sh"},retry:{times:0}},reviewer:`printf %s ${sq(MUST)}`});
  for(const file of ["deploy","check","rollback"]) writeFixtureScript(join(f.repo,file+".sh"),"sh",`echo ${file} >> "$LOOP_EVIDENCE_DIR/did"`);
  f.git("add",".");f.git("commit","-m","fake deploy");
  const args=["启动",f.card,"--派单编号","delivery-1","--指令编号","instruction-1"], r=await f.call(args);assert.deepEqual(await f.call(args),r);
  assert.equal(r.state,"working");assert(r.status.endsWith("status.json"));
  await f.call(["准备",r.executionId]);const l=()=>new Ledger(r.taskDir), x=l().task;
  await f.call(["提问","是否删旧入口"],x.worktree,{LOOP_TASK_DIR:x.dir});
  const listed=(await f.call(["查询","--all","--brief"])).executions[0];assert.equal(listed.protocol,"loop-status/1");assert.equal(listed.dispatchId,"delivery-1");assert.equal(listed.loop.wait,"停下没交付");
  await f.call(["答复",x.executionId,"--话","不删"]);assert.equal(l().last("答复")!.text,"不删");
  locked(x.dir,b=>b.add({type:"发回",step:"评审",level:"评审",count:1,wait:"轮数用完",text:"已用完"}));
  const more=await f.call(["续跑",x.executionId]);assert.equal(more.status.loop.reviewAllowance,5);
  locked(x.dir,b=>b.add({type:"等本人",step:"复测",wait:"环境修不好",text:"网络"}));
  assert.equal((await f.call(["查询",x.executionId])).executions[0].loop.wait,"复测环境未就绪");await f.call(["续跑",x.executionId]);assert(l().last("续跑"));
  change(l(),"manual unverified");const {commit}=await receiver(f,x.dir);
  assert((await f.call(["合入",x.executionId,"--接受未验证","--话","接受未验证"])).unverified);
  assert.equal(l().last("接受未验证")!.text,"接受未验证");const deployed=await f.call(["部署",x.executionId]);
  assert.equal(deployed.commit,commit);assert.equal(deployed.result,"已部署");assert.deepEqual(await f.call(["部署",x.executionId]),deployed);
  const after=getJson(r.status);assert(PHASES.includes(after.loop.phase));assert.equal(after.loop.phase,"已部署");assert.equal(after.state,"completed");
  const stopped=await f.call(["停止",x.executionId]);assert.equal(stopped.loop.phase,"已停止");assert(existsSync(x.worktree));
});

test("T18 · 未改的 coordinate 开工同时读新版上一批和旧批重复候选",async t=>{
  const f=fixture(t,{reviewer:`if grep -q 'first' src/app.txt; then printf %s ${sq(MUST)}; else printf %s ${sq(PASS)}; fi`});
  const path=write(join(f.repo,"docs/batches/新版/开发卡.json"),JSON.stringify({...f.raw,name:"新版",acceptance:"../../../criteria.md",tasks:[{...f.raw.tasks[0],prompt:"../../../prompt.md"}]}));
  const incoming=write(join(f.repo,"docs/batches/待开工/开发卡.json"),text(path));
  const oldDir=join(f.root,"old"), oldCard=write(join(f.repo,"docs/batches/旧批/开发卡.json"),text(path));
  write(join(oldDir,"task.json"),JSON.stringify({executionId:"old",repo:f.repo,card:oldCard,baseCommit:f.git("rev-parse","dev"),createdAt:"2026-01-01T00:00:00Z"}));
  write(join(oldDir,"status.json"),JSON.stringify({state:"completed",loop:{phase:"完成"}}));
  write(join(oldDir,"checks.jsonl"),JSON.stringify({step:"评审",result:"必修",detail:MUST,commit:f.git("rev-parse","dev"),endedAt:"2026-01-01T00:01:00Z",evidence:[]})+"\n");
  const {taskDir:dir,executionId}=await f.call(["启动",path]);await f.call(["准备",executionId]);
  change(new Ledger(dir),"first");await receiver(f,dir);await f.call(["复测",executionId]);await f.call(["评审",executionId]);
  change(new Ledger(dir),"fixed");await receiver(f,dir);await f.pump(dir,complete);
  const out=JSON.parse(execFileSync(NODE,[join(ROOT,"tools/coordinate.ts"),"开工","--project",f.repo,"--card",incoming,"--tasks-root",f.root],{encoding:"utf8",env:f.env}));
  assert.equal(out.protocol,"coordinate-report/1");assert.equal(out.previous.executions[0].execution,executionId);assert(out.previous.executions[0].signals.some((s:any)=>s.kind==="必修"));assert(out.candidates.some((c:any)=>c.key==="file:src/app.txt" && c.status==="候选"));
});

test("T19/T20 · 缺页面截图只发待办；补齐登记草图和两张图；普通卡不要求截图",async t=>{
  const f=fixture(t);write(join(f.repo,"sketch.md"),"草图：两个页面各一行");write(f.card,JSON.stringify({...f.raw,tasks:[{...f.raw.tasks[0],版式:{草图:"sketch.md",页面:["首页","结果"]}}]}));
  const x=await f.prepare();change(new Ledger(x.dir),"界面");const one=write(join(f.base,"首页.png"),"fake PNG 1"),two=write(join(f.base,"结果.png"),"fake PNG 2");
  const deliver=(...shots:string[])=>f.call(["交付","--截图",...shots],x.worktree,{LOOP_TASK_DIR:x.dir});
  await assert.rejects(deliver(one),(e:any)=>/缺截图：结果/.test(e.stderr));let l=new Ledger(x.dir);assert.equal(l.delivery,undefined);assert.equal(state(l).wait,undefined);assert.match(state(l).todo.at(-1)!.todo!,/结果/);
  await deliver(one,two);l=await f.pump(x.dir,complete);assert.equal(l.delivery?.images.length,2);assert.deepEqual(l.delivery?.images.map(text),["fake PNG 1","fake PNG 2"]);
  const material=text(latestReview(l)!.check!.evidence[0]);for(const fragment of ["草图：两个页面","首页.png","结果.png"])assert(material.includes(fragment));
  const g=fixture(t), plain=await g.prepare();change(new Ledger(plain.dir),"普通改动");await receiver(g,plain.dir);assert.deepEqual(new Ledger(plain.dir).delivery?.images,[]);
});

test("A10 · 旧文件回放只读：自动、保留及无原话的未验证差异逐条列出",t=>{
  const f=fixture(t),dir=join(f.root,"old"),sha="a".repeat(40), now=new Date().toISOString();
  write(join(dir,"task.json"),'{"executionId":"old"}');write(join(dir,"status.json"),JSON.stringify({loop:{facts:{stops:[{reason:"临时故障",message:"fetch failed",at:now},{reason:"评审必修到上限",at:now}]}}}));
  const checks=join(dir,"checks.jsonl");for(const [step,result] of [["复测","通过"],["评审","通过"],["合入","已合入（未验证）"]]) put(checks,{step,result,commit:step==="合入"?"b".repeat(40):sha,tree:sha,promptHash:"p",acceptanceHash:"a",endedAt:now});
  const before=text(checks), r=replay(f.root);assert.equal(r.oldAllowed,r.newAllowed);assert.equal(r.mismatches.length,1);assert.deepEqual(r.stops.map(s=>s.route),["自动补步骤","保留"]);assert.equal(text(checks),before);
});
