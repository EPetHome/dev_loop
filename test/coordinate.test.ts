import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { coordinate } from "../tools/coordinate.ts";
import { day, days, hash, json } from "../tools/coordination/files.ts";
import { applyPlan, locked, planId, type Change, type Plan } from "../tools/coordination/write-plan.ts";

const now = Date.parse("2026-11-26T12:00:00Z"), at = (t: number) => new Date(t).toISOString();
const before = "1".repeat(40), commit = "2".repeat(40), merged = "3".repeat(40);
const prompt = "## 验收标准\nA1. 操作：重新投递。预期：任务启动。\n";
const write = (path:string,text:string) => { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,text); return path; };
const read = (path:string) => readFileSync(path,"utf8");
const doc = (path:string,o:unknown) => write(path,json(o));
const jsonl = (path:string,o:unknown[]) => write(path,o.map(v=>JSON.stringify(v)).join("\n")+"\n");
function fixture(t:TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(),"coordinate-test-"))), repo = join(dir,"PA 项目"), other = join(dir,"别的项目"), tasks = join(dir,"tasks");
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for (const p of [repo,other,tasks]) mkdirSync(p);
  const args = (cmd:string,more:string[]=[])=>[cmd,"--project",repo,"--tasks-root",tasks,...more];
  const run = (cmd:string,more:string[]=[],clock=now) => {
    const report = coordinate(args(cmd,more),clock);
    assert(typeof report !== "string"); return report;
  };
  const apply = (cmd:string, p:ReturnType<typeof run>, options:string[]=[], clock=now) => run(cmd,[...options,"--apply",p.planId],clock);
  const batch = (name:string, root=repo, settings:Record<string,unknown>={})=>{
    const d = join(root,"docs/batches",name), card = join(d,"开发卡.json"), req = write(join(d,"提示词.md"),prompt);
    doc(card,{version:1,name,nature:"开发",base:"dev",target:"dev",flow:["开发评审","测试"],tasks:[{name,prompt:"提示词.md",test:"node --test",...settings}]});
    return {name, d, card, req, acceptance:join(d,"验收.md"), results:join(d,"结果.md")};
  };
  const execution = (b:ReturnType<typeof batch>,id:string,started:number,options:{root?:string; loop?:Record<string,unknown>; state?:string; task?:Record<string,unknown>}={})=>{
    const dir = join(tasks,id), status = join(dir,"status.json"), index = join(dir,"checks.jsonl");
    doc(join(dir,"task.json"),{executionId:id,repo:options.root || repo,card:b.card,prompt:b.req,name:b.name,createdAt:at(started),baseCommit:before,...options.task});
    doc(status,{protocol:"loop-status/1",executionId:id,state:options.state || "completed",updatedAt:at(started+8000),seq:3,refs:{card:b.card},
      loop:{phase:"完成",commit,delivery:{commit,note:"",at:at(started+1000)}, durations:{developmentMs:1000,testMs:200,reviewMs:500,inputMs:0,selfMs:300},
        facts:{name:b.name,startedAt:at(started),stops:[],resumes:0},...options.loop}});
    write(index, "");
    const check = (step:string,result:string,extra:Record<string,unknown>={})=>{
      appendFileSync(index,JSON.stringify({step,result,commit,tree:"4".repeat(40),promptHash:hash(prompt),acceptanceHash:hash(""),startedAt:at(started+2000),
        endedAt:at(started+3000),durationMs:1000,evidence:[],...extra})+"\n");
    };
    const reviewed = (round:number,must=false,minor="无",question="无")=>{
      const path = write(join(dir,`review-${commit}-r${round}-a1.md`),`## 结论：${must ? "需返修" : "通过"}\n## 必修\n${must ? "1. 位置：`src/main.ts:12`\n   触发：再次投递\n   问题：队列没有启动" : "无"}\n## 小问题\n${minor}\n## 需求疑问\n${question}\n## 上轮必修复查\n无\n`);
      check("评审",must ? "必修" : "通过",{evidence:[path],detail:must ? "位置：src/main.ts:12 触发：再次投递" : ""});
    };
    const pass = () => { check("复测","通过"); reviewed(1); };
    return {id, dir, index, status, check, reviewed, pass};
  };
  const issue = (name:string,batch:string,extra="",level="拦不住，依赖方临时撤销已约定能力",folder="issues") => write(join(repo,folder,`【bug】${name}.md`),
    `# 【bug】${name}\n\n状态：待修复\n关联批次：${batch}\n引入批次：定位不到\n本该拦住：${level}\n${extra}\n## 环境与证据\n[提示](../docs/batches/${batch}/提示词.md)\n`);
  const git = (...args:string[])=>execFileSync("git",args,{cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  return {dir,repo,other,tasks,args,run,apply,batch,execution,issue,git};
}
function mustFind<T>(values:T[], hit:(item:T)=>boolean) { const found = values.find(hit); assert(found); return found; }
const tool = resolve(import.meta.dirname,"../tools/coordinate.ts");
type Fixture = ReturnType<typeof fixture>;
type Run = ReturnType<Fixture["execution"]>;
function recordProof(run: Run, sha = before, acceptanceHash = hash("")) {
  const old = write(join(run.dir,"red.log"),"旧版走到原单重投，0 != 1\n");
  write(join(run.dir,"green.log"),"新版目标通过\n");
  const report = {issue:"PA046",target:"S3 / 原单重投",executionId:run.id,result:"已证明",materialsHash:"a".repeat(64),
    before:{commit:sha,result:"目标断言失败",expected:1,actual:0,log:"red.log"},after:{commit,result:"通过",expected:1,actual:1,log:"green.log"}};
  const file = doc(join(run.dir,"proof.json"),report);
  run.check("防复发证明","已证明",{evidence:[file],acceptanceHash});
  return {old,file,report};
}
async function interruptApply(f: Fixture, cmd: string, id: string, source: string, clock: number, collide?: string) {
  const hook = write(join(f.dir,"interrupt-archive.mjs"),`
import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const rename = fs.renameSync;
fs.renameSync = (src,dest) => {
  rename(src,dest);
  if (src !== ${JSON.stringify(source)} || !dest.endsWith('.original')) return;
  const collision = ${JSON.stringify(collide ?? null)};
  if (collision) fs.writeFileSync(collision,'同名历史原件\\n');
  process.kill(process.pid,'SIGKILL');
};
syncBuiltinESMExports();`);
  const entry = `import {coordinate} from ${JSON.stringify(tool)}; coordinate(${JSON.stringify(f.args(cmd,["--apply",id]))},${clock});`;
  await assert.rejects(promisify(execFile)(process.execPath,["--import",hook,"--input-type=module","-e",entry]),{signal:"SIGKILL"});
}

test("开工只复盘同项目上一批；同批多个执行、多轮及重读不重复计数",t=>{
  const f = fixture(t), a = f.batch("批甲"), b = f.batch("批乙"), incoming = f.batch("待开工"), other = f.batch("批乙",f.other);
  const legacy = f.execution(a,"old",now-days(5),{loop:{facts:undefined}});
  legacy.reviewed(1,true); legacy.reviewed(2,true);
  const prior = f.execution(a,"old-retry",now-days(4),{loop:{facts:{stops:[{at:at(now-days(4)+1000),reason:"停下没交付",message:"旧批原话"}]}}});
  prior.reviewed(1,true);
  const snapshot = (run:typeof prior)=>{
    doc(join(run.dir,"snapshot-base.json"),{groups:[{answerMode:"original",scenarios:[{name:"原单重投",status:"完成",elapsedMs:10}]}]});
    doc(join(run.dir,`snapshot-${commit}.json`),{groups:[{answerMode:"original",scenarios:[{name:"原单重投",status:"跳过",reason:"ENOENT",elapsedMs:80}]}]});
  };
  snapshot(prior);
  const first = f.run("查询");
  for (const key of ["file:src/main.ts","scene:原单重投","stop:停下没交付"]) assert.equal(mustFind(first.candidates,c=>c.key===key).status,"信号");
  const next = f.execution(b,"ours",now-days(3),{loop:{facts:{stops:[{at:at(now-days(3)+1000),reason:"停下没交付",message:"原话",resolvedBy:"续跑"}]},delivery:{commit,note:"收尾笔记：需补一条准备步骤"}}});
  const unrelated = f.execution(other,"unrelated",now-days(2),{root:f.other}); unrelated.reviewed(1,true,"- 不得带到 PA");
  write(join(unrelated.dir,"answers.jsonl"),"他项目残缺记录；公开查询不应尝试读它\n");
  next.check("复测","失败",{detail:"Error at src/main.ts:15",evidence:[write(join(next.dir,"test.log"),"failed\n")]});
  next.reviewed(1,true,"- 位置：src/optional.ts:9：改个提示", "- 是否要自动重投？");
  next.reviewed(2);
  snapshot(next);
  jsonl(join(next.dir,"窗口原话.jsonl"),[{at:at(now-days(3)),text:"请留原话\n第二行"}]);
  const args = ["--card",incoming.card], opened = f.run("开工",args);
  assert.equal(opened.history.query.available,true);
  assert.equal(opened.history.query.matched,1);
  assert.equal(opened.history.query.execution,next.id);
  assert.equal(opened.previous?.batch,"docs/batches/批乙");
  const signals = opened.previous!.executions.flatMap(e=>e.signals);
  assert.deepEqual(new Set(signals.map(s=>s.kind)),new Set(["必修","小问题","需求疑问","复测失败","停下原因","运行差异","收尾笔记","窗口原话"]));
  assert(signals.every(s=>existsSync(s.source.file)));
  assert.equal(mustFind(signals,s=>s.kind==="窗口原话").text,"请留原话\n第二行");
  assert.equal(signals.filter(s=>s.kind==="运行差异").length,1);
  assert(!JSON.stringify(opened).includes("不得带到 PA"));
  const c = mustFind(opened.candidates,c=>c.key==="file:src/main.ts");
  assert.equal(c.status,"候选"); assert.equal(c.occurrences.length,2); assert.deepEqual(c.occurrences[0].executions,["old","old-retry"]);
  for (const key of ["scene:原单重投","stop:停下没交付"]) assert(mustFind(opened.candidates,c=>c.key===key).needsDecision);
  assert.deepEqual(f.run("开工",args).candidates,opened.candidates);
  assert(!existsSync(join(f.repo,".dev-loop-coord")));
  assert(f.run("查询").previous?.executions[0].gaps.every(g=>g.kind!=="窗口原话"));
});

test("候选本人决定可重复登记；已批准、观测无再现、后续再现分开",t=>{
  const f=fixture(t), one=f.batch("one"), two=f.batch("two");
  for (const [i,b] of [one,two].entries()) f.execution(b,`seen${i}`,now-days(5-i)).reviewed(1,true,"- src/minor.ts:3 小项");
  const candidates = f.run("查询").candidates, main = mustFind(candidates,c=>c.key==="file:src/main.ts"), minor = mustFind(candidates,c=>c.key==="file:src/minor.ts");
  const decide = (candidate:string,decision:string,landing?:string)=>{
    const file = doc(join(f.repo,`${decision}.json`),{candidate,decision,landing,at:at(now-days(3)),reason:"本人正式决定原文"}), args=["--decision",file];
    const plan = f.run("候选决定",args); assert.equal(plan.changes.length,1);
    f.apply("候选决定",plan,args); f.apply("候选决定",plan,args); assert.equal(f.run("候选决定",args).changes.length,0);
  };
  decide(main.id,"已批准","REVIEW.md 某条"); decide(minor.id,"接受不处理");
  const state = ()=>mustFind(f.run("查询").candidates,c=>c.id===main.id).status;
  assert.equal(state(),"已批准");
  const same = f.execution(two,"rerun",now-days(2.5)); same.reviewed(1,true); assert.equal(state(),"已批准");
  const observed = f.execution(f.batch("after"),"after",now-days(2)); observed.pass(); assert.equal(state(),"已确认");
  const confirmation = f.run("查询"); assert.equal(confirmation.changes[0].kind,"候选确认");
  f.apply("查询",confirmation); f.apply("查询",confirmation); assert.equal(f.run("查询").changes.length,0);
  f.execution(f.batch("later"),"later",now-days(1)).reviewed(1,true,"- src/minor.ts:5 小项还在");
  assert.equal(state(),"批准后再现");
  const accepted = mustFind(f.run("查询").candidates,c=>c.id===minor.id);
  assert.equal(accepted.status,"接受不处理"); assert(!accepted.needsDecision);
});

test("关单区分检查结论、合入部署及批次反馈；校验目标、同版证据和本人授权",t=>{
  const f=fixture(t), b=f.batch("修复"), repair=f.execution(b,"fix",now-days(9)), other=f.execution(f.batch("other",f.other),"fix-other",now-days(12),{root:f.other});
  other.pass(); repair.pass();
  repair.check("合入","已合入",{detail:JSON.stringify({devAfter:merged})});
  repair.check("部署","已部署",{commit:merged});
  write(b.acceptance,"状态：不通过\n\n反馈：有其它问题\nA2. [授权] 操作：用真实账号走场景 S3\nA9. [授权] 操作：场景 S9 的另一件事\n");
  const permitted = f.issue("有授权的修复",b.name,"编号：PA046\n防复发检查：S3 / 原单重投","功能地图，场景 S3");
  const noTest = f.issue("关联跨项目","fix-other"), noReason = f.issue("待归因",b.name,"","拦不住");
  const wrongTarget = f.issue("证明目标不一致",b.name,"编号：PA047\n防复发检查：另一条", "测试用例，目标断言");
  const separate = f.batch("无授权的另一批"); f.execution(separate,"no-auth",now-days(7)).pass();
  const simple = f.issue("明确原因",separate.name), duplicate = f.issue("同名",separate.name);
  const collision = f.issue("同名",separate.name,"","拦不住，已做记录","issues/【history】"), savedCollision=read(collision);
  const {file:evidence} = recordProof(repair);
  let p=f.run("查询");
  assert.deepEqual(p.changes.map(c=>c.from),[simple]);
  assert.equal(mustFind(p.issues,v=>v.file===permitted).state,"已部署");
  assert.match(mustFind(p.issues,v=>v.file===permitted).reasons.join(" "),/A2 缺本人/);
  jsonl(join(repair.dir,"answers.jsonl"),[{at:at(now-days(9)+3500),text:"例子，不是允许操作：\n同意授权：A2"}]);
  assert(!mustFind(f.run("查询").issues,v=>v.file===permitted).ready);
  jsonl(join(repair.dir,"answers.jsonl"),[{at:at(now-days(9)+4000),text:"同意授权：A2"},{at:at(now-days(9)+5000),text:"不授权：A2"}]);
  assert(!mustFind(f.run("查询").issues,v=>v.file===permitted).ready);
  appendFileSync(join(repair.dir,"answers.jsonl"), JSON.stringify({at:at(now-days(9)+6000),text:"同意授权：A2"})+"\n");
  const originalAcceptance=read(b.acceptance);
  appendFileSync(b.acceptance,"A10. [授权] 操作：需确认是哪条路径\n");
  assert.match(mustFind(f.run("查询").issues,v=>v.file===permitted).reasons.join(" "),/关系不明确/);
  write(b.acceptance,originalAcceptance);
  p=f.run("查询");
  assert.deepEqual(new Set(p.changes.map(c=>c.from)),new Set([permitted,simple]));
  assert(p.blocked.some(b=>b.source.file===duplicate));
  const original=read(permitted), receipt=f.apply("查询",p);
  assert("applied" in receipt && receipt.applied.results.every(r=>r.status==="applied"));
  assert(!existsSync(permitted));
  assert(existsSync(noTest) && existsSync(noReason) && existsSync(wrongTarget));
  assert.equal(read(collision),savedCollision);
  assert("applied" in receipt && receipt.applied.results.some(r=>r.original && read(r.original)===original));
  const archived = read(join(f.repo,"issues/【history】/【bug】有授权的修复.md"));
  assert.match(archived,/状态：已解决（关闭原因：完成）/);
  assert(archived.includes(evidence) && archived.includes("../../docs/batches/修复/提示词.md"));
  assert.equal(f.run("查询").acceptances[0].state,"不通过");
});

test("显式验收项读取独立标准的子节；缺项或材料不可读时保留原单",t=>{
  const f=fixture(t), b=f.batch("独立验收"), criteria=join(b.d,"检查标准.md");
  const text = "# 本批检查\n\n## 验收标准\n\n### 真实账号\n\n#### 手工核对\nA2. [授权] 使用正式账号\n\n## 附录示例\nA2. 示例，不是验收条目\n";
  const run=f.execution(b,"nested-criteria",now-days(2),{task:{acceptance:criteria}});
  const issue=f.issue("仅引用编号",b.name,"验收项：A2"), original=read(issue);
  const check = (s:string)=>{
    write(criteria,s); run.check("复测","通过",{acceptanceHash:hash(s)}); run.check("评审","通过",{acceptanceHash:hash(s)});
  };
  const view=()=>mustFind(f.run("查询").issues,v=>v.file===issue);
  write(b.acceptance,"状态：通过\n");
  check(text);
  assert.match(view().reasons.join("\n"),/A2 缺本人/);
  assert(view().evidence.some(s=>s.file===criteria && s.line===8));
  jsonl(join(run.dir,"answers.jsonl"),[{at:at(now-days(1)),text:"同意授权：A2"}]);
  assert(view().ready);
  check(text.replace("A2. [授权]","A3. [授权]"));
  assert.match(view().reasons.join("\n"),/缺本单明确引用的条目：A2/);
  rmSync(criteria);
  assert.match(view().reasons.join("\n"),/授权要求来源不可读，无法核对 A2/);
  assert.equal(read(issue),original);
});

test("显式 A2 跨验证场景仍需授权，简写不抵消；明确属另一单时两处证据都保留",t=>{
  const f=fixture(t), b=f.batch("跨场景验收"), criteria=join(b.d,"标准.md"), summary="状态：待验\n\nA2. 核对结果\n";
  const r=f.execution(b,"scoped-authorization",now-days(2),{task:{acceptance:criteria}});
  const issue=f.issue("明确引用",b.name,"编号：PA046\n验收项：A2\n防复发检查：S3 / 原单重投","功能地图，S3");
  const other=f.issue("另一张单",b.name,"编号：PA099");
  const original=read(issue), originalIndex=r.index;
  const setCriteria = (line:string)=>{
    const text=`## 验收标准\n\n${line}\n`, acceptanceHash=hash(text);
    write(criteria,text); write(originalIndex,"");
    r.check("复测","通过",{acceptanceHash}); r.check("评审","通过",{acceptanceHash});
    const proof=recordProof(r,undefined,acceptanceHash);
    assert(existsSync(proof.file));
  };
  write(b.acceptance,summary);
  setCriteria("A2. [授权] 用正式账号检查 S5");
  const view=()=>mustFind(f.run("查询").issues,v=>v.file===issue);
  assert.match(view().reasons.join("\n"),/A2 缺本人/);
  assert(view().evidence.some(s=>s.file===criteria && s.line===3));
  assert(!f.run("查询").changes.some(c=>c.from===issue));
  jsonl(join(r.dir,"answers.jsonl"),[{at:at(now-days(1)),text:"同意授权：A2"}]);
  assert(view().ready,"明确编号优先于防复发场景的推断");
  setCriteria("A2. [授权] 仅用于 PA099 的正式账号检查 S5");
  const conflicted=view();
  assert(!conflicted.ready); assert.match(conflicted.reasons.join("\n"),/A2 .*归属冲突/);
  assert([issue,criteria,b.acceptance].every(file=>conflicted.evidence.some(s=>s.file===file)));
  assert(existsSync(other)); assert.equal(read(issue),original);
});

test("同批两单中只需取得本单的明确授权；无归属仍保守保留",t=>{
  const f=fixture(t), b=f.batch("同批两单"), r=f.execution(b,"same-fix",now-days(1)); r.pass();
  const plainIssue=f.issue("自动定向验证",b.name,"编号：PA046\n防复发检查：S3 / 原单重投","功能地图，场景 S3");
  const restricted=f.issue("真实账号检查",b.name,"编号：PA099");
  recordProof(r);
  const criteria="状态：待验\n\nA9. [授权] 仅用于 PA099 的正式账号检查\n";
  write(b.acceptance,criteria);
  const report=f.run("查询");
  assert.deepEqual(report.changes.map(c=>c.from),[plainIssue]);
  assert.match(mustFind(report.issues,v=>v.file===restricted).reasons.join("\n"),/A9 缺本人/);
  appendFileSync(b.acceptance,"\nA10. [授权] 未明确属于哪一单\n");
  assert(f.run("查询").issues.filter(v=>[plainIssue,restricted].includes(v.file)).every(v=>v.reasons.some(r=>r.includes("关系不明确"))));
  write(b.acceptance,criteria);
  f.apply("查询",f.run("查询"));
  assert(!existsSync(plainIssue)); assert(existsSync(restricted));
  jsonl(join(r.dir,"answers.jsonl"),[{at:at(now-1),text:"同意授权：A9"}]);
  assert(mustFind(f.run("查询").issues,v=>v.file===restricted).ready);
});

test("同一授权条目同时覆盖本单目标和另一单；仅限另一单的要求仍分开",t=>{
  const f=fixture(t), b=f.batch("共享授权"), criteria=join(b.d,"正式标准.md");
  const r=f.execution(b,"shared-auth",now-days(2),{task:{acceptance:criteria}});
  const a=f.issue("原单重投",b.name,"编号：PA046\n防复发检查：S3 / 原单重投","功能地图，S3"), other=f.issue("真实账号",b.name,"编号：PA099");
  const setCriteria = (line:string) => {
    const text=`## 验收标准\n\nA2. [授权] ${line}\nA9. [授权] 仅用于 PA099 的另一项正式检查\n`, acceptanceHash=hash(text);
    write(criteria,text); r.check("复测","通过",{acceptanceHash}); r.check("评审","通过",{acceptanceHash});
    recordProof(r,undefined,acceptanceHash);
  };
  setCriteria("同时验证 S3 / 原单重投和 PA099 的 S5");
  const initial=f.run("查询"), aView=mustFind(initial.issues,v=>v.file===a), bView=mustFind(initial.issues,v=>v.file===other);
  for (const view of [aView,bView]) {
    assert.match(view.reasons.join("\n"),/A2 缺本人/);
    assert(view.evidence.some(s=>s.file===criteria && s.line===3));
  }
  assert(!initial.changes.some(c=>c.kind==="关单")); assert(!aView.reasons.some(r=>r.includes("A9")));
  jsonl(join(r.dir,"answers.jsonl"),[{at:at(now-days(1)),text:"同意授权：A2"}]);
  assert.deepEqual(f.run("查询").changes.map(c=>c.from),[a]);
  setCriteria("仅用于 PA099 的检查，但须验证 S3 / 原单重投");
  const conflict=mustFind(f.run("查询").issues,v=>v.file===a);
  assert.match(conflict.reasons.join("\n"),/A2 .*归属冲突/);
  assert(conflict.evidence.some(s=>s.file===criteria && s.line===3)); assert(!conflict.ready);
});

test("授权适用范围按编号集合核对：同场景、简写和已有批准都不能扩大范围",t=>{
  const f=fixture(t), b=f.batch("授权范围表"), r=f.execution(b,"scope-list",now-days(2)); r.pass();
  const issue=f.issue("带显式引用",b.name,"编号：PA046\n验收项：A2\n防复发检查：S3 / 原单重投","功能地图，S3");
  const others=["PA099","PA100"].map(id=>f.issue(id,b.name,`编号：${id}`,"测试用例，另需定向证明"));
  const {file:proof}=recordProof(r), original=read(issue);
  const criteria=join(b.d,"标准.md"), taskFile=join(r.dir,"task.json");
  doc(taskFile,{...JSON.parse(read(taskFile)),acceptance:criteria});
  write(b.acceptance,"状态：待验\nA2. 核对结果\n");
  jsonl(join(r.dir,"answers.jsonl"),[{at:at(now-days(1)),text:"同意授权：A2"}]);
  const variants = [
    ["仅用于 PA099、PA100 的 S3 检查",false],
    ["仅限 PA099 的 S3 检查",false],
    ["仅限于（问题单 PA099、PA100）或 S3 的办理说明",false],
    ["仅用于问题单 PA099、PA100 及 PA046 的 S3 检查",true],
    ["仅限：『PA099』和 `PA046` 的 S5 检查",true],
    ["仅限场景 S5",false],
    ["仅限场景 S1、S3",true],
    ["仅限协调方刚才说的那张单，核对 S3",false],
    ["仅限于 PA046、PA099 等",false],
    ["只用于 PA046 或 PA099，核对 S3",true],
    ["同时验证 S3 / 原单重投、PA099、PA100 的 S5",true],
    ["用正式账号检查 S5",true],
  ] as const;
  for (const [scope,allowed] of variants) {
    const text=`## 验收标准\n\n### 授权验证\nA2. [授权] ${scope}\n`, acceptanceHash=hash(text);
    write(criteria,text); r.check("复测","通过",{acceptanceHash}); r.check("评审","通过",{acceptanceHash});
    r.check("防复发证明","已证明",{acceptanceHash,evidence:[proof]});
    const preview=f.run("查询"), view=mustFind(preview.issues,v=>v.file===issue);
    assert.equal(view.ready,allowed,scope); assert.equal(preview.changes.some(c=>c.from===issue),allowed,scope);
    if (!allowed) {
      assert.match(view.reasons.join("\n"),/A2 .*归属冲突/,scope);
      assert(view.evidence.some(s=>s.file===issue && s.line===8),scope);
      assert(view.evidence.some(s=>s.file===criteria && s.line===4),scope);
      f.apply("查询",preview);
      assert.equal(read(issue),original);
    }
  }
  assert(others.every(existsSync));
});

test("R1 A9：专属名单之后明确排除的单号不得借用已有授权",t=>{
  const f=fixture(t), b=f.batch("授权排除"), criteria=join(b.d,"正式标准.md");
  const run=f.execution(b,"excluded",now-days(1),{task:{acceptance:criteria}});
  const excluded=f.issue("已排除",b.name,"编号：PA046\n验收项：A2"), original=read(excluded);
  const included=["PA099","PA100"].map(id=>f.issue(id,b.name,`编号：${id}`));
  jsonl(join(run.dir,"answers.jsonl"),[{at:at(now-1),text:"同意授权：A2"}]);
  const check = (scope: string) => {
    const text=`## 验收标准\n\nA2. [授权] ${scope}\n`, acceptanceHash=hash(text);
    write(criteria,text); run.check("复测","通过",{acceptanceHash}); run.check("评审","通过",{acceptanceHash});
    return f.run("查询");
  };
  const preview=check("仅用于 PA099 或 PA100，PA046 不在本次授权范围内");
  const view=mustFind(preview.issues,v=>v.file===excluded);
  assert.equal(view.ready,false); assert.match(view.reasons.join("\n"),/A2 .*归属冲突/);
  assert(view.evidence.some(s=>s.file===excluded && s.line===8));
  assert(view.evidence.some(s=>s.file===criteria && s.line===3));
  assert.deepEqual(preview.changes.filter(c=>c.kind==="关单").map(c=>c.from).sort(),included.sort());
  assert.equal(read(excluded),original);
  const unclear=check("仅用于 PA099 或 PA100，PA046 是否在本次授权范围内待确认");
  assert(!unclear.changes.some(c=>c.from===excluded),"未确认的尾句不得当作授权名单续项");
});

test("R1 A9：账号用途限制不改变条目归属或免除本单的授权",t=>{
  const f=fixture(t), b=f.batch("授权用途"), criteria=join(b.d,"正式标准.md");
  const run=f.execution(b,"purpose",now-days(1),{task:{acceptance:criteria}});
  const independent=f.issue("独立单",b.name,"编号：PA046"), needsAuth=f.issue("正式账号检查",b.name,"编号：PA099");
  const check = (scope: string) => {
    const text=`## 验收标准\n\nA2. [授权] ${scope}\n`, acceptanceHash=hash(text);
    write(criteria,text); run.check("复测","通过",{acceptanceHash}); run.check("评审","通过",{acceptanceHash});
    return f.run("查询");
  };
  const scope="仅用于 PA099；临时账号仅用于读取数据";
  const preview=check(scope), restricted=mustFind(preview.issues,v=>v.file===needsAuth);
  assert.deepEqual(preview.changes.filter(c=>c.kind==="关单").map(c=>c.from),[independent]);
  assert(!restricted.ready); assert.match(restricted.reasons.join("\n"),/A2 缺本人/);
  assert(restricted.evidence.some(s=>s.file===criteria && s.line===3));
  assert(!check("仅用于 PA099；本条也仅用于协调方提到的那张单").changes.some(c=>c.from===independent),"归属仍不明确时保留原单");
  jsonl(join(run.dir,"answers.jsonl"),[{at:at(now-1),text:"同意授权：A2"}]);
  assert(!check("仅用于 PA099；临时账号仅用于 PA046").changes.some(c=>c.from===needsAuth),"账号限制明确指向另一单时，不能放宽冲突的授权范围");
  assert(mustFind(check(scope).issues,v=>v.file===needsAuth).ready);
});

test("结构化证明必须使用登记的旧版；未声明旧版只认开工基线",t=>{
  const f=fixture(t), b=f.batch("补证明"), historical="5".repeat(40), wrong="6".repeat(40);
  const declaration = {issue:"PA046",scenario:"S3",checkpoint:"原单重投",before:historical};
  const run=f.execution(b,"proof-versions",now-days(2),{task:{proofs:[declaration]}}); run.pass();
  const issue=f.issue("防复发",b.name,"编号：PA046","功能地图，S3"), stillOpen=()=>!mustFind(f.run("查询").issues,v=>v.file===issue).ready;
  const {file,report}=recordProof(run,wrong);
  assert(stillOpen(),"不能拿其它旧版的失败代替登记旧版");
  doc(file,{...report,before:{...report.before,commit:historical}});
  assert(!stillOpen());
  const task=join(run.dir,"task.json"), saved=JSON.parse(read(task));
  doc(task,{...saved,proofs:[{...declaration,before:"无法确定"}]}); assert(stillOpen());
  doc(task,{...saved,proofs:[{...declaration,before:undefined}]}); assert(stillOpen(),"省略旧版时必须使用 baseCommit");
  doc(file,{...report,before:{...report.before,commit:before}});
  assert(!stillOpen());
  doc(file,{...report,before:{...report.before,commit:before},after:{...report.after,commit:wrong}}); assert(stillOpen());
});

test("同版旧红新绿的 PA 手工对照可追溯；标准变化、缺日志不关单",t=>{
  const f=fixture(t), b=f.batch("旧记录"), r=f.execution(b,"legacy-proof",now-days(8)); r.pass();
  const old = write(join(b.d,"old.tap"),"目标断言失败\n"), green=write(join(b.d,"green.tap"),"通过\n");
  const file=doc(join(b.d,"对照.json"),{"测试来源":commit,"测试文件SHA256":{"e2e/S3.mjs":"b".repeat(64)},"运行":[
    {"版本":before,"场景":"S3","退出":1,"日志":"old.tap","命令":["node","--test","S3.mjs"],"检查点":[{scenario:"S3",checkpoint:"原单重投",status:"失败",expected:1,actual:0}]},
    {"版本":commit,"场景":"S3","退出":0,"日志":"green.tap","命令":["node","--test","S3.mjs"],"检查点":[{scenario:"S3",checkpoint:"原单重投",status:"通过",expected:1,actual:1}]}]});
  const bug = f.issue("旧证明",b.name,`防复发检查：S3 / 原单重投\n防复发证明：[对照](<${file}>)`,"功能地图，S3");
  assert(mustFind(f.run("查询").issues,v=>v.file===bug).ready);
  appendFileSync(b.req,"变了\n"); assert(!mustFind(f.run("查询").issues,v=>v.file===bug).ready);
  write(b.req,prompt); rmSync(old); assert(existsSync(green)); assert(!mustFind(f.run("查询").issues,v=>v.file===bug).ready);
});

test("七天或下次开工结束人工提醒；历史、迟来反馈及未知部署时间不误写",t=>{
  const f=fixture(t), old=f.batch("旧批"), fresh=f.batch("最近批"), incoming=f.batch("准备启动"), pending=f.batch("未启动");
  const r = f.execution(old,"deployed",now-days(9)); r.pass(); r.check("部署","已部署",{endedAt:at(now-days(7))});
  const crlf = "状态：待验收\r\n\r\nA1. [人工] 操作：试入口\r\nA2. [授权] 操作：用真实账号，不许代发\r\nA3. [授权] 操作：另一账号\r\n本人已做：A3\r\n";
  write(old.acceptance,crlf);
  write(fresh.acceptance,"状态：待验\n\n1. 业务人工试用\n"); write(pending.acceptance,"状态：待验\n\nA1. [人工] 尚未上线\n");
  const passed=f.batch("通过"), nope=f.batch("不通过"), waived=f.batch("不验"), newer=f.batch("有反馈");
  for (const b of [passed,nope,waived,newer]) { f.execution(b,b.name,now-days(11)).pass(); write(b.acceptance,`状态：${b===newer?"待验":b.name}\n`); }
  appendFileSync(newer.acceptance,"\n## 本人反馈\n试过，有衍生问题\n");
  const preview=f.run("查询");
  assert(!preview.changes.some(c=>c.kind==="结束提醒")); assert(preview.blocked.some(b=>b.source.file===old.acceptance));
  const args=["--acceptance-ready"], readable=f.run("查询",args);
  assert.equal(mustFind(readable.acceptances,v=>v.file===old.acceptance).reason,"部署满七天");
  assert.equal(mustFind(readable.acceptances,v=>v.file===newer.acceptance).state,"有反馈");
  f.apply("查询",readable,args);
  assert(read(old.acceptance).startsWith(crlf.replace("待验收","未确认（无反馈）")));
  assert.match(read(old.acceptance),/A2 \[授权\]：授权未做/); assert.match(read(old.acceptance),/A3 \[授权\]：本人已做/);
  appendFileSync(old.acceptance,"\n本人反馈：次日发现新问题\n");
  const r2 = f.execution(fresh,"deployed-no-date",now-days(2)); r2.pass(); r2.check("部署","已部署",{endedAt:""});
  const unknown=mustFind(f.run("查询",args).acceptances,v=>v.file===fresh.acceptance);
  assert.equal(unknown.sevenDaysAt,null); assert(!unknown.due);
  const openingArgs=[...args,"--card",incoming.card], opening=f.run("开工",openingArgs);
  assert.equal(mustFind(opening.acceptances,v=>v.file===old.acceptance).state,"有反馈");
  assert.deepEqual(opening.changes.filter(c=>c.kind==="结束提醒").map(c=>c.to),[fresh.acceptance]);
  f.apply("开工",opening,openingArgs);
  assert.match(read(old.acceptance),/次日发现新问题/); assert.match(read(pending.acceptance),/^状态：待验/);
  assert.match(read(fresh.acceptance),/^状态：未确认（无反馈）/);
});

test("同一卡未部署的重试不抹掉旧部署；退回和无时间的新部署不借用旧时间",t=>{
  const f=fixture(t), b=f.batch("曾部署"), d=f.execution(b,"earlier",now-days(10)); d.pass();
  const deployedAt=at(now-days(8)), newer=f.execution(b,"retry",now-days(2),{state:"working"});
  d.check("合入","已合入",{detail:JSON.stringify({devAfter:merged})});
  d.check("部署","已部署",{commit:merged,endedAt:deployedAt});
  write(b.acceptance,"状态：待验\nA1. [人工] 确认入口\n");
  const view=()=>f.run("查询",["--acceptance-ready"]).acceptances[0];
  const initial=view(); assert.equal(initial.reason,"部署满七天"); assert.equal(initial.deploymentAt,deployedAt);
  assert.equal(initial.deploymentExecution,d.id); assert.equal(initial.deploymentCommit,merged);
  assert(initial.sources.some(s=>s.file===d.index));
  newer.check("部署","部署失败，已回退");
  assert.equal(view().deploymentAt,deployedAt,"失败的另一次尝试不能抹掉原部署");
  d.check("退回","已退回",{commit:merged,endedAt:at(now-days(1))});
  assert.equal(view().deployment,"已退回"); assert.equal(view().sevenDaysAt,null); assert(!view().due);
  newer.check("部署","已部署",{startedAt:at(now-days(0.75)),endedAt:""});
  assert.equal(view().deploymentExecution,newer.id); assert.equal(view().deploymentAt,null); assert(!view().due);
  doc(join(newer.dir,"status.json"),{executionId:newer.id,state:"completed",loop:{commit}});
  write(b.results,`## ${at(now-days(1))}\n执行：${newer.id}\n版本：${commit}\n部署时间：${at(now-days(1))}\n`);
  assert.equal(view().deploymentAt,null,"同一执行有多次部署，不能用未定位到单次的旧结果补时");
});

for (const failure of ["部署失败，回退也失败","部署失败，未回退"]) test(`较新${failure}不能沿用旧部署的七天时间；下次开工独立`,t=>{
  const f=fixture(t), b=f.batch("旧版仍待验"), first=f.execution(b,"published",now-days(10),{state:"working"}); first.pass();
  first.check("部署","已部署",{endedAt:at(now-days(8))});
  write(b.acceptance,"状态：待验\nA1. [人工] 确认页面\n");
  const newer=f.execution(b,"retry-failed",now-days(2),{state:"working"}); newer.pass();
  // 试合并版本尚未写入合入流水，仍要保留已实际执行的失败尝试。
  newer.check("部署",failure,{commit:merged,endedAt:at(now-days(1))});
  const args=["--acceptance-ready"], p=f.run("查询",args), v=p.acceptances[0];
  assert.equal(v.deployment,failure); assert.equal(v.deploymentExecution,newer.id); assert.equal(v.deploymentCommit,merged);
  assert.equal(v.sevenDaysAt,null); assert(!v.due); assert(!p.changes.some(c=>c.to===b.acceptance));
  assert(v.sources.some(s=>s.file===newer.index && s.line===3));
  const next=f.batch("下一张卡"), opening=f.run("开工",[...args,"--card",next.card]);
  assert.equal(opening.acceptances[0].reason,"同项目下次开工");
  assert(opening.changes.some(c=>c.to===b.acceptance));
});

test("旧部署无时间但退回有时间；更晚已部署版照常计算七天",t=>{
  const f=fixture(t), b=f.batch("两次部署"), older=f.execution(b,"old-without-time",now-days(12)); older.pass();
  older.check("部署","已部署",{endedAt:""});
  const later=f.execution(b,"later-release",now-days(10),{loop:{commit:merged,delivery:{commit:merged}}});
  // 执行乙可以早已开工；它实际开始部署的时刻晚于甲的退回。
  later.check("部署","已部署",{commit:merged,startedAt:at(now-days(8.5)),endedAt:at(now-days(8))});
  write(b.acceptance,"状态：待验\nA1. [人工] 核对最新版本\n");
  const args=["--acceptance-ready"], unknown=f.run("查询",args).acceptances[0];
  assert.equal(unknown.deployment,"部署先后不明"); assert(!unknown.due);
  older.check("退回","已退回",{endedAt:at(now-days(9))});
  const p=f.run("查询",args), v=p.acceptances[0];
  assert.equal(v.deployment,"已部署"); assert.equal(v.deploymentExecution,later.id); assert.equal(v.deploymentCommit,merged);
  assert.equal(v.deploymentAt,at(now-days(8))); assert.equal(v.reason,"部署满七天");
  assert(v.sources.some(s=>s.file===older.index && s.line===4));
  f.apply("查询",p,args);
  assert.match(read(b.acceptance),/^状态：未确认（无反馈）/);
});

test("A 首版后开的 B 不能结束 A 新版的待验提醒",t=>{
  const f=fixture(t), a=f.batch("A 双版本"), first=f.execution(a,"first-A",now-days(10)); first.pass();
  first.check("部署","已部署",{endedAt:at(now-days(9))});
  const b=f.batch("B"); f.execution(b,"next-after-first",now-days(8)).pass();
  const content="状态：待验\n\nA1. [人工] 看新版\n";
  write(a.acceptance,content);
  const args=["--acceptance-ready"], get=()=>f.run("查询",args);
  assert.equal(get().acceptances[0].reason,"同项目下次开工");
  const newer=f.execution(a,"second-A",now-days(2),{loop:{commit:merged,delivery:{commit:merged}}});
  newer.check("部署","已部署",{commit:merged,endedAt:at(now-days(1))});
  const p=get(), v=p.acceptances[0];
  assert.equal(v.deploymentExecution,newer.id); assert.equal(v.deploymentAt,at(now-days(1)));
  assert.equal(v.nextStartAt,null); assert.equal(v.sevenDaysAt,at(now+days(6))); assert(!v.due);
  assert(!p.changes.some(c=>c.to===a.acceptance)); f.apply("查询",p,args); assert.equal(read(a.acceptance),content);
  const c=f.batch("C"); f.execution(c,"next-after-second",now-days(0.5));
  assert.equal(get().acceptances[0].reason,"同项目下次开工");
});

test("试部署合入失败后凭恢复登记沿用上一版；无登记、不同尝试或手工退回不推断",t=>{
  const f=fixture(t), b=f.batch("补偿后的待验"), old=f.execution(b,"old-deployed",now-days(10)); old.pass();
  const oldAt=at(now-days(8)), oldEvidence=join(old.dir,"deploy-old"), marker=join(f.tasks,`.deployed-${hash(f.repo).slice(0,20)}.json`);
  old.check("部署","已部署",{endedAt:oldAt,evidence:[oldEvidence+".log",oldEvidence]});
  const retry=f.execution(b,"merge-failed",now-days(2),{state:"input_required",loop:{wait:"收尾没走完"}});
  const trial=join(retry.dir,"deploy-trial"), trialAt=at(now-days(1)), restoredAt=at(now-days(0.95));
  retry.check("部署","已部署",{commit:merged,endedAt:trialAt,evidence:[trial+".log",trial]});
  retry.check("合入","合入失败");
  retry.check("退回","已退回",{commit:merged,endedAt:restoredAt,evidence:[trial,join(trial,"merge-rollback.log")]});
  retry.check("收尾","失败",{detail:"合入失败，线上已回退",evidence:[trial]});
  const original="状态：待验\n\nA1. [人工] 核对旧版\n";
  write(b.acceptance,original);
  const args=["--acceptance-ready"], get=()=>f.run("查询",args);
  assert.equal(get().acceptances[0].deployment,"已退回"); assert(!get().acceptances[0].due);
  doc(marker,{executionId:old.id,commit,evidenceDir:join(old.dir,"deploy-another"),rollback:"scripts/rollback"});
  assert(!get().acceptances[0].due,"同执行同提交但不是原部署尝试");
  doc(marker,{executionId:old.id,commit,evidenceDir:oldEvidence,rollback:"scripts/rollback"});
  const preview=get(), view=preview.acceptances[0];
  assert.equal(view.deploymentExecution,old.id); assert.equal(view.deploymentAt,oldAt);
  assert.equal(view.reason,"部署满七天"); assert.equal(view.sevenDaysAt,at(now-days(1)));
  assert.deepEqual(view.deploymentFacts.map(d=>d.result).sort(),["已部署","已部署","已退回"].sort());
  assert.deepEqual(view.deploymentRestored?.marker,{file:marker});
  assert.equal(view.deploymentRestored?.trial.line,1); assert.equal(view.deploymentRestored?.rollback.line,3);
  const ledger=read(retry.index); write(retry.index,ledger.replace("merge-rollback.log","manual-rollback.log"));
  assert.equal(get().acceptances[0].deployment,"已退回"); assert(!get().acceptances[0].due);
  assert.equal(read(b.acceptance),original);
  write(retry.index,ledger);
  f.apply("查询",preview,args);
  assert.match(read(b.acceptance),/^状态：未确认（无反馈）/);
});

test("失败且未确认回退的部署使旧登记失效；补偿不能凭登记恢复旧期限",t=>{
  const f=fixture(t), b=f.batch("多次试部署"), old=f.execution(b,"deployed-A",now-days(10));
  const marker=join(f.tasks,`.deployed-${hash(f.repo).slice(0,20)}.json`), oldEvidence=join(old.dir,"deploy-A");
  old.check("部署","已部署",{endedAt:at(now-days(8)),evidence:[oldEvidence+".log",oldEvidence]});
  const bad=f.execution(b,"failed-B",now-days(6),{state:"working"});
  bad.check("部署","部署失败，回退也失败",{commit:"4".repeat(40),endedAt:at(now-days(5))});
  const trial=f.execution(b,"compensated-C",now-days(2),{state:"input_required",loop:{wait:"收尾没走完"}}), trialEvidence=join(trial.dir,"deploy-C");
  trial.check("部署","已部署",{commit:merged,endedAt:at(now-days(1)),evidence:[trialEvidence+".log",trialEvidence]});
  trial.check("合入","合入失败");
  trial.check("退回","已退回",{commit:merged,endedAt:at(now-days(0.9)),evidence:[trialEvidence,join(trialEvidence,"merge-rollback.log")]});
  trial.check("收尾","失败",{detail:"合入失败，线上已回退",evidence:[trialEvidence]});
  doc(marker,{executionId:old.id,commit,evidenceDir:oldEvidence});
  const pending="状态：待验\nA1. [人工] 看页面\n"; write(b.acceptance,pending);
  const args=["--acceptance-ready"], unsafe=f.run("查询",args), view=unsafe.acceptances[0];
  assert.equal(view.deployment,"已退回"); assert.equal(view.deploymentAt,null); assert.equal(view.sevenDaysAt,null); assert(!view.due);
  assert.equal(view.deploymentRestored,undefined);
  assert(view.sources.some(s=>s.file===bad.index && s.line===1));
  assert(view.sources.some(s=>s.file===trial.index && s.line===1));
  assert(view.sources.some(s=>s.file===trial.index && s.line===3));
  f.apply("查询",unsafe,args); assert.equal(read(b.acceptance),pending);
  // 后一次确立的成功部署有自己的时间和登记；失败 B 不再遮蔽它，也不能退回到 A 的时间。
  const reestablished=f.execution(b,"reestablished",now-days(4)), newEvidence=join(reestablished.dir,"deploy-after-B"), fixedAt=at(now-days(3));
  reestablished.check("部署","已部署",{endedAt:fixedAt,evidence:[newEvidence+".log",newEvidence]});
  doc(marker,{executionId:reestablished.id,commit,evidenceDir:newEvidence});
  const restored=f.run("查询",args).acceptances[0];
  assert.equal(restored.deploymentExecution,reestablished.id); assert.equal(restored.deploymentAt,fixedAt);
  assert.equal(restored.sevenDaysAt,at(now+days(4))); assert(!restored.due);
  assert.equal(f.run("查询",args,now+days(4)).acceptances[0].reason,"部署满七天");
});

test("多次试部署按尝试逐对重放；同一提交的两次补偿不混证据目录",t=>{
  const f=fixture(t), b=f.batch("连续试部署"), old=f.execution(b,"known-live",now-days(10)), deployedAt=at(now-days(8));
  const live=join(old.dir,"live-A"), marker=join(f.tasks,`.deployed-${hash(f.repo).slice(0,20)}.json`);
  old.check("部署","已部署",{endedAt:deployedAt,evidence:[live+".log",live]});
  doc(marker,{executionId:old.id,commit,evidenceDir:live});
  write(b.acceptance,"状态：待验\nA1. [人工] 查看部署版本\n");
  const retry=f.execution(b,"same-execution",now-days(4),{state:"input_required"});
  const add = (r:typeof retry, stamp:number, name:string, outcome="已退回", log="merge-rollback.log", wrongDirectory=false) => {
    const dir=join(r.dir,name);
    r.check("部署","已部署",{commit:merged,startedAt:at(stamp),endedAt:at(stamp+3000),evidence:[dir+".log",dir]});
    if (!outcome) return;
    r.check("合入","合入失败");
    const rollback=wrongDirectory ? join(r.dir,"wrong-attempt") : dir;
    r.check("退回",outcome,{commit:merged,startedAt:at(stamp+4000),endedAt:at(stamp+6000),evidence:[rollback,join(rollback,log)]});
    r.check("收尾","失败",{evidence:[dir]});
  };
  add(retry,now-days(3),"trial-1");
  add(retry,now-days(2),"trial-2");
  const last=f.execution(b,"separate-execution",now-days(1.5),{state:"input_required"});
  add(last,now-days(1),"trial-3");
  const args=["--acceptance-ready"], get=()=>f.run("查询",args), ok=get(), view=ok.acceptances[0];
  assert.equal(view.deploymentExecution,old.id); assert.equal(view.deploymentAt,deployedAt);
  assert.equal(view.sevenDaysAt,at(now-days(1))); assert.equal(view.reason,"部署满七天");
  assert.deepEqual(view.deploymentRestored?.pairs.map(p=>[p.trial.file,p.trial.line,p.rollback.file,p.rollback.line]),[
    [retry.index,1,retry.index,3], [retry.index,5,retry.index,7], [last.index,1,last.index,3],
  ]);
  assert.equal(view.deploymentFacts.filter(d=>d.result==="已退回").length,3);
  const valid=read(retry.index);
  for (const problem of ["回退失败","未退回","部署失败未回退","错误目录","普通退回","错误提交","同目录重复尝试","退回时间倒序"] as const) {
    write(retry.index,"");
    add(retry,now-days(3),"trial-1",problem==="回退失败" ? problem : problem==="未退回" ? "" : "已退回",
      problem==="普通退回" ? "manual-rollback.log" : "merge-rollback.log",problem==="错误目录");
    if (["错误提交","部署失败未回退","退回时间倒序"].includes(problem)) {
      const rows=read(retry.index).trim().split("\n").map(line=>JSON.parse(line));
      if (problem==="错误提交") rows[2].commit="4".repeat(40);
      if (problem==="部署失败未回退") { rows[0].result="部署失败，未回退"; rows.splice(1); }
      if (problem==="退回时间倒序") rows[2].endedAt=at(now-days(3));
      jsonl(retry.index,rows);
    }
    add(retry,now-days(2),problem==="同目录重复尝试" ? "trial-1" : "trial-2");
    const rejected=get(), pending=rejected.acceptances[0];
    assert.equal(pending.sevenDaysAt,null,problem); assert(!pending.due,problem); assert.equal(pending.deploymentRestored,undefined,problem);
    assert.equal(pending.deploymentUncertainty,"补偿退回的前序版本无法确认",problem);
    assert(pending.sources.some(s=>s.file===retry.index),problem); assert(pending.sources.some(s=>s.file===last.index),problem);
    assert(!rejected.changes.some(c=>c.to===b.acceptance),problem);
  }
  write(retry.index,valid); f.apply("查询",ok,args);
  assert.match(read(b.acceptance),/结束人工提醒：部署满七天/);
});

test("R1 A9：跨执行试部署区间重叠，不可凭补偿恢复七天期限",t=>{
  const f=fixture(t), b=f.batch("补偿前后重叠"), old=f.execution(b,"live-A",now-days(10));
  const oldEnd=now-days(8), live=join(old.dir,"deployment-A");
  old.check("部署","已部署",{startedAt:at(oldEnd-120_000),endedAt:at(oldEnd),evidence:[live+".log",live]});
  const retry=f.execution(b,"trial-B",now-days(9),{state:"input_required"}), trial=join(retry.dir,"deployment-B");
  const marker=join(f.tasks,`.deployed-${hash(f.repo).slice(0,20)}.json`);
  doc(marker,{executionId:old.id,commit,evidenceDir:live});
  const original="状态：待验\n\nA1. [人工] 核对旧版\n"; write(b.acceptance,original);
  const get = (start?: number) => {
    write(retry.index,"");
    retry.check("部署","已部署",{commit:merged,startedAt:start === undefined ? "" : at(start),endedAt:at(oldEnd+60_000),evidence:[trial+".log",trial]});
    retry.check("合入","合入失败");
    retry.check("退回","已退回",{commit:merged,startedAt:at(oldEnd+70_000),endedAt:at(oldEnd+80_000),evidence:[trial,join(trial,"merge-rollback.log")]});
    return f.run("查询",["--acceptance-ready"]);
  };
  for (const start of [oldEnd-60_000, undefined]) {
    const preview=get(start), view=preview.acceptances[0];
    assert.equal(view.sevenDaysAt,null); assert(!view.due); assert(!view.deploymentRestored);
    assert(!preview.changes.some(c=>c.kind==="结束提醒"));
    assert([old.index,retry.index].every(file=>view.sources.some(s=>s.file===file && s.line===1)));
    assert.equal(read(b.acceptance),original);
  }
  const touching=get(oldEnd).acceptances[0];
  assert.equal(touching.deploymentExecution,old.id); assert.equal(touching.sevenDaysAt,at(oldEnd+days(7)));
  assert.equal(touching.reason,"部署满七天");
});

test("部署缺完成时间时，仅用后续收尾证明下次开工，不推算七天",t=>{
  const f=fixture(t), b=f.batch("缺部署时间"), r=f.execution(b,"unknown-time",now-days(12)); r.pass();
  // 较早的一次收尾在本次部署之前，不能拿它证明随后开的卡更晚。
  r.check("收尾","通过",{endedAt:at(now-days(11))});
  r.check("部署","已部署",{startedAt:at(now-days(9)),endedAt:""});
  r.check("收尾","通过",{endedAt:at(now-days(8))});
  const beforeFinish=f.batch("先开的卡"); f.execution(beforeFinish,"while-deploying",now-days(8.5));
  const pending="状态：待验\nA1. [人工] 核对版本\n"; write(b.acceptance,pending);
  const args=["--acceptance-ready"], early=f.run("查询",args).acceptances[0];
  assert(!early.due); assert.equal(early.nextStartAt,null);
  const later=f.batch("收尾后开工"), next=f.execution(later,"after-finish",now-days(6));
  const plan=f.run("查询",args), view=plan.acceptances[0];
  assert.equal(view.deploymentAt,null); assert.equal(view.sevenDaysAt,null);
  assert.equal(view.nextStartAt,at(now-days(6))); assert.equal(view.reason,"同项目下次开工");
  assert(view.sources.some(s=>s.file===r.index && s.line===5));
  assert(view.sources.some(s=>s.file===join(next.dir,"task.json")));
  assert(plan.changes.some(c=>c.to===b.acceptance && c.kind==="结束提醒"));
  f.apply("查询",plan,args);
  assert.match(read(b.acceptance),/结束人工提醒：同项目下次开工/);
});

test("体检支持实际 PA Markdown 与旧平铺卡；提示漏跑、脚本失配和删除路径",t=>{
  const f=fixture(t), b=f.batch("改动",f.repo,{e2e:[{id:"S4"}]});
  write(join(f.repo,"docs/requirements/功能清单-PA.md"),"### 1. 已发布\n\n固定编号 **F1** · 状态 **已上线**（范围）\n怎么验　用定向测试，体验由本人判断。\n\n### F2 无验法\n状态：已上线\n\n### F3 已删\n状态：已删除\n\n### F4 已删但有反向\n状态：已删除\n");
  write(join(f.repo,"docs/requirements/功能地图-PA.md"),[
    "### S1 · 老路径\n- 所属功能　F3，关联 F4。所属模块 `src/main.ts`。\n- 脚本　`e2e/S1.mjs`。状态 **已批准**。",
    "### S2 · 无归属\n所属功能：F99\n脚本：e2e/S5.mjs",
    "### S3 · 反向\n所属功能：F4\n反向：F4\n所属模块：src/removed/**\n脚本：e2e/S3.mjs",
    "### S4 · 受影响\n所属功能：F2\n所属模块：src/main.ts\n脚本：e2e/S4.mjs",
  ].join("\n\n"));
  for (const name of ["S1","S3","S5"]) write(join(f.repo,`e2e/${name}.mjs`),"throw Error('不可运行产品脚本')\n");
  doc(join(f.repo,".autoreview.json"),{setup:"exit 1",localFiles:["local.cfg"], deploy:{cmd:"scripts/deploy.sh"}});
  chmodSync(write(join(f.repo,"scripts/deploy.sh"),"#!/bin/sh\nexit 1\n"),0o755); write(join(f.repo,"local.cfg"),"secret-not-report");
  write(join(f.repo,".pi/skills/verify/SKILL.md"),"启动、就绪、隔离重置、停止与清理");
  write(join(f.repo,"docs/种子数据/data.json"),"{}\n"); write(join(f.repo,"AGENTS.md"),"规则\n");
  mkdirSync(join(f.repo,"issues"));
  const p=f.run("体检",["--card",b.card,"--changed","src/removed/old.ts","--changed","src/main.ts"]);
  assert.deepEqual(new Set(p.health.checklist.map(c=>c.group)),new Set(["跑得起来","判断依据","动手工具","管理沉淀"]));
  assert.equal(mustFind(p.health.checklist,c=>c.id==="review").status,"暂缓");
  for (const id of ["verifySkill","seeds","setup","deploy","test","acceptance","issues","batches"]) assert.equal(mustFind(p.health.checklist,c=>c.id===id).status,"齐备",id);
  for (const code of ["unmapped","missing-verification","deleted-feature","orphan-scenario","missing-script","script-mismatch","missing-reverse","possibly-unselected"]) assert(p.health.advice.some(a=>a.code===code),code);
  assert(!p.health.advice.some(a=>a.code==="missing-verification" && a.message.startsWith("F1")));
  assert(!p.health.advice.some(a=>a.code==="deleted-feature" && a.scenario==="S3"));
  assert(!JSON.stringify(p).includes("secret-not-report"));
  const legacy = doc(join(f.other,"loop-cards","old.json"),{tasks:[{test:"无：没有自动测试"}]});
  const report=coordinate(["体检","--project",f.other,"--tasks-root",f.tasks,"--card",legacy],now);
  assert(typeof report !== "string"); assert.equal(mustFind(report.health.checklist,c=>c.id==="batches").status,"齐备");
  assert.equal(mustFind(report.health.checklist,c=>c.id==="scripts").status,"缺少");
});

test("月报口径含分母、未知、审核出处和剪枝；当月重复开工只保存一次",t=>{
  const f=fixture(t), a=f.batch("first"), b=f.batch("second"), legacy=f.batch("legacy");
  const stop={at:at(now-days(8)),reason:"模型出错",step:"开发中",resolvedBy:"续跑"};
  const r1=f.execution(a,"a",now-days(8),{loop:{facts:{stops:[stop],resumes:1}}}); r1.reviewed(1,true); r1.check("复测","通过"); r1.reviewed(2);
  r1.check("合入","已合入",{detail:JSON.stringify({devAfter:merged})});
  const r2=f.execution(b,"b",now-days(7)); r2.pass();
  f.execution(legacy,"old",now-days(6),{loop:{facts:undefined,durations:{}}});
  write(join(f.repo,"issues/【history】/【bug】漏网.md"),`# 【bug】漏网\n状态：已解决\n引入批次：a，${commit}\n`);
  write(join(f.repo,"docs/分析-评审误报回查.md"),`| [a](<${r1.index}:1>) | [R1／1](<dummy>) | 原因 | 报过头 |\n`);
  write(join(f.repo,"docs/功能清单.md"),"### F1 删\n状态：已删除\n");
  write(join(f.repo,"docs/功能地图.md"),"### S1 不再有效\n所属功能：F1\n脚本：e2e/S1.mjs\n");
  const p=f.run("开工"), m=p.month?.snapshot;
  assert(m); assert.equal(m.intervention.value,1); assert.equal(m.intervention.unknown,1); assert.equal(m.flowFailures.byReason.模型出错,1);
  assert.equal(m.firstMustFix.value,0.5); assert.equal(m.repairRounds.value,1.5); assert.equal(m.escapes.count,1);
  assert.equal(m.escapes.evidence[0].enteredDev.kind,"合入流水");
  assert.equal(m.durationMs.total.value,2000); assert.equal(m.durationMs.total.unknown,1); assert.equal(m.falsePositives.denominator,1);
  assert.equal(m.falsePositives.value,1); assert(m.pruning.some(c=>c.kind==="地图剪枝"));
  f.apply("开工",p); assert.equal(f.run("开工",[],now+days(1)).changes.filter(c=>c.kind==="月报").length,0);
  const q=f.run("月报",[],now+days(1)); assert.equal(q.month?.snapshot?.generatedOn, day(now+days(1)));
  f.apply("月报",q,[],now+days(1)); assert.equal(readdirSync(join(f.repo,".dev-loop-coord/monthly")).length,2);
});

test("漏网同时核对引入祖先和进入 dev；接力合入计入，放弃分支不计",t=>{
  const f=fixture(t), b=f.batch("PA可信状态-20261109");
  f.git("init","--template=","-b","dev"); f.git("config","user.name","协调测试"); f.git("config","user.email","coord@example.invalid");
  const file = join(f.repo,"sample.txt");
  const save = (data:string)=>{ write(file,data); f.git("add","sample.txt"); f.git("commit","-m",data.trim()); return f.git("rev-parse","HEAD"); };
  const base=save("base\n"); f.git("switch","-c","first-run");
  const early=save("introduced\n"), final=save("still present in delivery\n");
  f.git("switch","-c","abandoned",base);
  const discardedEarly=save("introduced but abandoned\n"), separate=save("not delivered\n");
  f.git("switch","-c","successor",final);
  const later=save("successor delivery\n");
  const laterBatch=f.batch("接力最后一批");
  const laterRun=f.execution(laterBatch,"successor-run",now-days(2),{task:{baseCommit:final},loop:{commit:later,delivery:{commit:later}}});
  laterRun.check("复测","通过",{commit:later}); laterRun.check("评审","通过",{commit:later});
  const abandoned=f.execution(f.batch("放弃的卡"),"abandoned-run",now-days(1),{state:"cancelled",task:{baseCommit:base},loop:{commit:separate,delivery:{commit:separate}}});
  abandoned.check("复测","失败",{commit:discardedEarly});
  abandoned.check("复测","通过",{commit:separate}); abandoned.check("评审","通过",{commit:separate});
  const r=f.execution(b,"personal-agent-PA--20261109-1a393814-b28159",now-days(3),
    {task:{baseCommit:base},loop:{commit:final,delivery:{commit:final}}});
  r.check("复测","失败",{commit:early}); r.check("复测","失败",{commit:separate});
  r.check("复测","通过",{commit:final}); r.check("评审","通过",{commit:final});
  const bug = (name:string,entry:string)=>write(join(f.repo,"issues",`【bug】${name}.md`),`# 【bug】${name}\n状态：待修复\n引入批次：${entry}\n`);
  const known=bug("首轮引入",`${r.id} + \`${early.slice(0,7)}\``);
  bug("未继承",`${r.id}，${separate}`); bug("缺提交",r.id); bug("仅放弃分支",`${abandoned.id}，${discardedEarly.slice(0,7)}`);
  // rev-parse 必须用本地 dev，而不是当前 HEAD（此时 HEAD 在接力分支）。
  assert.equal(f.run("月报").month?.snapshot?.escapes.count,0);
  f.git("switch","dev"); f.git("merge","--no-ff","-m","Merge successor",later);
  const devTip=f.git("rev-parse","dev");
  laterRun.check("合入","已合入",{commit:later,detail:JSON.stringify({devAfter:devTip})});
  const escapes=f.run("月报").month?.snapshot?.escapes;
  assert.equal(escapes?.count,1); assert.equal(escapes?.unknownAttribution,3);
  assert.deepEqual(escapes?.evidence.map(e=>[e.source.file,e.execution,e.introducedCommit,e.deliveryCommit]),[[known,r.id,early,final]]);
  const evidence=escapes?.evidence[0];
  assert(evidence?.sources.some(s=>s.file===r.index && s.line===1));
  assert.deepEqual(evidence?.enteredDev,{kind:"dev 历史",commit:devTip,source:{file:f.repo,field:"refs/heads/dev"}});
});

test("预览后用户改过就不覆盖；SIGKILL 接棒与双进程重试后原件、证据只记一份",async t=>{
  const f=fixture(t), b=f.batch("上批"), clock=Date.now(); f.execution(b,"previous",clock-days(8)).pass();
  const source=f.issue("修好",b.name), original=read(source);
  const preview=f.run("查询",[],clock);
  appendFileSync(source,"用户同时补充原话\n");
  assert.throws(()=>f.apply("查询",preview,[],clock),/预览已变化/);
  assert.match(read(source),/用户同时补充原话/); assert(!existsSync(join(f.repo,".dev-loop-coord")));
  write(source,original);
  const p=f.run("查询",[],clock), id=p.planId, change=p.changes[0];
  // 用真实预览和进程崩溃测试接管后未发布的中间状态；隔天同时恢复也不重写归档日期。
  await interruptApply(f,"查询",id,source,clock);
  assert(!existsSync(source)); assert(f.run("查询",[],clock).incomplete.includes(id));
  const resume = `import {coordinate} from ${JSON.stringify(tool)}; console.log(JSON.stringify(coordinate(${JSON.stringify(f.args("查询",["--apply",id]))},${clock+days(1)})));`;
  const launch=()=>promisify(execFile)(process.execPath,["--input-type=module","-e",resume],{timeout:20000});
  const files=await Promise.all([launch(),launch()]);
  const outputs=files.map(file=>JSON.parse(file.stdout));
  assert(outputs.every(o=>o.applied.results.length===1 && o.applied.results[0].status==="applied"));
  assert.equal(read(outputs[0].applied.results[0].original),original);
  assert(existsSync(change.to) && !existsSync(source)); assert(!f.run("查询",[],clock).incomplete.includes(id));
});

for (const loss of ["撤回授权","旧版证明日志缺失"] as const) test(`关单已接管原件时 ${loss}：恢复不发布已解决`,async t=>{
  const f=fixture(t), b=f.batch("授权证明"), r=f.execution(b,"need-authorization",now-days(2)); r.pass();
  write(b.acceptance,"状态：待验\nA2. [授权] 场景 S3 原单重投\n");
  const issue=f.issue("待归档",b.name,"编号：PA046\n防复发检查：S3 / 原单重投","功能地图，S3"), original=read(issue);
  const {old,file}=recordProof(r), answers=join(r.dir,"answers.jsonl");
  jsonl(answers,[{at:at(now-days(1)),text:"同意授权：A2"}]);
  const p=f.run("查询"), change=mustFind(p.changes,c=>c.from===issue);
  await interruptApply(f,"查询",p.planId,issue,now);
  assert(!existsSync(issue)); assert(!existsSync(change.to));
  if (loss === "撤回授权") appendFileSync(answers,`\n${JSON.stringify({at:at(now-1),text:"不授权：A2"})}\n`);
  else rmSync(old);
  const recovered=f.apply("查询",p);
  assert("applied" in recovered && !recovered.applied.complete);
  const [result]=recovered.applied.results;
  assert.equal(result.status,"conflict"); assert.equal(read(issue),original); assert.equal(read(result.original!),original);
  assert(!existsSync(change.to)); assert(existsSync(file));
  assert(!mustFind(f.run("查询").issues,v=>v.file===issue).ready);
});

test("同日解决历史撞名后可重新预览再应用；旧尝试的冲突和原件仍在",async t=>{
  const f=fixture(t), b=f.batch("修复批"); f.execution(b,"fix-collision",now-days(2)).pass();
  const issue=f.issue("同名历史",b.name), original=read(issue), p=f.run("查询"), change=mustFind(p.changes,c=>c.from===issue);
  await interruptApply(f,"查询",p.planId,issue,now,change.to);
  const conflict=f.apply("查询",p); assert("applied" in conflict && !conflict.applied.complete && conflict.applied.plan);
  const receipt=join(dirname(conflict.applied.plan),"0.result.json"), initialReceipt=read(receipt);
  assert.equal(read(change.to),"同名历史原件\n"); assert.equal(read(issue),original);
  rmSync(change.to); // 用户已另存同名历史单，保留原计划回执。
  const fresh=f.run("查询"); assert.deepEqual(fresh.changes,p.changes); assert.notEqual(fresh.planId,p.planId);
  const retry=f.apply("查询",fresh); assert("applied" in retry && retry.applied.complete);
  assert.match(read(change.to),/状态：已解决/); assert(!existsSync(issue)); assert.equal(read(receipt),initialReceipt);
  assert.equal(read(conflict.applied.results[0].original!),original);
});

test("中断后同名历史文件或人工反馈出现时不覆盖任何一份",t=>{
  const f=fixture(t), b=f.batch("上批"), r=f.execution(b,"old",now-days(8)); r.pass(); r.check("部署","已部署");
  write(b.acceptance,"状态：待验\nA1. [人工] 看页面\n");
  const change:Change={kind:"结束提醒",from:b.acceptance,to:b.acceptance,content:"状态：未确认（无反馈）\n",before:hash(read(b.acceptance)),summary:"夹具",sources:[]};
  const plan:Plan={project:f.repo,command:"查询",changes:[change]};
  assert.throws(()=>locked(f.repo,()=>applyPlan(plan,plan,()=>{throw new Error("模拟中止");})),/模拟中止/);
  write(b.acceptance,"状态：不通过\n本人反馈：刚保存\n");
  const restored=f.run("查询",["--apply",planId(plan)]);
  assert("applied" in restored && restored.applied.results[0].status==="conflict");
  assert.equal(read(b.acceptance),"状态：不通过\n本人反馈：刚保存\n");
  assert("applied" in restored && read(restored.applied.results[0].original!).startsWith("状态：待验"));
  const issue = f.issue("同名中断",b.name), history = join(f.repo,"issues/【history】", "【bug】同名中断.md"), original = read(issue);
  const archive:Plan={project:f.repo,command:"查询",changes:[{kind:"关单",from:issue,to:history,before:hash(original),content:"已解决\n",summary:"撞名夹具",sources:[]}]};
  assert.throws(()=>locked(f.repo,()=>applyPlan(archive,archive,()=>{write(history,"手工归档不能覆盖\n");throw new Error("模拟中止");})),/模拟中止/);
  const collision = f.run("查询",["--apply",planId(archive)]);
  assert("applied" in collision && !collision.applied.complete);
  assert.equal(read(history),"手工归档不能覆盖\n"); assert.equal(read(issue),original);
  const foreign=write(join(f.other,"review.md"),"别的项目原话");
  symlinkSync(foreign,join(r.dir,"窗口原话.jsonl"));
  assert(!JSON.stringify(f.run("查询")).includes("别的项目原话"));
});
