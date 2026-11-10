import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmodSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delivered, reviewed } from "./step-helpers.ts";
import { write, NODE, ROOT } from "./helpers.ts";
import { push, scan } from "../src/steps/push.ts";
import { merge } from "../src/steps/merge.ts";
import { deliver } from "../src/core/deliver.ts";
import { checksOf, statusOf } from "../src/core/store.ts";
import { gitText } from "../src/infra/git.ts";
function origin(f: Awaited<ReturnType<typeof delivered>>) {
  const remote=join(f.base,"origin.git");gitText(f.base,["init","--bare",remote]);f.git("remote","add","origin",remote);f.git("push","-u","origin","dev");return remote;
}
function shim(f: Awaited<ReturnType<typeof delivered>>, code: string) {
  const real=execFileSync("which",["git"],{encoding:"utf8"}).trim(),bin=join(f.base,"bin");
  write(join(bin,"git"),"#!"+NODE+"\nconst fs=require('fs'),cp=require('child_process'),args=process.argv.slice(2);\n"+code+"\nconst r=cp.spawnSync("+JSON.stringify(real)+",args,{stdio:'inherit'});process.exit(r.status??1);\n");
  chmodSync(join(bin,"git"),0o755);return bin+":"+process.env.PATH;
}
test("推送 A4/A5：默认不推，显式 --推送 仅更新裸仓库 dev，重复不再 push",async(t)=>{
  const f=await delivered(t),remote=origin(f),before=gitText(remote,["rev-parse","dev"]);reviewed(f.task,f.commit);
  await f.cli(["合入",f.task.executionId,"--json"]);assert.equal(gitText(remote,["rev-parse","dev"]),before);
  f.git("tag","local-only");
  f.git("tag","-a","annotated-only","-m","must stay local","dev");f.git("config","push.followTags","true");
  const r=JSON.parse((await f.cli(["合入",f.task.executionId,"--推送","--json"])).stdout);
  assert.equal(r.result,"已在 dev");assert.equal(r.push.result,"已推送");assert.equal(gitText(remote,["rev-parse","dev"]),f.git("rev-parse","dev"));
  assert.equal(gitText(remote,["for-each-ref","--format=%(refname)"]),"refs/heads/dev");assert.equal(statusOf(f.task.dir).loop.phase,"已推送");
  const path=shim(f,"if(args[0]==='push')process.exit(99);");
  const repeat=JSON.parse((await f.cli(["合入",f.task.executionId,"--推送","--json"],f.repo,{PATH:path})).stdout);
  assert.equal(repeat.push.result,"已推送");assert.match(repeat.push.detail,/远端已是最新/);
  assert.equal(checksOf(f.task.dir).filter(c=>c.step==="推送").length,2);
  assert.equal(existsSync(join(f.task.dir,"order")),false);assert.equal(existsSync(join(f.task.dir,"opened.json")),false);
});
test("评审必修4：远端删除 dev 后重推，不能把陈旧 origin/dev 当作已推送",async t=>{
  const f=await delivered(t),remote=origin(f);reviewed(f.task,f.commit);merge(f.task.dir,{acceptUnverified:false});
  assert.equal((await push(f.task.dir)).result,"已推送");const commit=f.git("rev-parse","dev");
  gitText(remote,["update-ref","refs/heads/keep",f.task.baseCommit]);gitText(remote,["update-ref","-d","refs/heads/dev"]);
  f.git("config","fetch.prune","false");f.git("config","remote.origin.prune","false");f.git("fetch","--no-tags","origin");
  assert.equal(f.git("rev-parse","refs/remotes/origin/dev"),commit);assert.equal(gitText(remote,["for-each-ref","--format=%(refname)"]),"refs/heads/keep");
  const counter=join(f.base,"restore-push"),path=shim(f,"if(args[0]==='push')fs.appendFileSync("+JSON.stringify(counter)+",'push\\n');");
  const r=JSON.parse((await f.cli(["合入",f.task.executionId,"--推送","--json"],f.repo,{PATH:path})).stdout);
  assert.equal(r.push.result,"已推送");assert.equal(readFileSync(counter,"utf8"),"push\n");
  assert.equal(gitText(remote,["rev-parse","refs/heads/dev"]),commit);assert.equal(gitText(remote,["rev-parse","refs/heads/keep"]),f.task.baseCommit);
});
test("推送 A6：中间提交密钥已删除仍拦截，中文文件:行/规则，无密钥内容",async(t)=>{
  const f=await delivered(t),remote=origin(f),before=gitText(remote,["rev-parse","dev"]),secret="AKIA"+"X".repeat(16);
  write(join(f.task.worktree,"src/中文 文件.txt"),"one\ntwo\n"+secret+"\n");const middle=deliver(f.task.dir).commit;
  write(join(f.task.worktree,"src/中文 文件.txt"),"one\ntwo\nremoved\n");const last=deliver(f.task.dir).commit;reviewed(f.task,last);
  await assert.rejects(f.cli(["合入",f.task.executionId,"--推送","--json"]),(e:any)=>{
    assert.equal(e.code,1);const err=JSON.parse(e.stderr).error;assert.equal(err.result.result,"扫描命中，未推送");assert.equal(err.category,"输入问题");
    assert.ok(err.raw.includes(middle.slice(0,7)+" src/中文 文件.txt:3 AWS 访问密钥"));assert.ok(!(e.stdout+e.stderr).includes(secret));return true;
  });
  assert.equal(gitText(remote,["rev-parse","dev"]),before);assert.equal(statusOf(f.task.dir).loop.phase,"推送失败");assert.match(statusOf(f.task.dir).message,/扫描命中/);
  assert.ok(!readFileSync(join(f.task.dir,"checks.jsonl"),"utf8").includes(secret));
});
test("扫描规则：全部平台格式、私钥、新增 .env；示例与普通 password 不拦截，规则源码不自命中",async(t)=>{
  const f=await delivered(t);
  const secrets=["-----"+"BEGIN RSA PRIVATE KEY"+"-----","AKIA"+"X".repeat(16),"ASIA"+"X".repeat(16),
    "gh"+"p_"+"a".repeat(36),"github_"+"pat_"+"a".repeat(50),"sk-"+"a".repeat(20),"sk-"+"ant-"+"a".repeat(20),"sk-"+"proj-"+"a".repeat(20),
    "xox"+"b-"+"a".repeat(10),"AI"+"za"+"a".repeat(35)];
  for(let i=0;i<secrets.length;i++)write(join(f.task.worktree,"src/rule-"+i),"safe\n"+secrets[i]+"\n");
  for(const name of [".env",".env.local",".env.example",".env.sample",".env.template"])write(join(f.task.worktree,"src",name),"safe\n");
  write(join(f.task.worktree,"src/push.ts"),readFileSync(join(ROOT,"src/steps/push.ts"),"utf8"));
  write(join(f.task.worktree,"src/push.test.ts"),readFileSync(join(ROOT,"test/push.test.ts"),"utf8"));
  write(join(f.task.worktree,"src/ordinary"),'password="ordinary"\n');
  const commit=deliver(f.task.dir).commit,hits=scan(f.repo,[commit]);
  assert.equal(hits.length,secrets.length+2);assert.ok(hits.every(h=>!secrets.some(s=>h.includes(s))));
  for(let i=0;i<secrets.length;i++)assert.ok(hits.some(h=>h.includes("src/rule-"+i+":2 ")));
  assert.ok(hits.some(h=>h.endsWith("src/.env:1 .env 文件")));assert.ok(hits.some(h=>h.endsWith("src/.env.local:1 .env 文件")));
  for(const name of [".env.example",".env.sample",".env.template","src/push.ts","src/push.test.ts","ordinary"])assert.ok(hits.every(h=>!h.includes(name)));
});
test("扫描：修改文件多 hunk 行号、删除行不扫描、二进制跳过",async(t)=>{
  const f=await delivered(t),key="sk-"+"X".repeat(24);
  write(join(f.task.worktree,"src/lines"),Array.from({length:20},(_,i)=>"line "+i).join("\n")+"\n");const before=deliver(f.task.dir).commit;
  const lines=readFileSync(join(f.task.worktree,"src/lines"),"utf8").split("\n");lines[2]=key;lines[16]=key;
  write(join(f.task.worktree,"src/lines"),lines.join("\n"));write(join(f.task.worktree,"src/binary"),"\0"+key);
  const commit=deliver(f.task.dir).commit;assert.deepEqual(scan(f.repo,[commit]).map(h=>h.split(" ").slice(1).join(" ")),["src/lines:3 sk- 类 API 密钥","src/lines:17 sk- 类 API 密钥"]);
  assert.deepEqual(scan(f.repo,[before]),[]);
  lines[2]="removed";lines[16]="removed";write(join(f.task.worktree,"src/lines"),lines.join("\n"));assert.deepEqual(scan(f.repo,[deliver(f.task.dir).commit]),[]);
});
test("推送：没有 origin 不记记录；扫描出错隐藏原始补丁、不推送",async(t)=>{
  const f=await delivered(t);reviewed(f.task,f.commit);merge(f.task.dir,{acceptUnverified:false});const count=checksOf(f.task.dir).length;
  await assert.rejects(push(f.task.dir),/没有 origin/);assert.equal(checksOf(f.task.dir).length,count);
  const remote=origin(f),before=gitText(remote,["rev-parse","dev"]);
  // origin() 已推送当前 dev；推进一个新提交以保证进入扫描。
  write(join(f.task.worktree,"src/app.txt"),"good next\n");const c=deliver(f.task.dir).commit;reviewed(f.task,c);merge(f.task.dir,{acceptUnverified:false});
  const path=shim(f,"if(args.includes('diff-tree')){console.error('sensitive patch must not leak');process.exit(7);}");
  await assert.rejects(f.cli(["合入",f.task.executionId,"--推送","--json"],f.repo,{PATH:path}),(e:any)=>{const err=JSON.parse(e.stderr).error;assert.equal(err.result.result,"扫描出错，未推送");assert.equal(err.category,"工具内部错误");assert.doesNotMatch(e.stderr,/sensitive patch/);return true;});
  assert.equal(gitText(remote,["rev-parse","dev"]),before);
});
test("推送：远端有额外提交，非快进失败、不强推、不重试",async(t)=>{
  const f=await delivered(t),remote=origin(f);reviewed(f.task,f.commit);merge(f.task.dir,{acceptUnverified:false});
  const other=join(f.base,"other");gitText(f.base,["clone","--branch","dev",remote,other]);gitText(other,["config","user.name","test"]);gitText(other,["config","user.email","test@example.invalid"]);
  write(join(other,"remote-only"),"remote\n");gitText(other,["add","."]);gitText(other,["commit","-m","remote diverged"]);gitText(other,["push","origin","dev"]);const before=gitText(remote,["rev-parse","dev"]);
  await assert.rejects(push(f.task.dir),(e:any)=>{assert.equal(e.category,"权限不足");assert.equal(e.result.result,"推送失败");assert.match(e.message,/rejected/);return true;});
  assert.equal(gitText(remote,["rev-parse","dev"]),before);assert.equal(statusOf(f.task.dir).message,"远端拒绝");
});
for(const outcome of ["accepted","unknown","timeout"])test("推送：报错后仅核对一次、不重推："+outcome,async(t)=>{
  const f=await delivered(t),remote=origin(f);reviewed(f.task,f.commit);merge(f.task.dir,{acceptUnverified:false});
  const counter=join(f.base,"network-calls"),real=execFileSync("which",["git"],{encoding:"utf8"}).trim();
  const code="if(['fetch','push','ls-remote'].includes(args[0]))fs.appendFileSync("+JSON.stringify(counter)+",args[0]+'\\n');"+
    (outcome==="accepted"?"if(args[0]==='push'){cp.spawnSync("+JSON.stringify(real)+",args,{stdio:'inherit'});process.exit(1);}":
      outcome==="unknown"?"if(['push','ls-remote'].includes(args[0])){console.error('simulated failure');process.exit(1);}":
      "if(args[0]==='fetch'){setInterval(()=>{},60000);return;}");
  const path=shim(f,code),old=process.env.PATH;process.env.PATH=path;
  try {
    if(outcome==="accepted")assert.equal((await push(f.task.dir)).result,"已推送");
    else await assert.rejects(push(f.task.dir,{timeoutMs:200}),(e:any)=>{assert.equal(e.result.result,outcome==="unknown"?"推送结果不确定":"推送失败");assert.equal(e.category,outcome==="unknown"?"未知":"临时故障");if(outcome==="unknown")assert.match(e.result.verify,/ls-remote origin refs\/heads\/dev/);return true;});
  } finally {process.env.PATH=old;}
  assert.equal(readFileSync(counter,"utf8"),outcome==="timeout"?"fetch\n":"fetch\npush\nls-remote\n");
  if(outcome==="accepted")assert.equal(gitText(remote,["rev-parse","dev"]),f.git("rev-parse","dev"));
});
test("命令选项：--推送 只用于合入",async(t)=>{
  const f=await delivered(t);await assert.rejects(f.cli(["查询","--推送"]),(e:any)=>{assert.match(e.stderr,/未知选项/);return true;});
});
