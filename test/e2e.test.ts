import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fixture, ROOT, write, deliver, settle, getJson } from "./helpers.ts";
import { e2eResult, planE2e } from "../src/core/e2e.ts";
import { gitText } from "../src/infra/git.ts";
import { binding } from "../src/core/inputs.ts";
import { Ledger } from "../src/core/store.ts";
import { state } from "../src/core/state.ts";
import { randomUUID } from "node:crypto";
import type { Scenario } from "../src/core/card.ts";
import { execFileSync } from "node:child_process";
const scenarios:Scenario[]=[{id:"S4",checks:["启动请求",{id:"同一任务完成通知",expected:1},"重启不再通知"],dependencies:["fake notifier"]},{id:"S3",checks:["原单重投"]}];
function project(t:any,list=scenarios) {
  const f=fixture(t,{config:{retry:{times:0}},card:{tasks:[{name:"task",prompt:"prompt.md",scope:["src/**"],test:"node user-check.cjs",e2e:list}]}});
  write(join(f.repo,"user-check.cjs"),readFileSync(join(ROOT,"test/e2e-fixture.cjs")));f.git("add","user-check.cjs");f.git("commit","-m","fixture E2E");return f;
}
test("E2E · 累计改名两端、删除、常跑；编号、证据和报告绑定收货提交",async t=>{
  const list=[{id:"old",paths:["src/old.txt"],checks:["old"]},{id:"new",paths:["src/**/new?.txt"],checks:["new"]},{id:"deleted",paths:["src/del.txt"],checks:["del"]},{id:"always",checks:["always"]},{id:"unrelated",paths:["other/**"],checks:["not selected"]}];
  const f=project(t,list);for(const p of ["old","del"])write(join(f.repo,`src/${p}.txt`),p);f.git("add","src");f.git("commit","-m","old layout");
  const x=await f.prepare();gitText(x.worktree,["mv","src/old.txt","src/new1.txt"]);rmSync(join(x.worktree,"src/del.txt"));deliver(x.dir);
  write(join(x.worktree,"src/app.txt"),"later change\n");const {commit}=deliver(x.dir);await settle(x.dir);
  const l=new Ledger(x.dir), c=l.last("复测")!.check!, plan=getJson(c.evidence[1]);assert.deepEqual(plan.scenarios.map(s=>s.id),["old","new","deleted","always"]);
  assert.deepEqual([plan.commit,plan.attempt,plan.executionId],[commit,c.attempt,x.executionId]);assert(c.evidence.every(existsSync));assert(state(l).proofs?.verified);
  write(f.card,JSON.stringify({...getJson(f.card),tasks:[{...getJson(f.card).tasks[0],e2e:[]}]}));await settle(x.dir);
  const next=new Ledger(x.dir).last("复测")!.check!;assert.notEqual(next.attempt,c.attempt);assert.deepEqual(getJson(next.evidence[1]).scenarios,[]);
});

test("E2E · 退出 75 与绑定的外部探测一致才是环境缺项；不造通过",async t=>{
  const f=project(t), x=await f.prepare();write(join(x.worktree,"src/app.txt"),"new\n");const {commit}=deliver(x.dir);
  write(join(x.dir,"mode"),"env");const l=await f.pump(x.dir,l=>!!state(l).wait);assert.equal(l.last("复测")?.check?.result,"环境未验证");
  assert.equal(state(l).wait?.wait,"环境修不好");assert(!l.last("评审"));assert.equal(state(l).returned("复测").length,0);
  await assert.rejects(f.call(["合入",x.executionId]));write(join(x.dir,"mode"),"pass");await f.call(["续跑",x.executionId]);
  const done=await f.pump(x.dir,c=>!!c.last("完成"));assert.equal(done.last("评审")!.sha,commit);
});

test("R2-6 · 起点对照沿用交付版场景计划，路径限定的共同失败不扣轮",async t=>{
  const f=project(t,[{id:"S4",paths:["src/app.txt"],checks:[{id:"同一任务完成通知",expected:1}]}]),x=await f.prepare();
  write(join(x.worktree,"src/app.txt"),"new\n");const {commit}=deliver(x.dir);write(join(x.dir,"mode"),"only-stop");
  const l=await f.pump(x.dir,l=>!!state(l).wait || !!l.last("发回"),4000), c=l.last("复测")!.check!;
  const plans=c.evidence.filter(p=>p.endsWith("/plan.json")).map(p=>getJson(p));assert.equal(plans.length,2);
  assert.deepEqual(plans.map(p=>p.commit),[commit,x.baseCommit]);assert.deepEqual(plans[0].scenarios,plans[1].scenarios);assert.equal(plans[1].scenarios[0].id,"S4");
  assert.equal(c.result,"环境未验证");assert.equal(state(l).wait?.wait,"环境修不好");assert.equal(state(l).returned("复测").length,0);
});

test("E2E · 不完整、串编号、篡改计划、证据越界和实得不符都不能计通过",async t=>{
  const f=project(t), x=await f.prepare();write(join(x.worktree,"src/app.txt"),"new\n");const {commit}=deliver(x.dir), l=new Ledger(x.dir), b=binding(l,commit);
  const modes={"only-stop":/预期：1；实得：0/,"duplicate-notice":/预期：1；实得：2/,"lying-assertion":/预期：1；实得：2/,
    "no-report":/result.json 无法读取/,"rewritten-plan":/改写了 plan.json/,"missing-scene":/缺少场景/,"extra-scene":/多报编号/,"repeat-scene":/重复编号/,
    "missing-check":/缺少检查点/,"repeat-check":/重复编号/,"wrong-execution":/executionId 不符/,"wrong-commit":/commit 不符/,"wrong-attempt":/attempt 不符/,
    "absolute":/证据路径越界/,"outside":/证据路径越界/,"symlink":/证据越出本次目录/,"hardlink":/不是本次的普通文件/,"missing-evidence":/not-created.txt/,
    "unit-skipped":/普通检查 unit/,"env-fake-error":/诊断和原错/,"env-undeclared":/诊断和原错/,"env-wrong-code":/退出码.*不一致/,"env-product-log":/前置探测/,"env-probe-stale":/attempt 不符/,"env-probe-ready":/不可用/,"env-probe-other":/依赖/,"env-check-gap":/缺少检查点/};
  for (const [mode,reason] of Object.entries(modes)) {
    const p=planE2e(x,commit,randomUUID(),b.hashes,scenarios);write(join(x.dir,"mode"),mode);let code=0;
    try{execFileSync(process.execPath,[join(x.worktree,"user-check.cjs")],{env:{...f.env,LOOP_TASK_DIR:x.dir,LOOP_E2E_DIR:p.dir}});}catch(e:any){code=e.status;}
    const r=e2eResult(p,x.test,{code,killed:false});assert.equal(r.result,"失败",mode);assert.match(r.detail,reason,mode);
  }
});
