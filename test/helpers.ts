import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, chmodSync, rmSync, realpathSync, existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { after } from "node:test";
import { fixtureMarker } from "./fixture-process.mjs";
import { assertNoFixtureProcesses, stopFixtureProcesses } from "./fixture-cleanup.ts";
import { Ledger, ledgerFile } from "../src/core/store.ts";
import { report } from "../src/core/view.ts";
import { binding, evidence } from "../src/core/inputs.ts";
import { state } from "../src/core/state.ts";
import { tick } from "../src/cli/tick.ts";
process.env.LOOP_CAFFEINATE_CMD="/usr/bin/true";
if (process.platform==="darwin" && execFileSync("/bin/sh",["-c","command -v git"],{encoding:"utf8"}).trim()==="/usr/bin/git") process.env.PATH=dirname(execFileSync("/usr/bin/xcrun",["--find","git"],{encoding:"utf8"}).trim())+":"+process.env.PATH;
export const ROOT=resolve(import.meta.dirname,".."), NODE=process.execPath;
if (process.platform==="darwin") {
  const preload="--import="+new URL("./fixture-process.mjs",import.meta.url).href;
  process.env.DEV_LOOP_FIXTURE_TMP=realpathSync(tmpdir()); if (!process.env.NODE_OPTIONS?.includes(preload)) process.env.NODE_OPTIONS=[process.env.NODE_OPTIONS,preload].filter(Boolean).join(" ");
}
export const PASS="## 结论：通过\n## 必修\n无\n## 小问题\n- 建议示例\n## 需求疑问\n- 疑问示例\n## 上轮必修复查\n无\n";
export const MUST="## 结论：需返修\n## 必修\n1. 位置：src/app.txt:1\n   触发：输入 bad 时\n   问题：返回错误结果\n   依据：需求 A1\n   建议：修正结果\n## 小问题\n- 不要退回此建议\n## 需求疑问\n- 不要退回此疑问\n## 上轮必修复查\n无\n";
export const getJson=<T=any>(p:string):T=>JSON.parse(readFileSync(p,"utf8"));
export const write=(p:string,s:string|Buffer)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,s);return p;};
export const sq=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function writeFixtureScript(file:string,interpreter:"sh"|"node",body:string,{direct=false}={}) {
  const sh=interpreter==="sh"; write(file,"#!"+(sh?"/bin/sh":NODE)+"\n"+(direct?"":(sh?"# ":"// ")+fixtureMarker+"\n")+body);chmodSync(file,0o755); return file;
}
const fixtureBases = new Set<string>();
let compileCache: string | undefined;
const fixtureTmp = (tasks: string) => join(dirname(tasks), "tmp");
const execAsync = promisify(execFile);
const stallMs = 12000, pumpLimitMs = 60000;
after(() => {
  try { assertNoFixtureProcesses(...fixtureBases); }
  finally { if (compileCache) rmSync(compileCache, {recursive: true, force: true}); }
});
export function fixture(t:{after(f:()=>any):any}, options:{test?:string;reviewer?:string;config?:any;card?:any;cliTimeoutMs?:number;tasksName?:string;pollMs?:number}={}) {
  // 同一测试文件反复开 CLI；只给这些子进程复用 Node 的临时编译缓存。
  if (!process.env.NODE_COMPILE_CACHE && process.env.NODE_DISABLE_COMPILE_CACHE !== "1") {
    compileCache ??= mkdtempSync(join(tmpdir(), "dev-loop-compile-"));
    process.env.NODE_COMPILE_CACHE = compileCache;
  }
  const base=realpathSync(mkdtempSync(join(tmpdir(),"dev-loop-test-"))), repo=join(base,"repo with 空格"), root=join(base,options.tasksName || "tasks");
  fixtureBases.add(base);
  t.after(async () => {
    try { await stopFixtureProcesses(base); }
    finally { rmSync(base, {recursive: true, force: true, maxRetries: 2}); }
  });
  mkdirSync(repo);
  // 被测 worker 遭 SIGKILL 时，隔离检出仍归本用例清理；不在共享 TMPDIR 留下孤儿目录。
  mkdirSync(fixtureTmp(root));
  const git=(...args:string[])=>execFileSync("git",args,{cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim(); git("init","--template=","-b","dev");
  appendFileSync(join(repo,".git","config"),"\n[user]\n\tname = Loop Test\n\temail = loop-test@example.invalid\n");
  write(join(repo,"src/app.txt"),"good\n");write(join(repo,"outside.txt"),"protected\n");write(join(repo,"prompt.md"),"实现 good；不要改 scope 外文件。\n");write(join(repo,"criteria.md"),"A1. 操作：读取 app\n预期：good\n");
  write(join(repo,".gitignore"),"dist/\nlocal.txt\n");write(join(repo,"local.txt"),"local secret fixture\n");
  writeFixtureScript(join(repo,"reviewer.sh"),"sh",'printf "review\\n" >> "$LOOP_TASK_DIR/order"\n'+(options.reviewer || "printf '%s' "+sq(PASS))+"\n");
  const command=options.test ?? 'printf "test\\n" >> "$LOOP_TASK_DIR/order"; if grep -q bad src/app.txt; then echo "Error: failed app"; exit 1; fi';
  write(join(repo,".autoreview.json"),JSON.stringify({reviewerCmd:"reviewer.sh",localFiles:["local.txt"],retry:{delaysMin:[0,0,0]},inboxIntervalMs:15,windowStartupSec:8,...options.config}));
  const raw={version:1,name:"one",nature:"开发",base:"dev",target:"dev",host:"pi",flow:["开发评审","测试"],tasks:[{name:"task",prompt:"prompt.md",scope:["src/**"],test:command}],acceptance:"criteria.md",...options.card};
  const card=write(join(repo,"card.json"),JSON.stringify(raw));git("add",".");git("commit","-m","fixture");
  const launch=writeFixtureScript(join(base,"fake-launch.cjs"),"node",`import(${JSON.stringify(new URL("./fake-window.ts",import.meta.url).href)}).then(m=>m.fakeWindow()).catch(e=>{console.error(e);process.exitCode=1;});\n`);
  const model=writeFixtureScript(join(base,"fake-pi.cjs"),"node",`const fs=require('node:fs'),f=process.env.LOOP_TASK_DIR+'/model'; process.stdout.write(fs.existsSync(f)?fs.readFileSync(f,'utf8'):'等本人');\n`);
  const env:NodeJS.ProcessEnv={...process.env,LOOP_TASK_DIR:undefined,LOOP_ROLE:undefined,LOOP_JOB:undefined,LOOP_WAKE:"manual",LOOP_TASKS_ROOT:root,LOOP_LAUNCH_CMD:launch,PI_BIN:model,PATH:dirname(NODE)+":"+process.env.PATH,TMPDIR:fixtureTmp(root)};
  const invoke=(entry:string,args:string[],cwd=repo,extraEnv:NodeJS.ProcessEnv={})=>execAsync(NODE,[join(ROOT,entry),...args],{cwd,env:{...env,...extraEnv},timeout:options.cliTimeoutMs || 15000,maxBuffer:16*1024*1024});
  const cli=(args:string[],cwd=repo,extraEnv:NodeJS.ProcessEnv={})=>invoke("src/cli/main.ts",args,cwd,extraEnv);
  const call=async(args:string[],cwd=repo,extraEnv:NodeJS.ProcessEnv={})=>{const r=await cli([...args,"--json"],cwd,extraEnv);return JSON.parse(r.stdout || "null");};
  const proc=(args:string[],extraEnv:NodeJS.ProcessEnv={})=>spawn(NODE,[join(ROOT,"src/cli/main.ts"),...args],{cwd:repo,env:{...env,...extraEnv},stdio:"ignore"});
  const advance=()=>{
    const r=tick(undefined,root,Date.now(),env);
    if(r.errors.length)throw new Error(JSON.stringify(r.errors));
  };
  return {base,repo,root,card,raw,git,env,cli,call,proc,
    async prepare() {
      const {stdout}=await invoke("test/fixture-cli.ts",["prepare",card]);
      return new Ledger(JSON.parse(stdout).taskDir).task;
    },
    async pump(dir:string,pick:(l:Ledger)=>boolean,{pulse=advance, idleMs=stallMs}:
      {pulse?:()=>void|Promise<void>; idleMs?:number}={}) {
      // 多步恢复按“多久没进展”失败，而不是把排队、回退、重跑及释放压进一次短超时。
      const deadline=performance.now()+pumpLimitMs, path=ledgerFile(dir);
      let progress=0, lastChange=performance.now(), generation=0, wake: (()=>void)|undefined;
      const watcher=watch(path,()=>{generation++;wake?.();});
      try {
        for (;;) {
          const observed=generation, l=new Ledger(dir); if(pick(l))return l;
          const now=performance.now(), step=l.rows.findLast(r=>r.type!=="调度" || r.owner)?.n || 0;
          if (step!==progress) {progress=step;lastChange=now;}
          if (now>=deadline || now-lastChange>=idleMs) break;
          const {running,queued}=state(l,false);
          if (!running && !queued) await pulse();
          if (generation!==observed) continue;
          // 账本写入立即推进；没写账本就退出的进程及外部就绪文件由低频探测接住。
          await new Promise<void>(resolve=>{
            const timer=setTimeout(done,options.pollMs ?? 100);
            function done() {clearTimeout(timer);wake=undefined;resolve();}
            wake=done;
          });
        }
      } finally {watcher.close();}
      throw new Error("tick 未到预期："+readFileSync(path,"utf8").slice(-4300)+(existsSync(join(dir,"worker.log")) ? readFileSync(join(dir,"worker.log"),"utf8").slice(-2000) : ""));
    }
  };
}
export async function until<T>(dir:string,get:()=>T,ready:(v:T)=>boolean,file?:string,timeoutMs=5000):Promise<T> {
  const deadline=Date.now()+timeoutMs; while(Date.now()<deadline) {
    try {const v=get();if(ready(v))return v;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;} await delay(15);
  }
  throw new Error("等不到："+(file || dir));
}
const directEnv=(dir:string)=>({
  ...process.env,LOOP_ROLE:undefined,LOOP_TASK_DIR:dir,LOOP_TASKS_ROOT:dirname(dir),LOOP_WAKE:"manual",TMPDIR:fixtureTmp(dirname(dir))
});
export const deliver=(dir:string)=>JSON.parse(execFileSync(NODE,[join(ROOT,"src/cli/main.ts"),"交付","--json"],{
  env:directEnv(dir),encoding:"utf8",stdio:["ignore","pipe","pipe"]
})), statusOf=(dir:string)=>report(new Ledger(dir));
const checkedCommands=(dir:string,mode:string)=>execAsync(NODE,[join(ROOT,"test/fixture-cli.ts"),mode,dir],{env:directEnv(dir)});
export async function settle(dir:string) {await checkedCommands(dir,"settle");}
export async function deliverAndSettle(dir:string) {return JSON.parse((await checkedCommands(dir,"deliver-and-settle")).stdout);}
export function checked(dir:string,sha:string) {const l=new Ledger(dir),b=binding(l,sha);return evidence(l.rows,sha,b.key,b.tree).verified;}
