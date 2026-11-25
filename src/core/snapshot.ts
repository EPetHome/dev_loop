import { accessSync, constants, existsSync, lstatSync, realpathSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { inside, isObject } from "../infra/config.ts";
import { digest, readJson, writeJson, span } from "../infra/files.ts";
import { gitText } from "../infra/git.ts";
import { compare } from "../infra/snapshot.ts";
import { recordStep, type Task } from "./store.ts";
import { run } from "./run.ts";
export async function snapshot(t:Task,cwd:string,commit:string,out:string,mode:"scenario"|"live",active?:{deadline:number}) {
  const start=Date.now(),path=t.config.snapshot,deadline=Math.min(active?.deadline ?? Infinity,start+t.config.snapshotTimeoutMin*60000);
  if (!path || !existsSync(resolve(cwd,path))) return false;
  let detail:string|undefined;
  const collect=async (source:string)=>{
    const script=resolve(source,path);
    if (!lstatSync(script).isFile() || !inside(realpathSync(source),realpathSync(script))) throw new Error("snapshot 非仓库内普通文件");
    accessSync(script,constants.X_OK);rmSync(out,{recursive:true,force:true});const tmp=mkdtempSync(join(source,".loop-snapshot-"));
    try {
      const env={...t.config.deploy?.env,LOOP_REPO:t.repo,LOOP_SNAPSHOT_MODE:mode,LOOP_SNAPSHOT_OUT:out,LOOP_SNAPSHOT_COMMIT:commit,TMPDIR:tmp};
      const r=await run({...t,worktree:source},script,[],deadline-Date.now(),undefined,env);
      if (r.code || r.killed || !isObject(readJson(out))) throw new Error(r.output || "snapshot 失败、超时或没有输出 JSON 对象");
    } finally {rmSync(tmp,{recursive:true,force:true});}
  };
  try {if (mode==="scenario") await checkout(t.repo,commit,collect,console.error,cwd); else await collect(cwd);}
  catch(e) {detail=String(e); try {rmSync(out,{recursive:true,force:true});}catch(err){detail+="\n清理留痕失败："+err;}}
  recordStep(t.dir,{step:"留痕",result:detail?"失败":"已存",commit,...span(start),evidence:detail?[]:[out],detail}); return !detail;
}
export function differences(a:string,b:string) {try {return compare(readJson(a),readJson(b)).join("\n") || "无差异";}catch{return "没有基线";}}
export function staticSnapshot(t:Task,cwd:string,commit:string,out:string,previous?:string) {
  const start=Date.now();try {
    const dependencies=Object.fromEntries(["package-lock.json","pnpm-lock.yaml","yarn.lock","bun.lockb"].filter(p=>existsSync(join(cwd,p))).map(p=>[p,digest(readFileSync(join(cwd,p)))]));
    writeJson(out,{commit,dependencies,files:previous?gitText(t.repo,["diff","--name-only",previous,commit,"--"]).split("\n").filter(Boolean):[]});
  } catch(e) {recordStep(t.dir,{step:"留痕",result:"失败",commit,...span(start),evidence:[],detail:String(e)});}
}
