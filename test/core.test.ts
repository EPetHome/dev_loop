import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fixture, write, MUST, PASS, sq } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { statusOf, checksOf, createTask, PHASES, fail } from "../src/core/store.ts";
import { gitText, head } from "../src/infra/git.ts";
import { parseScope, inScope } from "../src/core/card.ts";
import { resume, stop } from "../src/core/lifecycle.ts";
import { launchSession } from "../src/hosts/launch.ts";

test("A2 core：复测先于评审，成功绑定交付 commit", async (t) => {
  const f = fixture(t), task = await f.prepare();
  assert.equal(readFileSync(join(task.worktree, "local.txt"), "utf8"), "local secret fixture\n");
  write(join(task.worktree, "src/app.txt"), "good changed\n");
  const d = deliver(task.dir, "完成 good");
  assert.equal((await settle(task.dir, "交付说明")).continue, false);
  assert.equal(statusOf(task.dir).state, "completed");
  assert.equal(readFileSync(join(task.dir, "order"), "utf8"), "test\nreview\n");
  assert.deepEqual(checksOf(task.dir).filter(c => c.commit === d.commit && ["复测","评审"].includes(c.step)).map(c => [c.step,c.result]), [["复测","通过"],["评审","通过"]]);
  const count = gitText(task.worktree, ["rev-list","--count","HEAD"]);
  assert.equal(deliver(task.dir).commit, d.commit);
  assert.equal(gitText(task.worktree, ["rev-list","--count","HEAD"]), count);
});
test("A3：复测失败含命令、尾部与错误行；不评审", async (t) => {
  const f = fixture(t), task = await f.prepare();
  write(join(task.worktree,"src/app.txt"),"bad\n"); deliver(task.dir);
  const r = await settle(task.dir);
  assert.equal(r.continue,true); assert.match(r.reason,/命令：/); assert.match(r.reason,/输出最后 60 行：[\s\S]*tail marker/);
  assert.match(r.reason,/error\/fail 行：[\s\S]*Error: failed/);
  assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\n");
  assert.equal(statusOf(task.dir).loop.testReturns,1); assert.equal(statusOf(task.dir).loop.reviewRounds,0);
});
test("A4：必修退回与增量复审；建议/疑问不退回", async (t) => {
  const f = fixture(t, { reviewer: 'if [ "$1" = 1 ]; then printf %s ' + sq(MUST) + '; else printf %s ' + sq(PASS) + '; fi' }), task = await f.prepare();
  write(join(task.worktree,"src/app.txt"),"good first\n"); deliver(task.dir,"first delivery");
  const first = await settle(task.dir, "开发第一次说明");
  assert.equal(first.continue,true); assert.match(first.reason,/src\/app.txt:1/); assert.match(first.reason,/触发：输入 bad/);
  assert.doesNotMatch(first.reason,/不要退回/);
  write(join(task.worktree,"src/app.txt"),"good repaired\n"); deliver(task.dir,"第1条已修");
  await settle(task.dir,"第1条已修：根因已解决");
  assert.equal(statusOf(task.dir).state,"completed");
  assert.equal(statusOf(task.dir).loop.reviewReturns,1); assert.equal(statusOf(task.dir).loop.testReturns,0);
  const input = readFileSync(join(task.dir,"review-input-r2.md"),"utf8");
  assert.match(input,/上一轮必修[\s\S]*src\/app.txt:1/); assert.match(input,/开发方回复[\s\S]*根因已解决/);
  assert.match(input,/-good first/); assert.doesNotMatch(input,/-good\n/);
  assert.equal(readFileSync(join(task.dir,"order"),"utf8"),"test\nreview\ntest\nreview\n");
});
test("A4：复测与评审退回上限独立，转等你", async (t) => {
  const f = fixture(t,{reviewer:'printf %s '+sq(MUST),card:{limits:{测试:{maxRepairs:2,timeoutMin:1},开发评审:{maxRepairs:2,timeoutMin:1}}}}), task = await f.prepare();
  write(join(task.worktree,"src/app.txt"),"bad\n"); deliver(task.dir); await settle(task.dir);
  write(join(task.worktree,"src/app.txt"),"good one\n"); deliver(task.dir); await settle(task.dir);
  write(join(task.worktree,"src/app.txt"),"good two\n"); deliver(task.dir); const result = await settle(task.dir);
  const s = statusOf(task.dir);
  assert.equal(result.continue,false); assert.equal(s.state,"input_required");
  assert.equal(s.loop.testReturns,1); assert.equal(s.loop.reviewReturns,2);
  assert.equal(s.loop.wait,"评审必修到上限");
  assert.match(s.message,/评审必修退回 2 次/); assert.match(s.message,/再给一轮[\s\S]*停止[\s\S]*接受未验证/);
  assert.ok(s.message.includes("bin/loop 合入 "+task.executionId+" --接受未验证"));
});
test("A6：越界（含已提交/暂存/重命名）拒绝，不产生 commit", async (t) => {
  const f = fixture(t), task = await f.prepare(), before = head(task.worktree);
  write(join(task.worktree,"outside.txt"),"changed\n");
  gitText(task.worktree,["add","outside.txt"]);
  assert.throws(()=>deliver(task.dir),/scope 外文件：[\s\S]*outside.txt/); assert.equal(head(task.worktree),before);
  gitText(task.worktree,["commit","-m","developer commit"]);
  assert.throws(()=>deliver(task.dir),/outside.txt/);
  gitText(task.worktree,["reset","--hard",before]); gitText(task.worktree,["mv","outside.txt","src/moved.txt"]);
  assert.throws(()=>deliver(task.dir),/outside.txt/);
});
test("A7/A8：交付后又改只提醒；空停下保留开发方最后一段话", async (t) => {
  const f = fixture(t), task = await f.prepare();
  const empty = await settle(task.dir,"需要你确认测试目标");
  assert.equal(empty.continue,false); assert.equal(statusOf(task.dir).state,"input_required"); assert.equal(statusOf(task.dir).message,"需要你确认测试目标");
  assert.equal(statusOf(task.dir).loop.wait,"停下没交付");
  resume(task.dir);assert.equal(statusOf(task.dir).loop.wait,null);
  assert.equal(existsSync(join(task.dir,"order")),false);
});
test("A7：交付之后的未提交改动不跑检查、不扣退回次数",async(t)=>{
  const f=fixture(t),task=await f.prepare();
  write(join(task.worktree,"src/app.txt"),"good initial\n");deliver(task.dir);
  write(join(task.worktree,"src/app.txt"),"good after delivery\n");
  const r=await settle(task.dir);assert.equal(r.continue,true);assert.match(r.reason,/重新运行 bin\/loop 交付/);
  const s=statusOf(task.dir);assert.equal(s.loop.testReturns+s.loop.reviewReturns,0);assert.equal(existsSync(join(task.dir,"order")),false);
});
test("阶段：19 个常量；准备中、已交付、已放弃与自行提交拆分",async(t)=>{
  const f=fixture(t),initial=createTask(f.card,f.root);
  assert.equal(PHASES.length,19);assert.equal(new Set(PHASES).size,19);
  assert.equal(statusOf(initial.dir).loop.phase,"准备中");
  fail(initial.dir,new Error("setup"));resume(initial.dir);assert.equal(statusOf(initial.dir).loop.phase,"准备中");
  const task=await f.prepare();deliver(task.dir);assert.equal(statusOf(task.dir).loop.phase,"已交付");
  gitText(task.worktree,["commit","--allow-empty","-m","same tree new commit"]);
  assert.equal((await settle(task.dir)).continue,true);assert.equal(statusOf(task.dir).loop.phase,"开发中");
  stop(task.dir,true);assert.equal(statusOf(task.dir).loop.phase,"已放弃");assert.throws(()=>resume(task.dir),/已放弃/);
});
for(const host of ["claude","codex"])test("等你原因："+host+" 需手动接入会话",async(t)=>{
  const f=fixture(t,{card:{host}}),task=await f.prepare();
  await launchSession(task.dir,false,{env:{}});assert.equal(statusOf(task.dir).loop.wait,"需手动接入会话");
  stop(task.dir);assert.equal(statusOf(task.dir).loop.wait,null);assert.equal(statusOf(task.dir).loop.phase,"已停止");
});
test("scope：目录、**、deny 与非法路径", (t) => {
  fixture(t);
  const s = parseScope({allow:["src/**","test/*.ts","README.md"],deny:["src/private/**"]});
  assert.equal(inScope("src/a/b.ts",s),true); assert.equal(inScope("src/private/a.ts",s),false);
  assert.equal(inScope("test/a/b.ts",s),false); assert.equal(inScope("test/a.ts",s),true);
  assert.equal(inScope("README.md",s),true); assert.throws(()=>parseScope(["../other"]),/scope/);
});
