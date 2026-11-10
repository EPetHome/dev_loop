import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fixture, write } from "./helpers.ts";
import { delivered, reviewed } from "./step-helpers.ts";
import { merge } from "../src/steps/merge.ts";
import { gitText, gitTry, worktreeOf, isAncestor } from "../src/infra/git.ts";
import { statusOf, checksOf, transition, waitFor, missingChecks, recordStep, annotate, type State } from "../src/core/store.ts";

test("合入 A1：第二父提交、输出/撤销字段、零评审/pi 调用、原任务分支保留",async(t)=>{
  const f=await delivered(t);reviewed(f.task,f.commit);const before=f.git("rev-parse","dev");
  write(join(f.repo,"unrelated.txt"),"preserved\n");
  const r=JSON.parse((await f.cli(["合入",f.task.executionId,"--commit",f.commit.slice(0,9),"--json"])).stdout);
  assert.equal(r.result,"已合入");assert.equal(r.unverified,false);assert.equal(r.commit,f.commit);
  assert.equal(r.devBefore,before);assert.equal(r.devAfter,f.git("rev-parse","dev"));assert.equal(r.executionId,f.task.executionId);
  assert.equal(f.git("rev-parse","dev^2"),f.commit);assert.ok(r.seconds>=0);assert.equal(r.worktree,worktreeOf(f.repo,"dev"));
  assert.equal(r.revert,"git -C '"+r.worktree+"' revert -m 1 "+r.devAfter);
  assert.equal(f.git("log","-1","--format=%s"),"Merge one: reviewed "+f.commit.slice(0,7));
  assert.equal(readFileSync(join(f.repo,"unrelated.txt"),"utf8"),"preserved\n");
  assert.equal(existsSync(join(f.task.dir,"order")),false);assert.equal(existsSync(join(f.task.dir,"opened.json")),false);
  assert.equal(gitText(f.task.worktree,["branch","--show-current"]),f.task.branch);assert.equal(gitText(f.task.worktree,["rev-parse","HEAD"]),f.commit);
  assert.equal(statusOf(f.task.dir).loop.phase,"已合入");
  const records=checksOf(f.task.dir).filter(c=>c.step==="合入");assert.equal(records.length,1);assert.equal(records[0].commit,f.commit);
  assert.match(readFileSync(join(f.task.dir,"summary.md"),"utf8"),/\| 合入 \| 已合入 \|/);
});
test("合入 A2：缺复测/评审拒绝，哈希变化列原因，无记录/阶段变化",async(t)=>{
  const f=await delivered(t),before=f.git("rev-parse","dev"),count=checksOf(f.task.dir).length,seq=statusOf(f.task.dir).seq;
  await assert.rejects(f.cli(["合入",f.task.executionId,"--json"]),(e:any)=>{
    assert.equal(e.code,1);const raw=JSON.parse(e.stderr).error;assert.equal(raw.category,"输入问题");
    assert.match(raw.raw,/复测：没有通过记录/);assert.match(raw.raw,/评审：没有通过记录/);return true;
  });
  assert.equal(f.git("rev-parse","dev"),before);assert.equal(checksOf(f.task.dir).length,count);assert.equal(statusOf(f.task.dir).seq,seq);
  reviewed(f.task,f.commit,"没验证");assert.deepEqual(missingChecks(f.task.dir,f.commit),[]);
  write(join(f.repo,"prompt.md"),"changed");
  assert.throws(()=>merge(f.task.dir,{acceptUnverified:false}),/提示词或验收标准已变化/);
});
test("合入 A3：冲突原文/退出1，abort 恢复 dev 的 HEAD、索引和文件",async(t)=>{
  const f=await delivered(t);reviewed(f.task,f.commit);write(join(f.repo,"src/app.txt"),"dev conflict\n");f.git("add","src/app.txt");f.git("commit","-m","conflict");
  write(join(f.repo,"outside.txt"),"local unrelated\n");const before=f.git("rev-parse","dev"),dirty=f.git("status","--porcelain=v1"),index=f.git("write-tree");
  await assert.rejects(f.cli(["合入",f.task.executionId,"--json"]),(e:any)=>{
    assert.equal(e.code,1);const err=JSON.parse(e.stderr).error;assert.match(err.raw,/CONFLICT/);assert.equal(err.category,"输入问题");assert.equal(err.result.result,"合入失败");return true;
  });
  assert.equal(f.git("rev-parse","dev"),before);assert.equal(f.git("status","--porcelain=v1"),dirty);assert.equal(f.git("write-tree"),index);
  assert.equal(gitTry(f.repo,["rev-parse","-q","--verify","MERGE_HEAD"]).code,1);
  assert.equal(readFileSync(join(f.repo,"src/app.txt"),"utf8"),"dev conflict\n");assert.equal(readFileSync(join(f.repo,"outside.txt"),"utf8"),"local unrelated\n");
  assert.equal(statusOf(f.task.dir).loop.phase,"合入失败");assert.match(statusOf(f.task.dir).message,/src\/app.txt/);
  assert.match(checksOf(f.task.dir).at(-1)!.detail!,/CONFLICT/);
});
for (const resolved of [false, true]) test("评审必修2：保留已有合并及用户手工解决内容，全部冲突已解决=" + resolved, async t => {
  const f = await delivered(t); reviewed(f.task, f.commit);
  f.git("checkout", "-b", "existing-merge", f.task.baseCommit);
  write(join(f.repo, "src/app.txt"), "other app\n"); write(join(f.repo, "outside.txt"), "other outside\n");
  f.git("add", "src/app.txt", "outside.txt"); f.git("commit", "-m", "other changes"); f.git("checkout", "dev");
  write(join(f.repo, "src/app.txt"), "dev app\n"); write(join(f.repo, "outside.txt"), "dev outside\n");
  f.git("add", "src/app.txt", "outside.txt"); f.git("commit", "-m", "dev changes");
  assert.equal(gitTry(f.repo, ["merge", "--no-ff", "existing-merge"]).code, 1);
  write(join(f.repo, "src/app.txt"), "user resolved app\n"); f.git("add", "src/app.txt");
  if (resolved) { write(join(f.repo, "outside.txt"), "user resolved outside\n"); f.git("add", "outside.txt"); }
  const snapshot = () => ({head: f.git("rev-parse", "dev"), mergeHead: f.git("rev-parse", "MERGE_HEAD"),
    message: readFileSync(join(f.repo, ".git/MERGE_MSG"), "utf8"), index: f.git("ls-files", "--stage"), status: f.git("status", "--porcelain=v1"),
    app: readFileSync(join(f.repo, "src/app.txt"), "utf8"), outside: readFileSync(join(f.repo, "outside.txt"), "utf8")});
  const before = snapshot();
  await assert.rejects(f.cli(["合入", f.task.executionId, "--json"]), (e: any) => {
    assert.equal(e.code, 1); const err = JSON.parse(e.stderr).error;
    assert.equal(err.result.result, "合入失败"); assert.match(err.raw, /unmerged|MERGE_HEAD|not concluded/); return true;
  });
  assert.deepEqual(snapshot(), before);
});
test("合入：本地文件将被覆盖时 git 拒绝，不运行 abort、不丢改动",async(t)=>{
  const f=await delivered(t);reviewed(f.task,f.commit);write(join(f.repo,"src/app.txt"),"local unsaved\n");const before=f.git("rev-parse","dev"),dirty=f.git("status","--porcelain");
  assert.throws(()=>merge(f.task.dir,{acceptUnverified:false}),/would be overwritten/);
  assert.equal(f.git("rev-parse","dev"),before);assert.equal(f.git("status","--porcelain"),dirty);assert.equal(readFileSync(join(f.repo,"src/app.txt"),"utf8"),"local unsaved\n");
});
test("合入：接受未验证放行、等你→completed、unverified 信息，重复合入幂等",async(t)=>{
  const f=await delivered(t);waitFor(f.task.dir,"复测退回到上限","限额");
  const r=merge(f.task.dir,{acceptUnverified:true});assert.equal(r.result,"已合入（未验证）");assert.equal(r.unverified,true);
  const s=statusOf(f.task.dir);assert.equal(s.state,"completed");assert.equal(s.loop.phase,"已合入");assert.equal(s.loop.bucket,null);assert.equal(s.loop.wait,null);
  assert.equal(f.git("log","-1","--format=%s"),"Merge one: unverified "+f.commit.slice(0,7));
  const second=merge(f.task.dir,{acceptUnverified:true});assert.equal(second.result,"已在 dev");assert.equal(second.devAfter,r.devAfter);assert.equal(second.devBefore,r.devAfter);
  const total=checksOf(f.task.dir).filter(c=>c.step==="合入").reduce((n,c)=>n+c.durationMs,0)/1000;
  assert.ok(readFileSync(join(f.task.dir,"summary.md"),"utf8").includes("| 合入 | 已在 dev | "+total.toFixed(2)+"s |"));
});
test("合入：没有交付、版本不同、dev 未检出均拒绝且无记录",async(t)=>{
  const plain=fixture(t),task=await plain.prepare();assert.throws(()=>merge(task.dir,{acceptUnverified:true}),/没有交付记录/);
  const f=await delivered(t);reviewed(f.task,f.commit);const count=checksOf(f.task.dir).length,seq=statusOf(f.task.dir).seq;
  for(const commit of [f.task.baseCommit,"not-a-commit"])assert.throws(()=>merge(f.task.dir,{commit,acceptUnverified:false}),/目标已变化/);
  f.git("checkout","--detach");assert.equal(worktreeOf(f.repo,"dev"),undefined);
  assert.throws(()=>merge(f.task.dir,{acceptUnverified:false}),/dev 没有检出到任何目录/);
  assert.equal(checksOf(f.task.dir).length,count);assert.equal(statusOf(f.task.dir).seq,seq);
});
test("合入：dev 在第二个带中文空格 worktree，已在 dev 时无需检出",async(t)=>{
  const f=await delivered(t);reviewed(f.task,f.commit);f.git("checkout","--detach");const holder=join(f.base,"dev 检出");f.git("worktree","add",holder,"dev");
  const r=merge(f.task.dir,{acceptUnverified:false});assert.equal(r.worktree,worktreeOf(f.repo,"dev"));assert.equal(gitText(holder,["rev-parse","HEAD^2"]),f.commit);
  f.git("worktree","remove",holder);assert.equal(merge(f.task.dir,{acceptUnverified:false}).result,"已在 dev");
  assert.equal(isAncestor(f.repo,f.commit,"dev"),true);assert.equal(isAncestor(f.repo,"dev",f.commit),false);assert.throws(()=>isAncestor(f.repo,"missing","dev"));
});
test("通用记录：状态规则、缺输入也记录、summary 最新结果与累计耗时",async(t)=>{
  const f=await delivered(t),dir=f.task.dir,at=new Date().toISOString();
  const entry={step:"附加",commit:f.commit,result:"first",startedAt:at,endedAt:at,durationMs:1500,evidence:[]};
  for(const state of ["working","input_required","failed","cancelled","completed"] as State[]){
    // 测试矩阵独立设置，避开 transition 对取消状态的保护。
    const {update}=await import("../src/core/store.ts");update(dir,s=>{s.state=state;s.loop.phase="开发中";s.message="keep";});
    annotate(dir,"推送中","new");assert.equal(statusOf(dir).message,state==="completed"?"new":"keep");
    recordStep(dir,entry,{phase:"已合入",message:"done",complete:true});
    assert.equal(statusOf(dir).state,state==="input_required"?"completed":state);
    assert.equal(statusOf(dir).loop.phase,["completed","input_required"].includes(state)?"已合入":"开发中");
  }
  rmSync(join(f.repo,"prompt.md"));recordStep(dir,{...entry,result:"last",durationMs:2250});
  assert.equal(checksOf(dir).at(-1)!.promptHash,"");assert.match(readFileSync(join(dir,"summary.md"),"utf8"),/\| 附加 \| last \| 9.75s \|[\s\S]*\| dev-loop 自身/);
});
test("命令选项：--commit/--接受未验证 不能用于其他命令",async(t)=>{
  const f=fixture(t);
  for(const args of [["查询","--commit","abc"],["交付","--接受未验证"]])await assert.rejects(f.cli(args),(e:any)=>{assert.match(e.stderr,/未知选项/);return true;});
});
