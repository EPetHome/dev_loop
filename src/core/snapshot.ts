import { accessSync, constants, existsSync, lstatSync, realpathSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inside, loadSnapshot } from "../infra/config.ts";
import { childExec } from "../infra/exec.ts";
import { digest, readJson, writeJson } from "../infra/files.ts";
import { gitText } from "../infra/git.ts";
import { compare } from "../infra/snapshot.ts";
import { recordStep, type Task } from "./store.ts";
import { run } from "./run.ts";
export async function snapshot(t: Task, cwd: string, commit: string, out: string, mode: "scenario" | "live", active = false, signal?: AbortSignal): Promise<boolean> {
  const start = Date.now(); let tmp = "";
  const clean = () => { try { rmSync(out,{recursive:true,force:true}); return ""; } catch(e) { return "\n留痕输出清理失败："+String(e); } };
  try {
    const path=loadSnapshot(t.repo); if (!path || !existsSync(resolve(cwd,path))) return false;
    const script=resolve(cwd,path);
    if (!lstatSync(script).isFile() || !inside(realpathSync(cwd),realpathSync(script))) throw new Error("snapshot 非仓库内普通文件");
    accessSync(script,constants.X_OK); const cleanup=clean(); if(cleanup)throw new Error(cleanup);
    tmp=mkdtempSync(join(active?tmpdir():cwd,".loop-snapshot-"));
    const env={LOOP_TASK_DIR:t.dir,LOOP_REPO:t.repo,LOOP_SNAPSHOT_MODE:mode,LOOP_SNAPSHOT_OUT:out,LOOP_SNAPSHOT_COMMIT:commit,TMPDIR:tmp};
    const r=active?await run(t,script,[],300000,signal,env):await childExec(script,[],{cwd,timeoutMs:300000,env});
    if (r.code || r.killed) throw new Error(r.output || "snapshot 失败或超时");
    const value=readJson<any>(out); if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("snapshot 须输出 JSON 对象");
    recordStep(t.dir,{step:"留痕",result:"已存",commit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:[out]}); return true;
  } catch(e) {
    const detail=String(e)+clean(); recordStep(t.dir,{step:"留痕",result:"失败",commit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:[],detail}); return false;
  } finally { if(tmp) { try { rmSync(tmp,{recursive:true,force:true}); } catch {} } }
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
