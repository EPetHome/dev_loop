import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixture, getJson, until, write, ROOT, NODE, PASS, MUST, sq } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { resume, stop } from "../src/core/lifecycle.ts";
import { settle } from "../src/core/settle.ts";
import { appendCheck, checked, checksOf, ENV_WAIT, statusOf, update } from "../src/core/store.ts";
import { gitText } from "../src/infra/git.ts";
import { launchMain } from "../src/hosts/launch.ts";
import { companion } from "../src/cli/companion.ts";
import type { Scenario } from "../src/core/card.ts";

const notice: Scenario = {id:"S4", checks:["启动请求", {id:"同一任务完成通知",expected:1},"重启不再通知"], dependencies:["fake notifier"]};
const second: Scenario = {id:"S3", checks:["原单重投"]};
const defaults = {name:"task", prompt:"prompt.md", scope:["src/**"], test:"node user-check.cjs"};
function e2e(t: TestContext, {scenarios = [notice,second], test = defaults.test, flow = ["开发评审","测试"], reviewer, config}: {
  scenarios?: Scenario[]; test?: string; flow?: string[]; reviewer?: string; config?: Record<string, unknown>
} = {}) {
  const f = fixture(t,{card:{flow,tasks:[{...defaults,test,e2e:scenarios}]},reviewer,config});
  write(join(f.repo,"user-check.cjs"),readFileSync(join(ROOT,"test/e2e-fixture.cjs"),"utf8"));
  f.git("add","user-check.cjs"); f.git("commit","-m","fixture scenarios");
  return f;
}
async function scene(t: TestContext, options?: Parameters<typeof e2e>[1]) {
  const f = e2e(t,options), task = await f.prepare(), dir = task.dir, args = (cmd: string,...extra: string[]) => [cmd,task.executionId,...extra,"--json"];
  return {...f, task, dir, mode: (m: string) => write(join(dir,"mode"),m), view: async () => JSON.parse((await f.cli(args("查询","--brief"))).stdout).executions[0],
    tests: () => checksOf(dir).filter(c => c.step === "复测"), status: () => statusOf(dir), run: (cmd: string,...extra:string[]) => f.cli(args(cmd,...extra)),
    submit: (value = "good delivered\n") => { write(join(task.worktree,"src/app.txt"),value); return deliver(dir); },
    finished: () => until(dir, () => statusOf(dir), s => s.state !== "working" && !s.loop.launcher && !s.loop.finisher)};
}
const raw = (err: {stderr: string}) => JSON.parse(err.stderr).error.raw as string;

test("A1：累计改名两端、删除、常跑；零选中仍验证普通测试；旧卡不接收 E2E 计划", async t => {
  const scenarios = [
    {id:"旧名",paths:["src/old.txt"],checks:["操作"]}, {id:"新名",paths:["src/**/new?.txt"],checks:["操作"]},
    {id:"删除",paths:["src/deleted.txt"],checks:["操作"]}, {id:"每次",checks:["操作"]}, {id:"无关",paths:["other/**"],checks:["操作"]},
  ];
  const f = e2e(t,{scenarios});
  write(join(f.repo,"src/old.txt"),"renamed\n"); write(join(f.repo,"src/deleted.txt"),"delete\n");
  f.git("add","src"); f.git("commit","-m","before rename");
  const task = await f.prepare(), base = task.baseCommit;
  gitText(task.worktree,["mv","src/old.txt","src/new1.txt"]); rmSync(join(task.worktree,"src/deleted.txt")); deliver(task.dir);
  write(join(task.worktree,"src/app.txt"),"later change\n"); const {commit} = deliver(task.dir);
  await settle(task.dir);
  const view = JSON.parse((await f.cli(["查询",task.executionId,"--json"])).stdout).executions[0].loop.retest;
  const [log,planPath,reportPath] = view.evidence, plan = getJson(planPath);
  assert.equal(view.result,"通过"); assert.deepEqual(plan.scenarios.map((c: Scenario) => c.id),["旧名","新名","删除","每次"]);
  assert.deepEqual([plan.commit,plan.attempt,plan.executionId],[commit,view.attempt,task.executionId]);
  assert.ok(plan.promptHash && plan.acceptanceHash && plan.e2eHash && base !== commit); assert.equal(dirname(reportPath),dirname(log));
  assert.ok(view.evidence.every(existsSync));
  const zero = await scene(t,{scenarios:[scenarios[4]]}); zero.submit(); await settle(zero.dir);
  assert.match((await zero.view()).loop.retest.detail,/本次未选中 E2E 场景[\s\S]*普通检查：通过/);
  assert.equal(readFileSync(join(zero.dir,"order"),"utf8"),"test\nreview\n");
  const legacy = fixture(t,{test:'test -z "$LOOP_E2E_DIR"'}), old = await legacy.prepare(); deliver(old.dir); await settle(old.dir);
  const oldView = JSON.parse((await legacy.cli(["查询",old.executionId,"--json"])).stdout).executions[0].loop.retest;
  assert.equal(oldView.result,"通过"); assert.equal(oldView.attempt,undefined); assert.equal(existsSync(join(old.dir,"e2e")),false);
});

for (const [mode, diagnostic, observed] of [["only-stop",/S4 \/ 同一任务完成通知：失败；预期：1；实得：0/,/T17 已停下/],
  ["duplicate-notice",/S4 \/ 同一任务完成通知：失败；预期：1；实得：2/,/T17 已完成.*T17 已完成/],
  ["lying-assertion",/S4 \/ 同一任务完成通知：失败；预期：1；实得：2/,undefined]] as const) {
  test("A2：产品断言退回一次 · " + mode, async t => {
    const g = await scene(t); g.mode(mode); g.submit();
    const r = await settle(g.dir), [check] = g.tests(), view = await g.view();
    assert.equal(r.continue,true); assert.match(r.reason,diagnostic); assert.match(view.loop.retest.detail,diagnostic);
    assert.equal(check.result,"失败"); assert.equal(g.status().loop.testReturns,1); assert.equal(g.status().loop.reviewRounds,0);
    if (observed) assert.match(readFileSync(join(dirname(check.evidence[0]),"s0-1.txt"),"utf8"),observed);
  });
}

for (const [mode, error] of Object.entries({
  "no-report":/result.json 无法读取/, "rewritten-plan":/改写了 plan.json/, "missing-scene":/缺少场景：S3/, "extra-scene":/多报编号.*not-in-plan/,
  "repeat-scene":/重复编号：S4/, "missing-check":/缺少检查点：S4 \/ 重启不再通知/, "repeat-check":/重复编号：启动请求/,
  "wrong-execution":/executionId 不符/, "wrong-commit":/commit 不符/, "wrong-attempt":/attempt 不符/,
  "absolute":/证据路径越界/, "outside":/证据路径越界/, "symlink":/证据越出本次目录/, "hardlink":/不是本次的普通文件/, "missing-evidence":/not-created.txt/,
  "unit-skipped":/普通检查 unit/, "env-fake-error":/诊断和原错/, "env-undeclared":/诊断和原错/, "env-wrong-code":/退出码.*不一致/,
  "env-unit-failed":/普通检查：失败/, "env-product-failed":/actual product failure/,
})) test("A3/A4：材料问题或已知失败不能计通过及环境等待 · " + mode, async t => {
  const g = await scene(t); g.mode(mode); const {commit} = g.submit(); await settle(g.dir);
  const [check] = g.tests(); assert.equal(check.result,"失败"); assert.match(check.detail!,error);
  assert.equal(checked(g.dir,commit),false); assert.equal(g.status().loop.reviewRounds,0); assert.equal(g.status().loop.testReturns,1);
});

for (const [mode, diagnostic] of [
  ["env-product-log", /前置探测[\s\S]*ENOENT: open delivered\/status\.json/],
  ["env-probe-ready", /前置探测.*不可用/],
  ["env-probe-other", /前置探测.*依赖/],
  ["env-probe-stale", /前置探测 attempt 不符/],
  ["env-check-gap", /缺少检查点：S4 \/ 同一任务完成通知/],
] as const) test("评审必修 1/2：有普通通过和退出 75 的错误报告仍须返修 · " + mode, async t => {
  const g = await scene(t); g.mode(mode); const {commit} = g.submit(); const result = await settle(g.dir);
  const [check] = g.tests(), view = await g.view();
  assert.equal(result.continue,true); assert.equal(check.result,"失败"); assert.match(check.detail!,diagnostic);
  assert.equal(view.loop.retest.canAccept,false); assert.equal(view.loop.wait,null); assert.equal(view.loop.testReturns,1);
  assert.equal(checked(g.dir,commit),false);
});

test("A4/A5/A10：环境等待不返修、不合入；并发补跑只执行一次，再按卡收尾", async t => {
  const g = await scene(t,{flow:["开发评审","测试","合入"]}); g.mode("env"); const {commit} = g.submit();
  const before = g.status(); await settle(g.dir);
  const [original] = g.tests(), view = await g.view(), id = original.attempt!;
  assert.equal(view.loop.wait,ENV_WAIT); assert.equal(view.loop.retest.attempt,id); assert.deepEqual(view.loop.retest.missingScenarios,["S4"]);
  assert.match(view.message,new RegExp(id)); assert.match(view.message,/ECONNREFUSED/); assert.equal(view.loop.retest.canAccept,true);
  assert.equal(view.loop.testAllowance,before.loop.testAllowance); assert.equal(view.loop.testReturns,0); assert.equal(g.git("rev-parse","dev"),g.task.baseCommit);
  for (const args of [["答复","--话","请继续"],["续跑","--话","请继续"],["续跑","--接受环境缺项","a-old"]]) {
    await assert.rejects(g.run(args[0],...args.slice(1)), err => new RegExp(id + "[\\s\\S]*补跑[\\s\\S]*接受环境缺项[\\s\\S]*停止").test(raw(err as any)));
  }
  await assert.rejects(g.run("合入"),/合入资格不足/); await assert.rejects(g.run("收尾"),/不在待收尾/);
  assert.equal(existsSync(join(g.dir,"answers.jsonl")),false); assert.equal(existsSync(join(g.dir,"opened.json")),false);
  g.mode("hold");
  const first = g.run("续跑");
  await until(g.dir,() => existsSync(join(g.dir,"test-started")), Boolean);
  await Promise.allSettled([first,g.run("续跑"),g.run("续跑")]);
  assert.equal(g.status().loop.phase,"复测中"); assert.deepEqual(g.tests(),[original]);
  write(join(g.dir,"test-go"),""); const done = await g.finished(), attempts = g.tests();
  assert.equal(done.loop.phase,"已合入"); assert.equal(done.loop.facts?.resumes,1); assert.equal(done.loop.testReturns,0);
  assert.equal(g.git("rev-parse","dev^2"),commit); assert.deepEqual(attempts.map(c=>c.result),["环境未验证","通过"]);
  assert.notEqual(attempts[1].attempt,id); assert.equal(attempts[1].commit,commit);
  assert.ok(attempts.every(c=>c.evidence.every(existsSync))); assert.equal(readFileSync(join(g.dir,"order"),"utf8"),"test\ntest\nreview\n");
});

test("A6/A11：仅同一编号、已通过普通检查可接受；仍须评审；下一提交不继承", async t => {
  const g = await scene(t,{reviewer:`if [ ! -f "$LOOP_TASK_DIR/reviewer-ready" ]; then echo 'review temporarily unavailable'; exit 1; fi; printf %s ${sq(PASS)}`});
  g.submit(); g.mode("env-unit-skipped"); await settle(g.dir);
  const old = g.tests()[0]; assert.equal((await g.view()).loop.retest.canAccept,false);
  await assert.rejects(g.run("续跑","--接受环境缺项",old.attempt!),err => !raw(err as any).includes("--接受环境缺项"));
  g.mode("env"); await g.run("续跑"); await g.finished();
  const next = g.tests().at(-1)!; await assert.rejects(g.run("续跑","--接受环境缺项",old.attempt!),new RegExp(next.attempt!));
  write(join(g.task.worktree,"src/app.txt"),"dirty\n"); assert.equal((await g.view()).loop.retest.canAccept,false);
  await assert.rejects(g.run("续跑","--接受环境缺项",next.attempt!),/尝试编号/);
  write(join(g.task.worktree,"src/app.txt"),"good delivered\n");
  await g.run("续跑","--接受环境缺项",next.attempt!); await g.finished();
  const accepted = g.tests().at(-1)!;
  assert.equal(accepted.result,"本人接受环境缺项"); assert.equal(accepted.attempt,next.attempt); assert.deepEqual(accepted.evidence,next.evidence);
  assert.equal(g.status().loop.facts?.stops.find(x=>x.resolvedBy === "本人接受环境缺项")?.reason,ENV_WAIT);
  assert.equal(checked(g.dir,next.commit),false);
  write(join(g.dir,"reviewer-ready"),""); assert.equal(JSON.parse((await g.run("续跑")).stdout).reviewOnly,true); await g.finished();
  assert.equal(checked(g.dir,next.commit),true); assert.equal(g.tests().length,3); assert.equal(existsSync(join(g.dir,"opened.json")),false);
  const d = g.submit("next delivery\n"); assert.equal(d.reused,false); await settle(g.dir);
  assert.equal(g.status().loop.wait,ENV_WAIT); assert.equal(g.tests().at(-1)?.commit,d.commit); assert.equal(checked(g.dir,d.commit),false);
});

test("A7：停止抢在后台领取前；半份报告不复用；已登记的环境事实恢复到等你", async t => {
  const g = await scene(t); g.submit(); g.mode("env"); await settle(g.dir);
  const [env] = g.tests();
  update(g.dir,s => { s.state = "working"; s.loop.phase = "复测中"; s.loop.wait = null; }); // 写入完整事实后中断
  await g.run("续跑"); assert.equal((await g.finished()).loop.wait,ENV_WAIT); assert.deepEqual(g.tests(),[env]);
  const request = resume(g.dir); stop(g.dir);
  await launchMain(g.dir,false,{env:g.env,retest:request.retest});
  assert.equal(g.status().state,"cancelled"); assert.deepEqual(g.tests(),[env]);
  g.mode("hold"); await g.run("续跑");
  const started = await until(g.dir,() => readFileSync(join(g.dir,"test-started"),"utf8"), Boolean).catch(e => { t.diagnostic(JSON.stringify(g.status())); throw e; });
  await g.run("停止"); assert.equal(g.status().state,"cancelled");
  assert.equal(existsSync(join(g.dir,"e2e",started,"result.json")),false);
  g.mode("pass"); await g.run("续跑"); await g.finished();
  assert.equal(g.status().state,"completed"); assert.equal(g.tests().at(-1)?.result,"通过"); assert.notEqual(g.tests().at(-1)?.attempt,started);
  assert.ok(existsSync(join(g.dir,"e2e",started,"report.tmp")));
});

for (const recordedMetadata of [false,true]) test("评审必修 3：评审必修落盘后中断，只交接原必修 · 元数据已有=" + recordedMetadata, async t => {
  const g = await scene(t,{flow:["开发评审","测试","合入"],reviewer:`if [ "$1" = 1 ]; then printf %s ${sq(MUST)}; else printf %s ${sq(PASS)}; fi`});
  const {commit} = g.submit(); g.mode("env"); await settle(g.dir); g.mode("pass");
  const request = resume(g.dir);
  const cut = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const append = fs.appendFileSync;
fs.appendFileSync = (file, row, ...args) => {
  append(file,row,...args);
  if (String(file).endsWith('/checks.jsonl') && String(row).includes('"step":"评审"') && String(row).includes('"result":"必修"')) process.exit(71);
};
syncBuiltinESMExports();
const {launchMain} = await import(${JSON.stringify(join(ROOT,"src/hosts/launch.ts"))});
await launchMain(process.argv[1], false, {retest:process.argv[2]});`;
  const worker = spawn(NODE,["--input-type=module","-e",cut,g.dir,request.retest!],{cwd:g.repo,env:g.env,stdio:"inherit"});
  assert.deepEqual(await once(worker,"close"),[71,null]);
  const reviews = () => checksOf(g.dir).filter(c => c.step === "评审"), [decision] = reviews();
  assert.equal(decision.result,"必修"); assert.equal(decision.attempt,request.retest); assert.equal(g.status().loop.reviewReturns,0);
  if (recordedMetadata) update(g.dir,s => { s.loop.previousReviewCommit = commit; s.loop.previousMustFix = [decision.detail!]; });
  await g.run("续跑");
  const resumed = await until(g.dir,() => g.status(),s => !s.loop.launcher && ["开发中","已合入","失败"].includes(s.loop.phase));
  assert.equal(resumed.loop.phase,"开发中"); assert.equal(resumed.loop.reviewReturns,1); assert.equal(resumed.loop.reviewRounds,1);
  assert.match(resumed.loop.pendingReturn!,/输入 bad 时[\s\S]*返回错误结果/); assert.equal(g.git("rev-parse","dev"),g.task.baseCommit);
  await launchMain(g.dir,false,{env:g.env,retest:request.retest});
  assert.deepEqual(reviews(),[decision]); assert.equal(g.status().loop.reviewReturns,1); assert.equal(checked(g.dir,commit),false);
});

test("评审必修 4：无 launcher 的已认领补跑拒绝附言；同一请求可接管", async t => {
  const g = await scene(t); g.submit(); g.mode("env"); await settle(g.dir);
  const first = resume(g.dir), claimed = g.status();
  assert.equal(claimed.loop.launcher,null); assert.equal(claimed.loop.phase,"复测中"); assert.ok(first.retest);
  await assert.rejects(g.run("续跑","--话","不要开开发"),err => /复测/.test(raw(err as any)) && raw(err as any).includes(first.retest!));
  assert.deepEqual(g.status(),claimed); assert.equal(existsSync(join(g.dir,"opened.json")),false);
  g.mode("pass"); const receipt = JSON.parse((await g.run("续跑")).stdout);
  assert.equal(receipt.retest,first.retest); await g.finished();
  await launchMain(g.dir,false,{env:g.env,retest:first.retest});
  assert.equal(g.status().loop.facts?.resumes,1); assert.deepEqual(g.tests().map(c => c.result),["环境未验证","通过"]);
  assert.equal(g.tests().at(-1)?.attempt,first.retest); assert.equal(existsSync(join(g.dir,"opened.json")),false);
});

test("A8：接入卡无测试命令只提示、记没验证，不走自动收尾；旧卡原样", async t => {
  const g = e2e(t,{test:"无：无可运行的检查",flow:["开发评审","测试","合入"]});
  const {taskDir:dir, warnings} = JSON.parse((await g.cli(["启动",g.card,"--json"])).stdout);
  assert.match(warnings[0],/没有执行命令/);
  const s = await until(dir,() => statusOf(dir), s => s.loop.ready && !s.loop.launcher && existsSync(join(dir,"opened.json")));
  const d = deliver(dir); await settle(dir);
  assert.equal(statusOf(dir).loop.wait,"收尾没走完"); assert.equal(checked(dir,d.commit),false);
  const check = checksOf(dir).find(c=>c.step === "复测")!;
  assert.equal(check.result,"没验证"); assert.match(check.detail!,/没有执行命令/); assert.equal(s.loop.testReturns,0);
  const old = fixture(t,{test:"无：本批没有检查"}), task = await old.prepare(); const legacy = deliver(task.dir);
  await settle(task.dir); assert.equal(checked(task.dir,legacy.commit),true);
});

test("A9：挪走已通过证据不改资格；正式改清单后查询提示过期，同 SHA 续跑新检查", async t => {
  const g = await scene(t); const {commit} = g.submit(); await settle(g.dir);
  const [pass] = g.tests(); for (const file of pass.evidence) renameSync(file,file+".archived");
  assert.equal(checked(g.dir,commit),true); assert.equal((await g.view()).loop.retest.stale,false);
  const card = getJson(g.card); card.tasks[0].e2e[0].checks.push("新预期"); write(g.card,JSON.stringify(card));
  const stale = await g.view(); assert.equal(stale.loop.retest.stale,true); assert.match(stale.message,/原复测结论不再算数/);
  await assert.rejects(g.run("合入"),/E2E 清单已变化/); assert.equal(checked(g.dir,commit),false);
  await g.run("续跑"); await g.finished();
  const again = g.tests().at(-1)!; assert.equal(again.commit,commit); assert.notEqual(again.e2eHash,pass.e2eHash); assert.notEqual(again.attempt,pass.attempt);
  assert.match(again.detail!,/新预期：通过/); assert.equal(checked(g.dir,commit),true);
  assert.equal(existsSync(join(g.dir,"opened.json")),false);
});

test("接力等复测与对应评审：同输入有旧通过也不跳过本次等待", async t => {
  const g = e2e(t);
  const next = join(g.repo,"second.json"), nextCard = {...g.raw, name:"second", tasks:[defaults]};
  write(next,JSON.stringify(nextCard)); write(g.card,JSON.stringify({...g.raw,next:"second.json"}));
  const task = await g.prepare(), dir = task.dir;
  deliver(dir); write(join(dir,"mode"),"env"); await settle(dir);
  const env = checksOf(dir).find(c => c.step === "复测")!;
  assert.equal(statusOf(dir).loop.wait,ENV_WAIT); assert.equal(statusOf(dir).loop.next,undefined);
  assert.equal(g.git("rev-parse","dev"),task.baseCommit);
  const older = {...env, attempt:"older-attempt", result:"通过", missingScenarios:[]};
  // Model a completed older attempt followed by the recorded environment result.
  appendCheck(dir,older); appendCheck(dir,{...older,step:"评审"}); appendCheck(dir,env);
  assert.equal(checked(dir,env.commit),false);
  await assert.rejects(g.cli(["收尾",task.executionId,"--json"]),/不在待收尾/);
  const cli = (attempt:string) => g.cli(["续跑",task.executionId,"--接受环境缺项",attempt,"--json"]);
  const claims = await Promise.allSettled([cli(env.attempt!),cli(env.attempt!)]);
  assert.equal(claims.filter(x => x.status === "fulfilled").length,1);
  const final = await until(dir,() => statusOf(dir),s => s.state === "completed" && !s.loop.launcher && !s.loop.finisher);
  assert.ok(final.loop.next); assert.equal(g.git("rev-parse","dev"),task.baseCommit);
  const accepted = checksOf(dir).filter(c => c.step === "复测" && c.result === "本人接受环境缺项");
  assert.equal(accepted.length,1); assert.equal(accepted[0].attempt,env.attempt);
  assert.equal(checked(dir,env.commit),true);
});

test("评审只取本轮与历史失败摘要及原文位置；接入卡不重复采 scenario", async t => {
  const g = e2e(t,{config:{snapshot:"snap.sh"}});
  write(join(g.repo,"snap.sh"),'#!/bin/sh\necho "{\"called\":true}" > "$LOOP_SNAPSHOT_OUT"\n');
  g.git("add","--chmod=+x","snap.sh"); g.git("commit","-m","legacy scenario snapshot");
  const task = await g.prepare(); await companion(task.dir);
  write(join(task.dir,"mode"),"only-stop"); const failed = deliver(task.dir); await settle(task.dir);
  write(join(task.dir,"mode"),"pass"); write(join(task.worktree,"src/app.txt"),"corrected\n"); const ok = deliver(task.dir); await settle(task.dir);
  const input = readFileSync(join(task.dir,"review-input-r1.md"),"utf8"), evidence = checksOf(task.dir).filter(c=>c.step === "复测");
  assert.match(input,/本轮 E2E[\s\S]*同一任务完成通知：通过[\s\S]*历史失败/); assert.ok(input.includes(evidence[0].attempt!) && input.includes(evidence[1].attempt!));
  assert.ok(input.includes(evidence[0].evidence[0])); assert.doesNotMatch(input,/T17 已停下/);
  for (const path of ["snapshot-base.json","snapshot-"+failed.commit+".json","snapshot-"+ok.commit+".json"]) assert.equal(existsSync(join(task.dir,path)),false);
});
