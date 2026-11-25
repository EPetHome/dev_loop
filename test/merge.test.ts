import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, deliver, settle } from "./helpers.ts";
import { gitText } from "../src/infra/git.ts";
import { Ledger } from "../src/core/store.ts";

test("收货范围：已提交、暂存、删除与覆盖的索引内容都检查；原样 localFiles 不误拦",async t=>{
  const f=fixture(t,{config:{localFiles:["local.txt","not-ignored.txt"]}});write(join(f.repo,"not-ignored.txt"),"copied unchanged");
  const x=await f.prepare(), git=(...args:string[])=>gitText(x.worktree,args);const outside=join(x.worktree,"outside.txt");
  write(outside,"bad staged\n");git("add","outside.txt");write(outside,"protected\n");const head=git("rev-parse","HEAD");
  assert.throws(()=>deliver(x.dir),/outside\.txt/);assert.equal(git("rev-parse","HEAD"),head);assert.equal(git("show",":outside.txt"),"bad staged");
  git("restore","--staged","outside.txt"); write(join(x.worktree,"src/app.txt"),"approved\n");
  const {commit}=deliver(x.dir);assert.equal(git("diff","--name-only",head,commit),"src/app.txt");
  git("mv","outside.txt","src/moved.txt");git("commit","-m","own git commit");assert.throws(()=>deliver(x.dir),/outside\.txt/);
  assert.equal(new Ledger(x.dir).delivery?.commit,commit);
});

test("合入 · 同版通过；保留无关工作区改动，不再造 merge；状态副本可重建",async t=>{
  const f=fixture(t), x=await f.prepare();write(join(x.worktree,"src/app.txt"),"new\n");const {commit}=deliver(x.dir);await settle(x.dir);
  write(join(f.repo,"outside.txt"),"user version\n");rmSync(join(x.dir,"status.json"));rmSync(join(x.dir,"checks.jsonl"));
  const m=await f.call(["合入",x.executionId,"--commit",commit.slice(0,9)]);
  assert.equal(m.result,"已合入");assert.equal(f.git("rev-parse","dev^2"),commit);assert.match(m.revert,/revert -m 1/);
  assert.equal(readFileSync(join(f.repo,"outside.txt"),"utf8"),"user version\n");assert.deepEqual(await f.call(["合入",x.executionId]),m);
  assert.equal(f.git("rev-list","--count","--merges","dev"),"1");
  write(join(x.worktree,"src/dirty.txt"),"keep");const released=await f.call(["释放",x.executionId]);assert.equal(released.released,false);assert(existsSync(join(x.worktree,"src/dirty.txt")));
});

test("旧状态只读且 tick 不推进；放弃删除新版工作区但保留 Git 分支与证据",async t=>{
  const f=fixture(t), old=join(f.root,"old"), out=write(join(old,"status.json"),'{"state":"failed","loop":{"phase":"失败","commit":"abc"}}');
  write(join(old,"task.json"),JSON.stringify({executionId:"old",createdAt:"2026-01-01",repo:f.repo}));
  assert.equal((await f.call(["查询","old"])).executions[0].loop.commit,"abc");await f.call(["tick","--all"]);assert(!existsSync(join(old,"ledger.jsonl")));
  assert.equal(readFileSync(out,"utf8"),'{"state":"failed","loop":{"phase":"失败","commit":"abc"}}');
  const x=await f.prepare();assert.equal((await f.call(["放弃",x.executionId])).loop.phase,"已放弃");assert(!existsSync(x.worktree));assert(f.git("show-ref","--verify","refs/heads/"+x.branch));
});
