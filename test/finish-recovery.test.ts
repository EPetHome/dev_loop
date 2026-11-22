import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, realpathSync, readFileSync, existsSync } from "node:fs";
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
import { prepare } from "../src/core/lifecycle.ts";
import { readCard } from "../src/core/card.ts";
import { createTask, taskOf, statusOf, transition, update, checksOf } from "../src/core/store.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { identity } from "../src/infra/exec.ts";
import { reviewed } from "./step-helpers.ts";
import { validateStart } from "../src/cli/start.ts";
import { flow, finishingFixture, received } from "./finish-helpers.ts";
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
