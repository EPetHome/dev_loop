import { chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fixture, write, until, NODE, ROOT } from "./helpers.ts";
import { registerSession } from "../src/core/lifecycle.ts";
import { deliver } from "../src/core/deliver.ts";
export const flow = ["开发评审", "测试", "合入", "部署", "推送"];
// 收尾可能串行启动多个替身并清理 Git 检出。给整个测试链留余量，仍以实际状态/回执继续，不等满上限。
const finishDeadlineMs = 60000;
export const untilFinish = <T>(dir: string, get: () => T, ready: (value: T) => boolean, file?: string) => until(dir,get,ready,file,finishDeadlineMs);
export async function finishingFixture(t: Parameters<typeof fixture>[0], o: {flow?: string[]; cmd?: string; check?: string; rollback?: string} = {}) {
  const f = fixture(t,{card:{flow:o.flow || flow.slice(0,4)},config:{deploy:{cmd:"deploy.cjs",check:"check.cjs",rollback:"rollback.cjs"}},cliTimeoutMs:finishDeadlineMs});
  f.raw.tasks[0].scope = ["src/**","check.cjs"]; write(f.card,JSON.stringify(f.raw));
  for (const name of ["deploy","check","rollback"] as const) {
    const body = name === "deploy" ? o.cmd : o[name];
    write(join(f.repo,name+".cjs"), "#!"+NODE+"\nconst fs=require('fs'),path=require('path'),cp=require('child_process'),e=process.env,evidence=e.LOOP_EVIDENCE_DIR,dir=path.dirname(evidence);\nfs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({name:"+JSON.stringify(name)+",commit:e.LOOP_DEPLOY_COMMIT,dev:cp.execFileSync('git',['rev-parse','dev'],{cwd:e.LOOP_REPO,encoding:'utf8'}).trim(),status:JSON.parse(fs.readFileSync(dir+'/status.json')),evidence})+'\\n');\n"+(body || "")+"\n");
    chmodSync(join(f.repo,name+".cjs"),0o755);
  }
  f.git("add","."); f.git("commit","-m","deploy substitutes");
  const task = await f.prepare(), before = f.git("rev-parse","dev"); registerSession(task.dir,"pi","fake",process.pid);
  write(join(task.worktree,"src/app.txt"),"good finish\n"); const {commit} = deliver(task.dir);
  return {...f,task,before,commit};
}
export const received = (dir: string) => readFileSync(join(dir,"calls.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
// 闸住真实 CLI 的 Git 删除；不用 sleep，也不影响其他 worktree。
export async function gateRemoval(t: Parameters<typeof fixture>[0], f: Pick<Awaited<ReturnType<typeof finishingFixture>>, "task" | "base" | "repo" | "env">, mode: "收尾" | "释放", fault: "before" | "after" | "append") {
  const {dir,worktree} = f.task, gate = join(f.base,"release-gate"), marker = join(dir,"removing"), preload = join(f.base,"gate-release.mjs");
  execFileSync("mkfifo",[gate]);
  write(preload, `
import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const {GATE, MARKER, WORKTREE, FAULT} = process.env, run = cp.spawnSync, append = fs.appendFileSync;
cp.spawnSync = (cmd,args,...rest) => {
  if (cmd !== 'git' || args.at(-2) !== 'remove' || args.at(-1) !== WORKTREE) return run(cmd,args,...rest);
  fs.writeFileSync(MARKER,''); fs.readFileSync(GATE);
  if (FAULT === 'before') process.exit(71);
  const result = run(cmd,args,...rest);
  if (FAULT === 'after') process.exit(result.status === 0 ? 71 : 72);
  return result;
};
fs.appendFileSync = (path,value,...rest) => {
  if (FAULT === 'append' && String(path).endsWith('/checks.jsonl') && String(value).includes('"step":"释放"')) throw Object.assign(new Error('simulated checks.jsonl append EACCES'),{code:'EACCES'});
  return append(path,value,...rest);
};
syncBuiltinESMExports();
`);
  const child = spawn(NODE,["--import",preload,join(ROOT,"src/cli/main.ts"),mode,f.task.executionId,"--json"],{
    cwd:f.repo,env:{...f.env,GATE:gate,MARKER:marker,WORKTREE:worktree,FAULT:fault},stdio:["ignore","ignore","pipe"],
  });
  let stderr = ""; child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk=>{stderr += chunk;});
  const exited = new Promise<{code:number|null;stderr:string}>((ok,no)=>{child.once("error",no);child.once("close",code=>ok({code,stderr}));});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");});
  await untilFinish(dir,()=>existsSync(marker),Boolean,marker);
  return { proceed:()=>write(gate,"remove\n"), exited };
}
