import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitText, gitTry } from "../infra/git.ts";
import { inside, loadSnapshot } from "../infra/config.ts";
import { lock, BusyError } from "../infra/files.ts";
import { childExec } from "../infra/exec.ts";
import { taskOf, recordStep } from "../core/store.ts";
import { snapshot, staticSnapshot } from "../core/snapshot.ts";
export async function companion(dir: string) {
  const t=taskOf(dir), start=Date.now(), cwd=join(dir,"companion"); let release: (()=>void) | undefined, created=false;
  const record=(result: string, detail="")=>recordStep(dir,{step:"陪跑",result,commit:t.baseCommit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:result==="基线已存"?[join(dir,"snapshot-base.json")]:[],detail});
  try {
    try { release=lock(join(dir,"companion.lock")); } catch(e) { if(e instanceof BusyError)return; throw e; }
    const script=loadSnapshot(t.repo); if (!script) { record("跳过","未登记 snapshot"); return; }
    gitText(t.repo,["worktree","add","--detach",cwd,t.baseCommit]); created=true;
    for(const path of t.config.localFiles) {
      const dest=resolve(cwd,path); mkdirSync(dirname(dest),{recursive:true});
      if(!inside(realpathSync(cwd),realpathSync(dirname(dest))))throw new Error("localFiles 目标越出陪跑工作区");
      cpSync(resolve(t.repo,path),dest,{recursive:true,dereference:false,force:true});
    }
    if(!existsSync(resolve(cwd,script))) { record("跳过","起点没有 snapshot 脚本"); return; }
    if(t.config.setup) {
      const r=await childExec("sh",["-c",t.config.setup],{cwd,timeoutMs:t.limits.测试.timeoutMin*60000,env:{LOOP_TASK_DIR:dir,TMPDIR:cwd}});
      if(r.code || r.killed)throw new Error(r.output || "setup 失败");
    }
    staticSnapshot(t,cwd,t.baseCommit,join(dir,"snapshot-base-static.json"));
    const ok=await snapshot(t,cwd,t.baseCommit,join(dir,"snapshot-base.json"),"scenario"); record(ok?"基线已存":"失败");
  } catch(e) { record("失败",String(e)); }
  finally {
    if(created) { const r=gitTry(t.repo,["worktree","remove","--force",cwd]); if(r.code)record("失败",r.stdout+r.stderr); }
    release?.();
  }
}
