import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, write, deliver, settle } from "./helpers.ts";
import { scan } from "../src/steps/push.ts";
import { Ledger } from "../src/core/store.ts";
function origin(f:ReturnType<typeof fixture>) {
  const bare=join(f.base,"origin.git"), remote=(...args:string[])=>execFileSync("git",["--git-dir",bare,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  remote("init","--bare","--initial-branch=dev");f.git("remote","add","origin",bare);f.git("push","origin","dev");return remote;
}
test("推送 · 明确授权只更新 origin/dev，标签和其他分支不动，成功缓存",async t=>{
  const f=fixture(t),remote=origin(f),x=await f.prepare(), old=remote("rev-parse","refs/heads/dev");
  write(join(x.worktree,"src/app.txt"),"new\n");deliver(x.dir);await settle(x.dir);f.git("tag","-am","note","local-only");f.git("config","push.followTags","true");
  const m=await f.call(["合入",x.executionId]);assert.equal(remote("rev-parse","refs/heads/dev"),old);
  const p=await f.call(["推送",x.executionId]);assert.equal(remote("rev-parse","refs/heads/dev"),m.devAfter);assert.equal(remote("for-each-ref","refs/tags"),"");
  assert.deepEqual(await f.call(["推送",x.executionId]),p);assert.equal(new Ledger(x.dir).rows.filter(r=>r.type==="推送").length,1);
});
test("推送 · 中间提交里的密钥即使随后删除也阻止推送，不回显密钥",async t=>{
  const f=fixture(t),remote=origin(f),x=await f.prepare(), old=remote("rev-parse","refs/heads/dev"), git=(...args:string[])=>execFileSync("git",args,{cwd:x.worktree,stdio:"pipe",encoding:"utf8"}).trim();
  const secret="ghp_"+"X".repeat(42);write(join(x.worktree,"src/app.txt"),secret+"\n"); git("commit","-am","accident");
  const hits=scan(f.repo,[git("rev-parse","HEAD")]);assert.match(hits[0],/src\/app\.txt:1 GitHub 令牌/);assert(!hits[0].includes(secret));
  write(join(x.worktree,"src/app.txt"),"remove secret\n");deliver(x.dir);await settle(x.dir);
  await assert.rejects(f.call(["合入",x.executionId,"--推送"]),(e:any)=>/GitHub 令牌/.test(e.stderr)&&!e.stderr.includes(secret));assert.equal(remote("rev-parse","refs/heads/dev"),old);
});
