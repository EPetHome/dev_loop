import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, writeFixtureScript, deliver, settle } from "./helpers.ts";
import { Ledger } from "../src/core/store.ts";
import { state } from "../src/core/state.ts";
function project(t:any,check="exit 0",rollback="exit 0",flow=["开发评审","测试"]) {
  const f=fixture(t,{card:{flow},config:{snapshot:"snapshot.sh",deploy:{cmd:"deploy.sh",check:"check.sh",rollback:"rollback.sh",env:{APP_DIR:"isolated"}}}});
  writeFixtureScript(join(f.repo,"deploy.sh"),"sh",'echo "$LOOP_DEPLOY_COMMIT;$APP_DIR" > "$LOOP_EVIDENCE_DIR/observed"\n');
  writeFixtureScript(join(f.repo,"check.sh"),"sh",check+"\n");
  writeFixtureScript(join(f.repo,"rollback.sh"),"sh",'echo "$LOOP_DEPLOY_FAILED" >> "$LOOP_EVIDENCE_DIR/rollback-cause"\n'+rollback+"\n");
  writeFixtureScript(join(f.repo,"snapshot.sh"),"sh",'echo \'{"good":true}\' > "$LOOP_SNAPSHOT_OUT"\n');
  f.git("add",".");f.git("commit","-m","deployment doubles"); return f;
}
test("部署 · 绑最后收货 SHA、隔离检出、前后快照、重复不部署、可退回",async t=>{
  const f=project(t), x=await f.prepare();write(join(x.worktree,"src/app.txt"),"deployed version\n");const {commit}=deliver(x.dir);await settle(x.dir);
  const r=await f.call(["部署",x.executionId]);assert.equal(r.commit,commit);assert.deepEqual(r.steps.map(x=>x.name),["cmd","check"]);
  assert.equal(readFileSync(join(r.evidenceDir,"observed"),"utf8").trim(),commit+";isolated");
  assert.equal(readFileSync(join(r.evidenceDir,"snapshot-after.json"),"utf8").trim(),'{"good":true}');assert(!f.git("worktree","list").includes("dev-loop-check-"));
  assert.deepEqual(await f.call(["部署",x.executionId]),r);assert.equal((await f.call(["退回",x.executionId])).result,"已退回");assert.equal(f.git("rev-parse","dev"),x.baseCommit);
});
for (const good of [true,false]) test(`部署 · 探活失败，回退${good?"成功退开发":"失败只等本人"}`,async t=>{
  const f=project(t,"exit 1",good?"exit 0":"exit 1",["开发评审","测试","合入","部署"]),x=await f.prepare();write(join(x.worktree,"src/app.txt"),"deployed version\n");deliver(x.dir);await settle(x.dir);
  const l=await f.pump(x.dir,l=>!!l.last("发回") || !!state(l).wait);
  assert.equal(l.last("部署")!.check!.result,good?"部署失败，已回退":"部署失败，回退也失败");
  assert.equal(state(l).returned("部署").length,good?1:0);assert.equal(state(l).wait?.wait,good?undefined:"环境修不好");
});

test("部署 · 脚本不是检出中的可执行普通文件则不运行",async t=>{
  const f=project(t), path=join(f.repo,"deploy.sh");const {unlinkSync}=await import("node:fs");unlinkSync(path);symlinkSync("/usr/bin/true",path);f.git("add","deploy.sh");f.git("commit","-m","test link");
  const x=await f.prepare();write(join(x.worktree,"src/app.txt"),"deployed version\n");deliver(x.dir);await settle(x.dir);
  await assert.rejects(f.call(["部署",x.executionId]),/不是|不可执行/);assert(!new Ledger(x.dir).last("部署")?.check);
});
