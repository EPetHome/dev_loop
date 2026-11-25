import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, writeFixtureScript, deliver, settle, until, sq } from "./helpers.ts";
import { Ledger } from "../src/core/store.ts";
import { state } from "../src/core/state.ts";
import { alive } from "../src/infra/exec.ts";
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

for (const stopped of [false,true]) test(`R2-4 · 部分发布后杀 worker${stopped ? "并停止" : ""}，接管先用原证据回退`,async t=>{
  const f=project(t,"exit 0","exit 0",["开发评审","测试","合入","部署"]), log=sq(join(f.base,"sequence")), ready=sq(join(f.base,"deploy-started"));
  writeFixtureScript(join(f.repo,"deploy.sh"),"sh",`echo cmd >> ${log}\nif [ ! -e ${ready} ]; then echo original > "$LOOP_EVIDENCE_DIR/origin"; touch ${ready}; while :; do sleep .03; done; fi\n`);
  writeFixtureScript(join(f.repo,"rollback.sh"),"sh",`grep -qx original "$LOOP_EVIDENCE_DIR/origin" || exit 2\necho "$LOOP_DEPLOY_FAILED" >> ${log}\n`);
  f.git("add",".");f.git("commit","-m","interruptible deploy");const x=await f.prepare();write(join(x.worktree,"src/app.txt"),"version\n");deliver(x.dir);await settle(x.dir);
  const l=await f.pump(x.dir,l=>existsSync(join(f.base,"deploy-started"))), owner=state(l).running!.owner!;
  assert.equal(state(l).running!.step,"部署");process.kill(owner.pid,"SIGKILL");await until(x.dir,()=>alive(owner),v=>!v);
  if (stopped) await f.call(["停止",x.executionId]);
  const finished=await f.pump(x.dir,l=>stopped ? !!l.last("部署已回退") : state(l).done,42);
  assert.equal(readFileSync(join(f.base,"sequence"),"utf8"),stopped ? "cmd\ninterrupted\n" : "cmd\ninterrupted\ncmd\n");
  assert(finished.rows.some(r=>r.type==="部署" && r.kind==="重试" && !r.check));
  assert.equal(finished.rows.filter(r=>r.type==="部署已回退").length,1);
  if (stopped) assert.equal(state(finished).stop?.result,"已停止");
});

for (const mode of ["cmd成功","cmd后回退","回退中"]) test(`R2-5 · ${mode}时请求停止，登记真实线上结果，不走后续步骤`,async t=>{
  const failed=mode!=="cmd成功", rollback=mode==="回退中", f=project(t,failed?"exit 1":"exit 0","exit 0",["开发评审","测试","合入","部署"]), gate=join(f.base,"allow-finish"),ready=join(f.base,"deploy-started");
  writeFixtureScript(join(f.repo,(rollback?"rollback":"deploy")+".sh"),"sh",`touch ${sq(ready)}\nwhile [ ! -e ${sq(gate)} ]; do sleep .03; done\necho "$LOOP_DEPLOY_FAILED" > "$LOOP_EVIDENCE_DIR/${rollback?"rollback-cause":"cmd-done"}"\n`);
  f.git("add",".");f.git("commit","-m","stoppable deploy");const x=await f.prepare();write(join(x.worktree,"src/app.txt"),"version\n");deliver(x.dir);await settle(x.dir);
  const l=await f.pump(x.dir,l=>existsSync(ready)), owner=state(l).running!.owner!;
  assert.equal((await f.call(["停止",x.executionId])).state,"cancelled");assert(alive(owner));
  write(gate,"");const finished=await f.pump(x.dir,l=>!!l.last("部署")?.check,32), actual=finished.last("部署")!.check!;
  assert.equal(actual.result,failed ? "部署失败，已回退" : "已部署");
  if(failed) assert.equal(readFileSync(join(actual.evidence[1],"rollback-cause"),"utf8"),"check\n");
  await f.call(["tick","--all"]);assert(existsSync(x.worktree));assert.equal(state(finished).stop?.result,"已停止");assert(!new Ledger(x.dir).last("释放"));
});

test("部署 · 脚本不是检出中的可执行普通文件则不运行",async t=>{
  const f=project(t), path=join(f.repo,"deploy.sh");const {unlinkSync}=await import("node:fs");unlinkSync(path);symlinkSync("/usr/bin/true",path);f.git("add","deploy.sh");f.git("commit","-m","test link");
  const x=await f.prepare();write(join(x.worktree,"src/app.txt"),"deployed version\n");deliver(x.dir);await settle(x.dir);
  await assert.rejects(f.call(["部署",x.executionId]),/不是|不可执行/);assert(!new Ledger(x.dir).last("部署")?.check);
});
