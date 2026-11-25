import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { alive, identity } from "../infra/exec.ts";
import { atomicWrite, jsonLines, maybe } from "../infra/files.ts";
import { APP_ROOT, shellQuote, wake } from "../infra/paths.ts";
import { Ledger, locked, type Entry } from "../core/store.ts";
import { state, projectedStop, pendingStarts } from "../core/state.ts";
import { inputs } from "../core/inputs.ts";
import { run } from "../core/run.ts";
import { overflow } from "../core/review-call.ts";
export const newContext=(r?:Entry)=>r?.ending==="length" || r?.ending==="error" && overflow.test(r.error || r.text || "");
export async function openWindow(l:Ledger,start:Entry) {
  const s=state(l,false), t=l.task, {window,settled}=s, file=(settled?.ref===window?.n && settled?.file) || window?.file;
  const rotate=settled?.ref===window?.n && (newContext(settled) || (settled?.context || 0)>=t.config.newSessionAtContext);
  const resume=file && !rotate && !start.file && maybe(()=>
    realpathSync(file).startsWith(join(t.dir,"sessions")+"/") && jsonLines<{type:string}>(file)[0]?.type==="session");
  const id=resume ? window?.value.id : randomUUID(), folder=join(t.dir,"sessions"), opening=join(t.dir,`opening-${start.n}.md`), loop=join(APP_ROOT,"bin/loop");
  const {prompt,acceptance}=inputs(t), last=l.rows.findLast(r=>r.type==="评审" && r.check?.result==="必修"); mkdirSync(folder,{recursive:true});
  atomicWrite(opening,[`受管开发卡 ${t.executionId}。做完运行 ${loop} 交付；疑问用 ${loop} 提问。不要自行验证放行或合入部署。卡完成后，本人在这个窗口单独说「合入」由 dev-loop 处理；开发方不要运行合入命令，也不要让本人去终端执行。`,prompt,acceptance,
    `最新收货：${s.delivery?.commit || "无"}`,last ? `上轮必修原文（${last.check?.evidence[1]}）：\n${last.value?.items?.join("\n")}` : "",
    ...(t.版式 ? [`截图按页面名交付：${t.版式.页面.join("、")}`] : [])].join("\n\n"));
  const args=["--cwd",t.worktree,"--name",t.executionId,"--model",t.config.developerModel,"--thinking",t.config.developerThinking,
    ...(resume ? ["--session",file!] : ["--session-id",id]),"--session-dir",folder];
  const script=join(t.dir,`open-${start.n}.sh`), env:NodeJS.ProcessEnv={
    ...process.env,LOOP_ROLE:"development",LOOP_TASK_DIR:t.dir,LOOP_WINDOW_JOB:String(start.n),LOOP_OPENING:opening,LOOP_EXPECT_SESSION:id
  };
  const keys=["PI_BIN","PI_NODE_BIN","PERMISSION_EXTENSION","LOOP_TASKS_ROOT","LOOP_CAFFEINATE_CMD","LOOP_WAKE",
    "LOOP_TASK_DIR","LOOP_ROLE","LOOP_WINDOW_JOB","LOOP_OPENING","LOOP_EXPECT_SESSION"] as const;
  atomicWrite(script,keys.filter(k=>env[k]!==undefined).map(k=>`export ${k}=${shellQuote(env[k]!)}`).join("\n")
    +"\nexec "+[process.execPath,join(APP_ROOT,"src/hosts/launch.ts"),...args].map(shellQuote).join(" ")+"\n");
  const timeout=t.config.windowStartupSec*1000, deadline=Date.now()+timeout;
  if (env.LOOP_LAUNCH_CMD) {
    const p=spawn(process.execPath,[join(APP_ROOT,"src/hosts/launch.ts"),...args],{cwd:t.worktree,env,detached:true,stdio:"ignore"});
    p.on("error",console.error);
    p.unref();
  }
  else {
    const r=await run(t,"osascript",["-e",'tell application "Terminal"\n do script '+JSON.stringify("sh "+shellQuote(script))+'\n activate\nend tell'],timeout);
    if(r.code)throw new Error("Terminal 启动失败："+r.output);
  }
  while (Date.now()<deadline) {
    const next=new Ledger(t.dir);
    if (next.rows.some(r=>r.type==="窗口" && r.status==="开" && r.ref===start.n)) return {result:"成功"};
    if (projectedStop(next) || next.rows.some(r=>r.type==="窗口退出" && r.source===start.n)) throw new Error(next.last("窗口退出")?.text || "窗口在登记前退出");
    await delay(Math.min(100,t.config.inboxIntervalMs));
  }
  throw new Error("未确认 pi 窗口登记，请查 "+join(t.dir,`window-${start.n}.log`));
}
async function terminal(args:string[]) {
  const dir=process.env.LOOP_TASK_DIR!, ref=Number(process.env.LOOP_WINDOW_JOB);
  const child=locked(dir,l=>{
    if (projectedStop(l) || !pendingStarts(l).some(r=>r.n===ref && r.step==="开窗口" && alive(r.owner))) return;
    const cmd=process.env.LOOP_LAUNCH_CMD || join(APP_ROOT,"bin/pi-dev"), p=spawn(cmd,args,{
      cwd:l.task.worktree,stdio:"inherit",env:{...process.env,LOOP_PI_WINDOW_OWNER:String(process.pid)}
    });
    if (p.pid) l.add({type:"子进程",ref,owner:identity(p.pid),status:"窗口"}); return p;
  });
  if (!child) return; let text="pi 窗口退出"; try { text+= "："+(await once(child,"exit")).join(" "); } catch (e) { text+= "："+e; }
  if (existsSync(join(dir,"ledger.jsonl"))) { locked(dir,l=>l.add({type:"窗口退出",source:ref,text})); wake(dir); }
}
if (process.argv[1] && resolve(process.argv[1])===join(APP_ROOT,"src/hosts/launch.ts"))
  terminal(process.argv.slice(2)).catch(e=>{console.error(e);process.exitCode=1;});
