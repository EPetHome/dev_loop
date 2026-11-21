import { accessSync, constants, cpSync, existsSync, lstatSync, realpathSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { detachedCheckout } from "../infra/checkout.ts";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inside, loadDeploy, loadSnapshot } from "../infra/config.ts";
import { childExec } from "../infra/exec.ts";
import { digest, readJson, writeJson } from "../infra/files.ts";
import { gitText } from "../infra/git.ts";
import { compare } from "../infra/snapshot.ts";
import { recordStep, type Task } from "./store.ts";
import { run } from "./run.ts";
export async function snapshot(t: Task, cwd: string, commit: string, out: string, mode: "scenario" | "live", active?: {deadline: number; signal?: AbortSignal}): Promise<boolean> {
  const start = Date.now(); let tmp = "", remove: (()=>void) | undefined;
  const clean = () => { try { rmSync(out,{recursive:true,force:true}); return ""; } catch(e) { return "\n留痕输出清理失败："+String(e); } };
  const record = (result: string, evidence: string[], detail?: string) => recordStep(t.dir,{step:"留痕",result,commit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence,detail});
  try {
    const path=loadSnapshot(t.repo); if (!path || !existsSync(resolve(cwd,path))) return false;
    const bindings=loadDeploy(t.repo)?.env;
    if (active) {
      if (Date.now() >= active.deadline) throw new Error("复测时限已用完，未执行可选留痕");
      const pin=detachedCheckout(t.repo,commit); remove=pin.remove;
      cpSync(cwd,pin.cwd,{recursive:true,filter:p=>p!==join(cwd,".git"),verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE}); cwd=pin.cwd;
    }
    const script=resolve(cwd,path);
    if (!lstatSync(script).isFile() || !inside(realpathSync(cwd),realpathSync(script))) throw new Error("snapshot 非仓库内普通文件");
    accessSync(script,constants.X_OK); const cleanup=clean(); if(cleanup)throw new Error(cleanup);
    tmp=mkdtempSync(join(active?tmpdir():cwd,".loop-snapshot-"));
    const env={...bindings,LOOP_TASK_DIR:t.dir,LOOP_REPO:t.repo,LOOP_SNAPSHOT_MODE:mode,LOOP_SNAPSHOT_OUT:out,LOOP_SNAPSHOT_COMMIT:commit,TMPDIR:tmp};
    const r=active?await run({...t,worktree:cwd},script,[],Math.min(300000,active.deadline-Date.now()),active.signal,env):await childExec(script,[],{cwd,timeoutMs:300000,env});
    if (r.code || r.killed) throw new Error(r.output || "snapshot 失败或超时");
    const value=readJson<unknown>(out); if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("snapshot 须输出 JSON 对象");
    record("已存",[out]); return true;
  } catch(e) { record("失败",[],String(e)+clean()); return false; } finally { if(tmp) { try { rmSync(tmp,{recursive:true,force:true}); } catch {} } remove?.(); }
}
export function differences(a: string, b: string): string {
  try { return compare(readJson(a),readJson(b)).join("\n") || "无差异"; } catch { return "没有基线"; }
}
export function staticSnapshot(t: Task, cwd: string, commit: string, out: string, previous?: string): void {
  const start=Date.now();
  try {
    const dependencies=Object.fromEntries(["package-lock.json","pnpm-lock.yaml","yarn.lock","bun.lockb"].filter(p=>existsSync(join(cwd,p))).map(p=>[p,digest(readFileSync(join(cwd,p)))]));
    writeJson(out,{commit,dependencies,files:previous?gitText(t.repo,["diff","--name-only",previous,commit,"--"]).split("\n").filter(Boolean):[]});
  } catch(e) { recordStep(t.dir,{step:"留痕",result:"失败",commit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:[],detail:String(e)}); }
}
