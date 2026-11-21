import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, realpathSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, until, getJson, NODE, ROOT, MUST, PASS, sq } from "./helpers.ts";
import { spawn, execFileSync } from "node:child_process";
import { finish, pendingAcceptance } from "../src/cli/finish.ts";
import { queued } from "../src/cli/queue.ts";
import { lock } from "../src/infra/files.ts";
import { projectFile } from "../src/infra/project.ts";
import { convention } from "../src/hosts/convention.ts";
import { launchSession } from "../src/hosts/launch.ts";
import { startFinish } from "../src/hosts/after-settle.ts";
import { stop, prepare, registerSession } from "../src/core/lifecycle.ts";
import { registerPi } from "../src/hosts/pi.ts";
import { readCard } from "../src/core/card.ts";
import { createTask, taskOf, statusOf, transition, update, annotate, checksOf, waitFor } from "../src/core/store.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { resume } from "../src/core/lifecycle.ts";
import { identity } from "../src/infra/exec.ts";
import { reviewed, delivered } from "./step-helpers.ts";
import { validateStart } from "../src/cli/start.ts";
const flow = ["开发评审", "测试", "合入", "部署", "推送"];
async function finishingFixture(t: Parameters<typeof fixture>[0], o: {flow?: string[]; cmd?: string; check?: string; rollback?: string} = {}) {
  const f = fixture(t,{card:{flow:o.flow || flow.slice(0,4)},config:{deploy:{cmd:"deploy.cjs",check:"check.cjs",rollback:"rollback.cjs"}}});
  f.raw.tasks[0].scope = ["src/**","check.cjs"]; write(f.card,JSON.stringify(f.raw));
  for (const name of ["deploy","check","rollback"] as const) {
    const body = name === "deploy" ? o.cmd : o[name];
    write(join(f.repo,name+".cjs"), "#!"+NODE+"\nconst fs=require('fs'),path=require('path'),cp=require('child_process'),e=process.env,evidence=e.LOOP_EVIDENCE_DIR,dir=path.dirname(evidence);\nfs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({name:"+JSON.stringify(name)+",commit:e.LOOP_DEPLOY_COMMIT,dev:cp.execFileSync('git',['rev-parse','dev'],{cwd:e.LOOP_REPO,encoding:'utf8'}).trim(),status:JSON.parse(fs.readFileSync(dir+'/status.json')),evidence})+'\\n');\n"+(body || "")+"\n");
    chmodSync(join(f.repo,name+".cjs"),0o755);
  }
  f.git("add","."); f.git("commit","-m","deploy substitutes");
  const task = await f.prepare(), before = f.git("rev-parse","dev"); registerSession(task.dir,"pi","fake",process.pid);
  write(join(task.worktree,"src/app.txt"),"good finish\n"); const {commit} = deliver(task.dir);
  return {...f,task,before,commit};
}
test("A10：退回最新部署只动线上、收到原证据；旧部署/重复退回无法执行", async t => {
  const f = await finishingFixture(t); await settle(f.task.dir); await finish(f.task.dir);
  const before=f.git("rev-parse","dev"), evidence=received(f.task.dir)[0].evidence;
  const result=JSON.parse((await f.cli(["退回",f.task.executionId,"--json"])).stdout);
  assert.equal(result.result,"已退回"); assert.equal(result.evidenceDir,evidence); assert.equal(statusOf(f.task.dir).loop.phase,"已退回");
  assert.equal(f.git("rev-parse","dev"),before); assert.equal(received(f.task.dir).filter(c=>c.name==="rollback").length,1);
  await settle(f.task.dir); assert.equal(statusOf(f.task.dir).loop.phase,"已退回");
  await assert.rejects(f.cli(["退回",f.task.executionId,"--json"]),/最新的一次部署/);
  const newer=createTask(f.card,f.root); await prepare(newer.dir); transition(newer.dir,"completed","完成","manual",null);
  await f.cli(["部署",newer.executionId,"--json"]); await assert.rejects(f.cli(["退回",f.task.executionId,"--json"]),/最新的一次部署/);
});
const received = (dir: string) => readFileSync(join(dir,"calls.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
test("A1/A3/A8：宿主自动独立收尾，部署前 dev 不变，部署中 working，同 commit 只一次", async t => {
  const f = await finishingFixture(t), events:Record<string,any>={};
  registerPi({on:(name,handler)=>{events[name]=handler;},sendMessage:()=>{}},{env:{...f.env,LOOP_TASK_DIR:f.task.dir},every:()=>({unref(){}}),clear:()=>{}});
  const ctx={cwd:f.task.worktree,hasUI:false,sessionManager:{getSessionId:()=>"fake",getBranch:()=>[]}};
  events.session_start({},ctx);await events.agent_before_settle({},ctx);
  await until(f.task.dir,()=>statusOf(f.task.dir),s=>s.state==="completed" && !s.loop.finisher);events.session_shutdown();
  const calls = received(f.task.dir), deployed = calls[0];
  assert.equal(deployed.dev,f.before); assert.equal(deployed.status.state,"working"); assert.equal(deployed.status.loop.phase,"部署中");
  assert.equal(f.git("rev-parse","dev"),deployed.commit); assert.equal(f.git("rev-parse","dev^2"),f.commit);
  assert.equal(statusOf(f.task.dir).loop.phase,"已部署"); assert.equal(readFileSync(join(f.task.dir,"order"),"utf8"),"test\nreview\n");
  await settle(f.task.dir); await startFinish(f.task.dir,f.env); assert.equal(received(f.task.dir).length,2); assert.equal(statusOf(f.task.dir).loop.phase,"已部署");
});
test("只合入不部署，收尾成功自动释放；无收尾的卡保留工作区", async t => {
  const f = await finishingFixture(t,{flow:flow.slice(0,3)}); await settle(f.task.dir); await startFinish(f.task.dir,f.env);
  const done = await until(f.task.dir,()=>statusOf(f.task.dir),s=>s.state==="completed" && !s.loop.finisher);
  assert.equal(done.loop.phase,"已合入"); assert.equal(done.state,"completed");
  assert.equal(f.git("rev-parse","dev^2"),f.commit); assert.equal(existsSync(join(f.task.dir,"calls.jsonl")),false);
  assert.equal(done.loop.released,true); assert.equal(existsSync(f.task.worktree),false);
  assert.equal(f.git("rev-parse",f.task.branch),f.commit); assert.ok(existsSync(join(f.task.dir,"test-"+f.commit+".log")));
  assert.deepEqual(checksOf(f.task.dir).filter(c=>c.step==="释放").map(c=>[c.result,c.commit]),[["已释放",f.commit]]);
  assert.match(done.message,/工作区已释放/); assert.match(readFileSync(join(f.repo,"结果.md"),"utf8"),/工作区已释放/);
  await assert.rejects(finish(f.task.dir),/当前不在待收尾/);
  const plain = await delivered(t); await settle(plain.task.dir); await startFinish(plain.task.dir,plain.env);
  assert.equal(statusOf(plain.task.dir).state,"completed"); assert.equal(statusOf(plain.task.dir).loop.released,false);
  assert.ok(existsSync(plain.task.worktree)); assert.ok(!checksOf(plain.task.dir).some(c=>c.step==="释放"));
  await assert.rejects(finish(plain.task.dir),/没有约定收尾/);
});
test("收尾时发现未跟踪文件，正常完成且只列出前 20 个路径", async t => {
  const f = await delivered(t,{card:{flow:flow.slice(0,3)}}); await settle(f.task.dir);
  const paths = ["draft 中文.txt", ...Array.from({length:21},(_,i)=>`tmp/notes-${String(i).padStart(2,"0")}.txt`)];
  for (const path of paths) write(join(f.task.worktree,path),"unsaved\n");
  const done = await finish(f.task.dir), checks = checksOf(f.task.dir);
  assert.equal(done.state,"completed"); assert.equal(done.loop.phase,"已合入"); assert.equal(done.loop.wait,null);
  assert.equal(done.loop.released,false); assert.equal(f.git("rev-parse","dev^2"),f.commit);
  assert.match(done.message,/工作区有未提交文件，已保留/);
  for (const path of paths) assert.equal(readFileSync(join(f.task.worktree,path),"utf8"),"unsaved\n");
  assert.deepEqual(checks.slice(-2).map(c=>[c.step,c.result]),[["收尾","通过"],["释放","保留"]]);
  assert.deepEqual(checks.at(-1)?.detail?.split("\n"),paths.slice(0,20));
});
test("Git 拒绝删除时记释放失败及原始错误，不影响已通过的收尾", async t => {
  const f = await delivered(t,{card:{flow:flow.slice(0,3)}}); await settle(f.task.dir);
  f.git("worktree","lock","--reason","keep this fixture",f.task.worktree);
  const done = await finish(f.task.dir), checks = checksOf(f.task.dir);
  assert.equal(done.state,"completed"); assert.equal(done.loop.phase,"已合入"); assert.equal(done.error,null);
  assert.equal(done.loop.released,false); assert.ok(existsSync(f.task.worktree)); assert.equal(f.git("rev-parse","dev^2"),f.commit);
  assert.deepEqual(checks.slice(-2).map(c=>[c.step,c.result]),[["收尾","通过"],["释放","失败"]]);
  assert.match(checks.at(-1)!.detail!,/fatal: .*locked working tree.*keep this fixture/);
  assert.doesNotMatch(done.message,/工作区已释放/);
  assert.doesNotMatch(readFileSync(join(f.repo,"结果.md"),"utf8"),/工作区已释放/);
});
test("A9：同项目两次收尾排队；部署段不重叠，均完成", async t => {
  const f = await finishingFixture(t,{cmd:"fs.writeFileSync(dir+'/started',''); const ready=()=>{if(fs.existsSync(dir+'/go'))w.close();};const w=fs.watch(dir,ready);ready();"});
  const second = createTask(f.card,f.root); await prepare(second.dir); write(join(second.worktree,"src/other.txt"),"second\n"); deliver(second.dir);
  await settle(f.task.dir); await settle(second.dir);
  const a = finish(f.task.dir); await until(f.task.dir,()=>existsSync(join(f.task.dir,"started")),Boolean);
  const b = finish(second.dir); await until(second.dir,()=>statusOf(second.dir),s=>s.message.includes("排队中"));
  assert.equal(existsSync(join(second.dir,"started")),false); write(join(f.task.dir,"go"),""); await a;
  await until(second.dir,()=>existsSync(join(second.dir,"started")),Boolean); assert.equal(statusOf(f.task.dir).state,"completed");
  write(join(second.dir,"go"),""); await b; assert.equal(statusOf(second.dir).state,"completed");
});
test("关闭宿主不结束收尾；停止不打断部署脚本，之后不合入或推送", async t => {
  const f = await finishingFixture(t,{cmd:"fs.writeFileSync(dir+'/started','');const w=fs.watch(dir,()=>{if(fs.existsSync(dir+'/go')){fs.writeFileSync(dir+'/script-finished','');w.close();}});"});
  await settle(f.task.dir);
  const host = spawn(NODE,["--input-type=module","-e",`import {startFinish} from ${JSON.stringify(join(ROOT,"src/hosts/after-settle.ts"))};await startFinish(process.env.LOOP_TASK_DIR);process.stdout.write('started');setInterval(()=>{},60000);`],{env:{...f.env,LOOP_TASK_DIR:f.task.dir},stdio:["ignore","pipe","pipe"]});
  await until(f.task.dir,()=>existsSync(join(f.task.dir,"started")),Boolean); host.kill("SIGKILL");
  stop(f.task.dir); assert.equal(existsSync(join(f.task.dir,"script-finished")),false); write(join(f.task.dir,"go"),"");
  await until(f.task.dir,()=>statusOf(f.task.dir),s=>!s.loop.finisher);
  assert.equal(existsSync(join(f.task.dir,"script-finished")),true); assert.equal(f.git("rev-parse","dev"),f.before); assert.equal(statusOf(f.task.dir).state,"cancelled");
  assert.equal(statusOf(f.task.dir).loop.released,false); assert.ok(existsSync(f.task.worktree));
  update(f.task.dir,s=>{s.loop.session=null;});const continued=resume(f.task.dir);assert.equal(continued.reused,false);assert.equal(continued.status.state,"working");assert.equal(continued.status.loop.phase,"开发中");
});
test("核心只转收尾中且不报 completed；同 commit 不重复，沿用不盖附加阶段", async t => {
  const f = await delivered(t, {card:{flow:flow.slice(0,3)}}), {task,commit} = f;
  await settle(task.dir); assert.equal(statusOf(task.dir).state,"working"); assert.equal(statusOf(task.dir).loop.phase,"收尾中");
  assert.equal(statusOf(task.dir).loop.afterCommit,commit);
  assert.throws(()=>deliver(task.dir),/收尾/); assert.throws(()=>resume(task.dir),/正在准备或检查/);
  update(task.dir,s=>{s.loop.finisher=identity();}); annotate(task.dir,"部署中","running");
  assert.equal(statusOf(task.dir).state,"working"); await settle(task.dir); assert.equal(statusOf(task.dir).loop.phase,"部署中");
  update(task.dir,s=>{s.loop.finisher=null;}); transition(task.dir,"completed","已部署","done",null);
  await settle(task.dir); assert.equal(statusOf(task.dir).loop.phase,"已部署");
  deliver(task.dir); assert.equal(statusOf(task.dir).loop.phase,"已部署"); assert.equal(resume(task.dir).status.loop.phase,"已部署");
  transition(task.dir,"working","开发中","repair","developmentMs"); deliver(task.dir); await settle(task.dir);
  assert.equal(statusOf(task.dir).loop.wait,"收尾没走完"); assert.equal(resume(task.dir).reused,false);
  assert.equal(statusOf(task.dir).loop.phase,"开发中");
});
test("无收尾旧执行沿用不覆盖已合入；缺字段状态可读取", async t => {
  const f = await delivered(t); reviewed(f.task,f.commit);
  transition(f.task.dir,"completed","已合入","done",null); await settle(f.task.dir);
  assert.equal(statusOf(f.task.dir).loop.phase,"已合入");
});
test("A4/A5：失败检查只回退一次，返修收到原因；新 commit 重新检查后部署推送", async t => {
  const f = await finishingFixture(t,{flow,check:"console.log('health is broken');process.exit(7);"});
  f.git("init","--bare",join(f.base,"origin.git")); f.git("remote","add","origin",join(f.base,"origin.git")); f.git("push","origin","dev");
  await settle(f.task.dir); await finish(f.task.dir);
  const failed=statusOf(f.task.dir); assert.equal(failed.state,"working"); assert.equal(failed.loop.phase,"开发中"); assert.equal(failed.loop.deployReturns,1);
  assert.match(failed.loop.pendingReturn!,/health is broken/); assert.equal(f.git("rev-parse","dev"),f.before); assert.equal(f.git("ls-remote","origin","refs/heads/dev").split(/\s/)[0],f.before);
  assert.deepEqual(received(f.task.dir).map(c=>c.name),["deploy","check","rollback"]);
  assert.equal(failed.loop.released,false); assert.ok(existsSync(f.task.worktree)); assert.ok(!checksOf(f.task.dir).some(c=>c.step==="释放"));
  const events:Record<string,any>={}, messages:any[]=[], callbacks:(()=>void)[]=[];
  registerPi({on:(e,h)=>{events[e]=h;},sendMessage:(m,o)=>messages.push({m,o})},{env:{LOOP_TASK_DIR:f.task.dir},every:cb=>{callbacks.push(cb);return {unref(){}};},clear:()=>{}});
  const ctx={cwd:f.task.worktree,hasUI:false,sessionManager:{getSessionId:()=>"fake",getBranch:()=>[]}};
  events.session_start({},ctx); assert.equal(messages[0].o.triggerTurn,true); assert.match(messages[0].m.content,/health is broken/); assert.equal(statusOf(f.task.dir).loop.pendingReturn,null);
  callbacks[1](); assert.equal(messages.filter(x=>x.m.customType==="dev-loop-return").length,1);
  const check=join(f.task.worktree,"check.cjs"); write(check,readFileSync(check,"utf8").replace("process.exit(7);",""));
  const repaired=deliver(f.task.dir).commit; assert.notEqual(repaired,f.commit); await events.agent_before_settle({},ctx);
  await until(f.task.dir,()=>statusOf(f.task.dir),s=>s.state==="completed" && !s.loop.finisher);
  const done=statusOf(f.task.dir); assert.equal(done.state,"completed"); assert.equal(done.loop.phase,"已推送"); assert.match(done.message,/退回 1 次[\s\S]*health is broken/);
  assert.equal(checksOf(f.task.dir).filter(c=>c.step==="复测").length,2); assert.equal(checksOf(f.task.dir).filter(c=>c.step==="评审").length,2);
  assert.equal(f.git("ls-remote","origin","refs/heads/dev").split(/\s/)[0],f.git("rev-parse","dev")); events.session_shutdown();
  assert.equal(done.loop.released,true); assert.equal(existsSync(f.task.worktree),false);
  assert.deepEqual(checksOf(f.task.dir).slice(-3).map(c=>[c.step,c.result]),[["推送","已推送"],["收尾","通过"],["释放","已释放"]]);
});
test("A6：回退也失败不返修，明确等你；达到 2 轮上限后不再自动退回", async t => {
  const broken=await finishingFixture(t,{check:"process.exit(7);",rollback:"process.exit(8);"}); await settle(broken.task.dir); await finish(broken.task.dir);
  assert.equal(statusOf(broken.task.dir).state,"input_required"); assert.equal(statusOf(broken.task.dir).loop.wait,"收尾没走完"); assert.match(statusOf(broken.task.dir).message,/回退也失败/); assert.equal(statusOf(broken.task.dir).loop.pendingReturn,null);
  const capped=await finishingFixture(t,{check:"process.exit(7);"}); update(capped.task.dir,s=>{s.loop.deployReturns=2;}); await settle(capped.task.dir); await finish(capped.task.dir);
  assert.equal(statusOf(capped.task.dir).state,"input_required"); assert.match(statusOf(capped.task.dir).message,/上限/); assert.equal(statusOf(capped.task.dir).loop.deployReturns,2);
});
test("试合并冲突退回返修；资格不足、推送失败转等你；手工收尾可接手", async t => {
  const conflict=await finishingFixture(t); write(join(conflict.repo,"src/app.txt"),"dev conflicting\n"); conflict.git("add","src"); conflict.git("commit","-m","dev conflict");
  const before=conflict.git("rev-parse","dev"); await settle(conflict.task.dir); await finish(conflict.task.dir);
  assert.equal(statusOf(conflict.task.dir).loop.phase,"开发中"); assert.match(statusOf(conflict.task.dir).loop.pendingReturn!,/CONFLICT[\s\S]*src\/app.txt/);
  assert.equal(conflict.git("rev-parse","dev"),before); assert.equal(existsSync(join(conflict.task.dir,"calls.jsonl")),false);
  const preflight=await finishingFixture(t);write(join(preflight.repo,".autoreview.json"),JSON.stringify({deploy:{cmd:"not-created.cjs",check:"check.cjs",rollback:"rollback.cjs"}}));
  await settle(preflight.task.dir);await finish(preflight.task.dir);assert.equal(statusOf(preflight.task.dir).loop.phase,"开发中");assert.match(statusOf(preflight.task.dir).loop.pendingReturn!,/脚本不存在/);assert.equal(preflight.git("rev-parse","dev"),preflight.before);
  const missing=await finishingFixture(t); transition(missing.task.dir,"working","收尾中","pending",null); await finish(missing.task.dir);
  assert.equal(statusOf(missing.task.dir).loop.wait,"收尾没走完"); assert.match(statusOf(missing.task.dir).message,/合入资格不足/);
  reviewed(missing.task,missing.commit); waitFor(missing.task.dir,"收尾没走完","retry"); await finish(missing.task.dir); assert.equal(statusOf(missing.task.dir).loop.phase,"已部署");
  const pushFail=await finishingFixture(t,{flow:["开发评审","合入","推送"]}); await settle(pushFail.task.dir); await finish(pushFail.task.dir);
  assert.equal(statusOf(pushFail.task.dir).state,"input_required"); assert.match(statusOf(pushFail.task.dir).message,/origin/); assert.equal(statusOf(pushFail.task.dir).loop.deployReturns,0);
  assert.equal(pushFail.git("rev-parse","dev^2"),pushFail.commit); assert.equal(statusOf(pushFail.task.dir).loop.released,false);
  assert.ok(existsSync(pushFail.task.worktree)); assert.ok(!checksOf(pushFail.task.dir).some(c=>c.step==="释放"));
});
test("A7：接力下一批起点是上一批交付；最后一次部署才推进 dev，沿用派单号", async t => {
  const f=await finishingFixture(t,{flow:flow.slice(0,2)}), nextCard=join(f.repo,"next.json");
  write(nextCard,JSON.stringify({...f.raw,flow:flow.slice(0,4)})); write(f.card,JSON.stringify({...f.raw,next:"next.json"}));
  const first=createTask(f.card,f.root,"dispatch-chain"); await prepare(first.dir); write(join(first.worktree,"src/first.txt"),"first\n"); const a=deliver(first.dir).commit;
  await settle(first.dir); await startFinish(first.dir,f.env);
  const completed=await until(first.dir,()=>statusOf(first.dir),s=>s.state==="completed" && !s.loop.finisher); assert.ok(completed.loop.next);
  assert.equal(completed.loop.released,false); assert.ok(existsSync(first.worktree)); assert.ok(!checksOf(first.dir).some(c=>c.step==="释放"));
  const second=taskOf(join(f.root,completed.loop.next!)); await until(second.dir,()=>existsSync(join(second.dir,"opened.json")),Boolean);
  await until(second.dir,()=>statusOf(second.dir),s=>!s.loop.launcher); assert.equal(second.baseCommit,a); assert.equal(second.dispatchId,"dispatch-chain"); assert.equal(f.git("rev-parse","dev"),f.before);
  assert.equal(readFileSync(join(second.worktree,"src/first.txt"),"utf8"),"first\n"); write(join(second.worktree,"src/second.txt"),"second\n"); deliver(second.dir); await settle(second.dir);
  await f.cli(["收尾",second.executionId,"--json"]); assert.equal(statusOf(second.dir).state,"completed"); assert.equal(f.git("show","dev:src/first.txt"),"first"); assert.equal(f.git("show","dev:src/second.txt"),"second");
  assert.match(readFileSync(join(f.repo,"结果.md"),"utf8"),/版本：[\s\S]*证据：[\s\S]*恢复入口：[\s\S]*验收标准：/);
});
test("W1 A18 / 问题单 A4：真实必修退回，返修正式通过才接力，恢复和重放只开一次", async t => {
  const reviewer = 'if grep -q needs-repair src/app.txt; then printf %s ' + sq(MUST) + '; else printf %s ' + sq(PASS) + '; fi';
  const f = fixture(t, {reviewer, card: {next: "next.json"}});
  write(join(f.repo, "next.json"), JSON.stringify({...f.raw, next: undefined}));
  const first = await f.prepare();
  write(join(first.worktree, "src/app.txt"), "good needs-repair\n");
  const B = deliver(first.dir).commit, required = await settle(first.dir);
  await startFinish(first.dir, f.env);
  const returned = statusOf(first.dir), dirsOnReturn = readdirSync(f.root);
  assert.equal(required.continue, true);
  assert.match(required.reason, /评审必修：[\s\S]*src\/app.txt:1/);
  assert.equal(returned.loop.phase, "开发中"); assert.equal(returned.loop.next, undefined);
  assert.deepEqual(dirsOnReturn, [first.executionId]);
  write(join(first.worktree, "src/app.txt"), "good repaired\n");
  const repaired = deliver(first.dir).commit;
  await settle(first.dir); await startFinish(first.dir, f.env);
  const completed = await until(first.dir, () => statusOf(first.dir), s => s.state === "completed" && !s.loop.finisher);
  const next = taskOf(join(f.root, completed.loop.next!));
  await until(next.dir, () => existsSync(join(next.dir, "opened.json")), Boolean);
  await until(next.dir, () => statusOf(next.dir), s => !s.loop.launcher);
  await settle(first.dir); await startFinish(first.dir, f.env);
  const resumed = JSON.parse((await f.cli(["续跑", first.executionId, "--json"])).stdout);
  await assert.rejects(f.cli(["收尾", first.executionId, "--auto", "--json"]), /当前不在待收尾/);
  const checks = checksOf(first.dir).filter(c => ["复测", "评审", "收尾"].includes(c.step)).map(({step, result, commit}) => ({step, result, commit}));
  t.diagnostic(JSON.stringify({B, repaired, returned: returned.loop.phase, dirsOnReturn, end: completed.loop.phase, nextBase: next.baseCommit, replayNext: statusOf(first.dir).loop.next, dirs: readdirSync(f.root), checks}));
  assert.equal(resumed.reused, true);
  assert.equal(next.baseCommit, repaired);
  assert.equal(statusOf(first.dir).loop.next, next.executionId);
  assert.deepEqual(readdirSync(f.root).sort(), [first.executionId, next.executionId].sort());
  assert.deepEqual(checks, [["复测", "通过", B], ["评审", "必修", B], ["复测", "通过", repaired], ["评审", "通过", repaired], ["收尾", "通过", repaired]].map(([step, result, commit]) => ({step, result, commit})));
});

for (const afterDispatch of [false, true]) test("W1 r1 必修4 / A18：收尾中断后同一下一卡只启动一次 · " + (afterDispatch ? "派发后" : "已分配、派发前"), async t => {
  const f = fixture(t, {card: {next: "next.json"}});
  write(join(f.repo, "next.json"), JSON.stringify({...f.raw, next: undefined}));
  write(f.env.LOOP_LAUNCH_CMD!, "#!" + NODE + '\nrequire("fs").appendFileSync(process.env.LOOP_TASK_DIR+"/opens","open\\n");\n');
  const first = await f.prepare(), {commit} = deliver(first.dir);
  await settle(first.dir);
  const fault = `
import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const method = ${JSON.stringify(afterDispatch ? "appendFileSync" : "openSync")}, original = fs[method];
fs[method] = (path, ...args) => {
  if (String(path).endsWith(${JSON.stringify(afterDispatch ? "/结果.md" : "/launcher.log")})) process.exit(71);
  return original(path, ...args);
};
syncBuiltinESMExports();
const {finish} = await import(${JSON.stringify(join(ROOT, "src/cli/finish.ts"))});
await finish(process.argv[1]);
`;
  const finisher = spawn(NODE, ["--input-type=module", "-e", fault, first.dir], {env: f.env, stdio: "inherit"});
  assert.deepEqual(await new Promise(resolve => finisher.once("exit", (...args) => resolve(args))), [71, null]);
  const interrupted = statusOf(first.dir), next = taskOf(join(f.root, interrupted.loop.next!)), opens = join(next.dir, "opens");
  assert.equal(interrupted.loop.phase, "收尾中"); assert.equal(interrupted.loop.finisher?.pid, finisher.pid);
  if (afterDispatch) await until(next.dir, () => existsSync(opens), Boolean);
  else assert.equal(existsSync(join(next.dir, "launcher.log")), false);
  const receipt = JSON.parse((await f.cli(["收尾", first.executionId, "--json"])).stdout);
  const materialized = existsSync(join(next.dir, "launcher.log"));
  t.diagnostic(JSON.stringify({commit, interrupted: interrupted.loop.phase, allocated: next.executionId, afterDispatch, receipt: receipt.state, materialized, ready: statusOf(next.dir).loop.ready}));
  assert.equal(receipt.loop.next, next.executionId);
  assert.equal(receipt.state, "completed");
  assert.equal(next.baseCommit, commit);
  assert.equal(materialized, true);
  await until(next.dir, () => statusOf(next.dir), s => s.loop.ready && !s.loop.launcher);
  await settle(first.dir); await startFinish(first.dir, f.env);
  await assert.rejects(f.cli(["收尾", first.executionId, "--json"]), /当前不在待收尾/);
  assert.equal(readFileSync(opens, "utf8"), "open\n");
  assert.deepEqual(readdirSync(f.root).sort(), [first.executionId, next.executionId].sort());
});

for (const after of [false, true]) test("W1 D21：实际开发开场写明登记授权、命令和收尾边界 · " + (after ? "自动收尾" : "无自动收尾"), async t => {
  const f = fixture(t, {card: {flow: after ? flow.slice(0, 3) : flow.slice(0, 2)}}), task = await f.prepare();
  await launchSession(task.dir, false, {env: f.env});
  const prompt = readFileSync(join(task.dir, "developer-prompt.md"), "utf8");
  const opening = prompt.split("\n\n")[0]; t.diagnostic(opening.replaceAll("\n", " / "));
  assert.ok(opening.includes("本会话是本人已明确授权由 dev-loop 管理的开发卡；开发完成后按本批说明登记交付。"));
  assert.ok(opening.includes(ROOT + "/bin/loop 交付"));
  assert.match(opening, /交付只提交并登记/);
  if (after) assert.match(opening, /通过后自动收尾。不要手工合入、推送或部署/);
  else assert.ok(opening.includes("用户要求合入或部署时") && opening.includes(ROOT + "/bin/loop 合入 " + task.executionId) && opening.includes(ROOT + "/bin/loop 部署 " + task.executionId));
});

test("固定说明、帮助、结果追加与待验数；不把部署成功当人工验收", async t => {
  const f=await finishingFixture(t);assert.match(convention(f.task),/通过后自动收尾。不要手工合入、推送或部署/);
  assert.match(convention({executionId:"old"}),/报错就把原文告诉用户，不要现场编步骤/);
  await launchSession(f.task.dir,false,{env:f.env});assert.match(readFileSync(join(f.task.dir,"developer-prompt.md"),"utf8"),/不要手工合入、推送或部署/);
  const card=join(f.repo,"batches/current/card.json");write(card,"{}");write(join(f.repo,"batches/current/验收.md"),"状态：待验\n");write(join(f.repo,"batches/other/验收.md"),"状态：待验\n");write(join(f.repo,"batches/done/验收.md"),"状态：通过\n");assert.equal(pendingAcceptance(card),1);
  write(join(f.repo,"结果.md"),"# 协调方已有结论\n");await settle(f.task.dir);await finish(f.task.dir);assert.match(readFileSync(join(f.repo,"结果.md"),"utf8"),/^# 协调方已有结论[\s\S]*版本：/);
  const help=(await f.cli(["帮助"])).stdout;for(const word of ["收尾","退回","对比","陪跑","释放","deploy.env","next"])assert.ok(help.includes(word));
});
test("排队每 60 秒保持心跳；手工合入/部署/退回也排队不拒绝", async t => {
  const f=await finishingFixture(t);reviewed(f.task,f.commit);const path=projectFile(f.root,f.task.repo,"queue");
  for(const command of ["合入","部署","退回"]){
    const unlock=lock(path), waiting=f.cli([command,f.task.executionId,"--json"]);
    await until(f.task.dir,()=>statusOf(f.task.dir),s=>s.message.includes("排队中"));unlock();await waiting;
  }
  transition(f.task.dir,"working","收尾中","waiting",null);
  t.mock.timers.enable({apis:["setInterval","Date"],now:Date.now()});const unlock=lock(path),before=statusOf(f.task.dir);
  const waiting=queued(f.task.dir,()=>"acquired");t.mock.timers.tick(60001);assert.ok(statusOf(f.task.dir).seq>before.seq);assert.ok(Date.parse(statusOf(f.task.dir).updatedAt)>Date.parse(before.updatedAt));unlock();assert.equal(await waiting,"acquired");
});
test("收尾崩溃转等你，可手工接手；提示词变化不重复自动部署同 commit", async t => {
  const f=await finishingFixture(t);await settle(f.task.dir);update(f.task.dir,s=>{s.loop.finisher={pid:2147483646,startedAt:"dead"};s.loop.phase="部署中";});
  await settle(f.task.dir);assert.equal(statusOf(f.task.dir).loop.wait,"收尾没走完");await startFinish(f.task.dir,f.env);assert.equal(existsSync(join(f.task.dir,"calls.jsonl")),false);
  await f.cli(["收尾",f.task.executionId,"--json"]);assert.equal(statusOf(f.task.dir).loop.phase,"已部署");
  write(join(f.repo,"prompt.md"),"补充要求，代码不变\n");await settle(f.task.dir);await startFinish(f.task.dir,f.env);
  assert.equal(statusOf(f.task.dir).state,"completed");assert.equal(statusOf(f.task.dir).loop.phase,"已部署");assert.equal(received(f.task.dir).length,2);
});
test("失败返修时原会话已结束：独立进程精确恢复原 Pi 会话并保留 pendingReturn", async t => {
  const f=await finishingFixture(t,{check:"console.log('restore reason');process.exit(7);"});update(f.task.dir,s=>{s.loop.session!.endedAt=new Date().toISOString();});
  await settle(f.task.dir);await startFinish(f.task.dir,f.env);const opened=await until(f.task.dir,()=>getJson<{args:string[]}>(join(f.task.dir,"opened.json")),Boolean);
  await until(f.task.dir,()=>statusOf(f.task.dir),s=>!s.loop.launcher && !s.loop.finisher);assert.ok(opened.args.includes("--session"));assert.ok(opened.args.includes("fake"));assert.match(statusOf(f.task.dir).loop.pendingReturn!,/restore reason/);assert.equal(statusOf(f.task.dir).loop.phase,"开发中");
});
test("flow 子序列、after/next 快照、基点覆盖；旧卡无收尾", t => {
  const f = fixture(t), first = createTask(f.card, f.root);
  assert.deepEqual(first.after, []);
  for (const selected of [flow, ["开发评审", "合入"], ["开发评审", "合入", "推送"]]) {
    write(f.card, JSON.stringify({...f.raw, flow: selected}));
    assert.deepEqual(readCard(f.card).card.after, selected.filter(s => !["开发评审", "测试"].includes(s)));
  }
  for (const selected of [["测试"], ["开发评审", "部署"], ["开发评审", "推送"], ["开发评审", "合入", "测试"], ["开发评审", "合入", "合入"]]) {
    write(f.card, JSON.stringify({...f.raw, flow: selected})); assert.throws(() => readCard(f.card));
  }
  const next = join(f.repo, "next.json"); write(next, JSON.stringify(f.raw));
  write(f.card, JSON.stringify({...f.raw, next: "next.json"})); validateStart(f.card);
  const task = createTask(f.card, f.root, "dispatch", first.baseCommit);
  assert.equal(task.next, realpathSync(next)); assert.equal(task.baseCommit, first.baseCommit);
  write(f.card, JSON.stringify({...f.raw, flow})); assert.deepEqual(taskOf(task.dir).after, []);
});
test("启动整链预检：部署登记、origin、坏卡、环、中间批收尾均不建目录；不预查脚本", async t => {
  const f = fixture(t);
  for (const deploy of [undefined, {cmd:"missing"}, {cmd:"missing", check:"missing"}]) {
    write(join(f.repo,".autoreview.json"), JSON.stringify({deploy})); write(f.card, JSON.stringify({...f.raw, flow:flow.slice(0,4)}));
    await assert.rejects(f.cli(["启动", f.card, "--json"]), /Command failed/); assert.deepEqual(readdirSync(f.root), []);
  }
  write(join(f.repo,".autoreview.json"), JSON.stringify({deploy:{cmd:"missing",check:"missing",rollback:"missing"}}));
  assert.doesNotThrow(() => validateStart(f.card));
  write(f.card, JSON.stringify({...f.raw, flow})); assert.throws(() => validateStart(f.card), /origin/);
  const next = join(f.repo,"next.json");
  write(f.card, JSON.stringify({...f.raw, next:"next.json"}));
  for (const raw of ["invalid", JSON.stringify({...f.raw,next:"card.json"}), JSON.stringify({...f.raw,flow:["开发评审","合入"],next:"card.json"})]) {
    write(next, raw); await assert.rejects(f.cli(["启动",f.card,"--json"])); assert.deepEqual(readdirSync(f.root), []);
  }
});

test("返修必修1：部署前发现阻碍快进的本地改动，保留索引和文件，线上不动",async t=>{
  const f=await finishingFixture(t);await settle(f.task.dir);write(join(f.repo,"结果.md"),"existing notes\n");
  write(join(f.repo,"src/app.txt"),"user unsaved app\n");write(join(f.repo,"outside.txt"),"user staged outside\n");f.git("add","outside.txt");
  const dirty=f.git("status","--porcelain=v1"),index=f.git("write-tree");await finish(f.task.dir);
  assert.equal(statusOf(f.task.dir).state,"input_required");assert.match(statusOf(f.task.dir).message,/overwritten|not uptodate|快进/);
  assert.equal(existsSync(join(f.task.dir,"calls.jsonl")),false);assert.equal(f.git("rev-parse","dev"),f.before);
  assert.equal(f.git("status","--porcelain=v1"),dirty);assert.equal(f.git("write-tree"),index);assert.equal(readFileSync(join(f.repo,"src/app.txt"),"utf8"),"user unsaved app\n");
});
test("返修必修1：无关的暂存、未暂存和未跟踪文件不阻断自动部署",async t=>{
  const f=await finishingFixture(t);await settle(f.task.dir);write(join(f.repo,"结果.md"),"existing notes\n");
  write(join(f.repo,"outside.txt"),"user staged\n");f.git("add","outside.txt");write(join(f.repo,"AGENTS.md"),"user unstaged\n");write(join(f.repo,"untracked.txt"),"user untracked\n");
  const dirty=f.git("status","--porcelain=v1");await finish(f.task.dir);
  assert.equal(statusOf(f.task.dir).state,"completed");assert.notEqual(f.git("rev-parse","dev"),f.before);assert.equal(received(f.task.dir).length,2);
  assert.equal(f.git("status","--porcelain=v1"),dirty);assert.equal(f.git("show",":outside.txt"),"user staged");assert.equal(readFileSync(join(f.repo,"untracked.txt"),"utf8"),"user untracked\n");
});
for(const rollbackFails of [false,true])test("返修必修1：部署期间新增快进障碍，在项目锁内补偿，回退失败="+rollbackFails,async t=>{
  const f=await finishingFixture(t,{cmd:"fs.writeFileSync(path.join(e.LOOP_REPO,'src/app.txt'),'user edit during deploy\\n');",rollback:
    "const crypto=require('crypto'),queue=path.join(path.dirname(dir),'.queue-'+crypto.createHash('sha256').update(e.LOOP_REPO).digest('hex').slice(0,20)+'.lock');fs.writeFileSync(evidence+'/queue-held',String(fs.existsSync(queue)));"+(rollbackFails?"process.exit(9);":"")});
  await settle(f.task.dir);write(join(f.repo,"outside.txt"),"user staged\n");f.git("add","outside.txt");const index=f.git("write-tree");
  const marker=projectFile(f.root,f.task.repo,"deployed"),previous={executionId:f.task.executionId,commit:f.before,evidenceDir:join(f.task.dir,"previous-deployment"),rollback:"rollback.cjs"};
  write(join(previous.evidenceDir,"record.txt"),"previous evidence\n");write(marker,JSON.stringify(previous));await finish(f.task.dir);
  const state=statusOf(f.task.dir);assert.equal(state.state,"input_required");assert.equal(state.loop.wait,"收尾没走完");assert.match(state.message,rollbackFails?/回退也失败/:/线上已回退/);
  assert.deepEqual(received(f.task.dir).map(c=>c.name),["deploy","check","rollback"]);assert.equal(readFileSync(join(received(f.task.dir)[0].evidence,"queue-held"),"utf8"),"true");
  assert.equal(f.git("rev-parse","dev"),f.before);assert.equal(f.git("write-tree"),index);assert.equal(readFileSync(join(f.repo,"src/app.txt"),"utf8"),"user edit during deploy\n");
  assert.equal(state.loop.deployReturns,0);assert.equal(state.loop.pendingReturn,null);
  if(!rollbackFails)assert.deepEqual(getJson(marker),previous);else assert.equal(getJson(marker).commit,received(f.task.dir)[0].commit);
});
for(const phase of ["部署中","已部署","推送中"] as const)test("返修必修3：窗口关闭后可直接收尾接手死亡进程，阶段="+phase,async t=>{
  const f=await finishingFixture(t);await settle(f.task.dir);const dead={pid:process.pid,startedAt:"dead identity"};
  update(f.task.dir,s=>{s.loop.session=null;s.loop.finisher=dead;s.loop.phase=phase;});write(join(f.task.dir,"finish.lock"),JSON.stringify({...dead,token:"old finisher"}));
  await f.cli(["收尾",f.task.executionId,"--json"]);assert.equal(existsSync(join(f.task.dir,"finish.lock")),false);
  assert.equal(statusOf(f.task.dir).state,"completed");assert.equal(statusOf(f.task.dir).loop.phase,"已部署");assert.equal(statusOf(f.task.dir).loop.finisher,null);assert.equal(received(f.task.dir).length,2);
});
for(const fail of [false,true])test("返修必修4：两个自动收尾进程交错取锁，迟到者不重复执行，前者失败="+fail,async t=>{
  const f=await finishingFixture(t,fail?{check:"process.exit(7);",rollback:"process.exit(8);"}:{});await settle(f.task.dir);
  const gate=join(f.base,"finish-gate"),marker=join(f.base,"waiting-for-lock"),hook=join(f.base,"pause-lock.mjs");execFileSync("mkfifo",[gate]);
  write(hook,`import {registerHooks} from 'node:module';registerHooks({load(url,context,next){const result=next(url,context);if(url.endsWith('/src/infra/files.ts'))result.source=String(result.source).replace('export function lock(path: string, waitMs = 0): () => void {',\"export function lock(path: string, waitMs = 0): () => void { if(path.endsWith('/finish.lock') && process.env.REVIEW_FINISH_GATE){writeFileSync(process.env.REVIEW_FINISH_MARKER!, 'waiting');readFileSync(process.env.REVIEW_FINISH_GATE!, 'utf8');}\");return result;}});`);
  const child=spawn(NODE,["--import",hook,join(ROOT,"src/cli/main.ts"),"收尾",f.task.executionId,"--auto","--json"],{cwd:f.repo,env:{...f.env,REVIEW_FINISH_GATE:gate,REVIEW_FINISH_MARKER:marker},stdio:["ignore","pipe","pipe"]});
  let stderr="";child.stderr.setEncoding("utf8");child.stderr.on("data",text=>{stderr+=text;});const exited=new Promise<number|null>((ok,no)=>{child.once("close",ok);child.once("error",no);});
  t.after(()=>{if(child.exitCode===null)child.kill("SIGKILL");});
  await until(f.base,()=>existsSync(marker),Boolean);await f.cli(["收尾",f.task.executionId,"--auto","--json"]);const completed=statusOf(f.task.dir);
  assert.equal(completed.state,fail?"input_required":"completed");write(gate,"continue");assert.equal(await exited,1);assert.match(stderr,/当前不在待收尾|不自动重试/);
  assert.deepEqual(statusOf(f.task.dir),completed);assert.equal(received(f.task.dir).length,fail?3:2);
});
test("返修必修3：死亡收尾不会被宿主原样自动重试，只由手工命令接手",async t=>{
  const f=await finishingFixture(t);await settle(f.task.dir);update(f.task.dir,s=>{s.loop.session=null;s.loop.finisher={pid:process.pid,startedAt:"dead identity"};});
  const before=statusOf(f.task.dir);await startFinish(f.task.dir,f.env);assert.deepEqual(statusOf(f.task.dir),before);assert.equal(existsSync(join(f.task.dir,"finish.log")),false);
  await assert.rejects(f.cli(["收尾",f.task.executionId,"--auto","--json"]),/不自动重试/);assert.deepEqual(statusOf(f.task.dir),before);
  await f.cli(["收尾",f.task.executionId,"--json"]);assert.equal(statusOf(f.task.dir).state,"completed");assert.equal(received(f.task.dir).length,2);
});
test("返修必修4：锁内发现存活 finisher，拒绝且不改状态或清除对方身份",async t=>{
  const f=await finishingFixture(t);await settle(f.task.dir);update(f.task.dir,s=>{s.loop.finisher=identity();});const before=statusOf(f.task.dir);
  await assert.rejects(finish(f.task.dir),/正在收尾/);assert.deepEqual(statusOf(f.task.dir),before);assert.equal(existsSync(join(f.task.dir,"finish.lock")),false);
});
