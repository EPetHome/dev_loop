import { accessSync, constants, existsSync, lstatSync, realpathSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { checkoutWorker } from "../infra/checkout.ts";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inside, loadDeploy, loadSnapshot } from "../infra/config.ts";
import { childExec, detach } from "../infra/exec.ts";
import { digest, readJson, writeJson } from "../infra/files.ts";
import { gitText } from "../infra/git.ts";
import { compare } from "../infra/snapshot.ts";
import { recordStep, type Task } from "./store.ts";
import { run } from "./run.ts";
export async function snapshot(t: Task, cwd: string, commit: string, out: string, mode: "scenario" | "live", active?: {deadline: number; signal?: AbortSignal}): Promise<boolean> {
  const start = Date.now(), deadline = Math.min(active?.deadline ?? Infinity,start+300000); let tmp = "", scratch = "";
  const clean = () => { try { rmSync(out,{recursive:true,force:true}); return ""; } catch(e) { return "\n留痕输出清理失败："+String(e); } };
  const record = (detail?: string) => { recordStep(t.dir,{step:"留痕",result:detail?"失败":"已存",commit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:detail?[]:[out],detail}); return !detail; };
  try {
    const path=loadSnapshot(t.repo); if (!path || !existsSync(resolve(cwd,path))) return false;
    const bindings=loadDeploy(t.repo)?.env;
    if (active) {
      if (Date.now() >= deadline) throw new Error("复测时限已用完，未执行可选留痕");
      scratch = mkdtempSync(join(tmpdir(),".loop-snapshot-"));
      const copy = await run(t,process.execPath,[checkoutWorker,"--snapshot-copy",t.repo,scratch,commit,cwd],deadline-Date.now(),active.signal);
      if (copy.code || copy.killed) throw new Error("留痕副本准备"+(copy.killed?"超时或取消":"失败")+"\n"+copy.output);
      cwd = join(scratch,"src");
    }
    const script=resolve(cwd,path);
    if (!lstatSync(script).isFile() || !inside(realpathSync(cwd),realpathSync(script))) throw new Error("snapshot 非仓库内普通文件");
    accessSync(script,constants.X_OK); const cleanup=clean(); if(cleanup)throw new Error(cleanup);
    tmp=mkdtempSync(join(scratch || cwd,".loop-snapshot-"));
    const env={...bindings,LOOP_TASK_DIR:t.dir,LOOP_REPO:t.repo,LOOP_SNAPSHOT_MODE:mode,LOOP_SNAPSHOT_OUT:out,LOOP_SNAPSHOT_COMMIT:commit,TMPDIR:tmp};
    const r=active?await run({...t,worktree:cwd},script,[],deadline-Date.now(),active.signal,env):await childExec(script,[],{cwd,timeoutMs:300000,env});
    if (r.code || r.killed) throw new Error(r.output || "snapshot 失败或超时");
    const value=readJson<unknown>(out); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("snapshot 须输出 JSON 对象");
    return record();
  } catch(e) { return record(String(e)+clean()); } finally {
    // 大副本的删除也不能占用 Stop 中留给评审的时间。
    if (scratch) await detach(process.execPath,[checkoutWorker,"--snapshot-clean",t.repo,scratch],join(t.dir,"snapshot-cleanup.log"),scratch,process.env).catch(console.error);
    else if (tmp) { try { rmSync(tmp,{recursive:true,force:true}); } catch {} }
  }
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
