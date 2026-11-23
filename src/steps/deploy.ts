import { mkdirSync, existsSync, accessSync, constants, lstatSync, realpathSync, rmSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { projectFile } from "../infra/project.ts";
import { writeJson, optionalJson, errorText, readText, span } from "../infra/files.ts";
import { taskOf, annotate, recordStep, LoopError } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { snapshot, staticSnapshot } from "../core/snapshot.ts";
import { loadDeploy, inside } from "../infra/config.ts";
import { gitTry, isAncestor } from "../infra/git.ts";
import { childExec } from "../infra/exec.ts";
type Deployment = {executionId:string; commit:string; evidenceDir:string; rollback?:string};
const deploymentFile = (dir: string, repo: string) => projectFile(dirname(dir),repo,"deployed");
const deployEnv = (repo: string, {commit,evidenceDir}: Pick<Deployment,"commit"|"evidenceDir">) =>
  ({LOOP_REPO:repo,LOOP_DEPLOY_COMMIT:commit,LOOP_EVIDENCE_DIR:evidenceDir});
function executable(cwd: string, path: string) {
  const file = resolve(cwd,path);
  try { if (!lstatSync(file).isFile() || !inside(realpathSync(cwd),realpathSync(file))) throw new Error(); accessSync(file,constants.X_OK); return file; }
  catch { throw new InputError("脚本不存在或不可执行："+path); }
}
export type DeployResult = Awaited<ReturnType<typeof deploy>>;
export async function deploy(dir: string, o: {commit?: string; timeoutMs?: number; automatic?: boolean} = {}) {
  const t = taskOf(dir), start = Date.now(), marker = deploymentFile(dir,t.repo); let cfg: ReturnType<typeof loadDeploy>;
  try { cfg = loadDeploy(t.repo); } catch (e) { throw new InputError(errorText(e)); }
  if (!cfg) throw new InputError("项目没有登记部署脚本（.autoreview.json 的 deploy.cmd）");
  if (o.automatic && (!cfg.check || !cfg.rollback)) throw new InputError("自动部署须登记 deploy.cmd、check、rollback");
  const parsed = gitTry(t.repo, ["rev-parse", "--verify", "--end-of-options", (o.commit || "refs/heads/dev") + "^{commit}"]);
  if (parsed.code) throw new InputError("无法确定部署 commit：" + parsed.stderr);
  const commit = parsed.stdout.trim(), short = commit.slice(0, 7), onDev = isAncestor(t.repo, commit, "refs/heads/dev");
  let log = "", evidenceDir = "";
  const {failed,rollbackOK,steps} = await checkout(t.repo,commit,async cwd => {
    for (const path of [cfg.cmd,cfg.check,cfg.rollback]) if (path !== undefined) executable(cwd,path);
    const now = new Date(), pad = (n: number) => String(n).padStart(2,"0"), stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const base = join(dir, "deploy-" + short + "-" + stamp); let stem = base;
    for (let n = 1; existsSync(stem) || existsSync(stem + ".log"); n++) stem = base + "-" + n;
    evidenceDir = stem; log = stem + ".log"; mkdirSync(evidenceDir);
    annotate(dir, "部署中", short);
    const env = {...cfg.env,...deployEnv(t.repo,{commit,evidenceDir})}, steps: {name:string;path:string;code:number;seconds:number;killed:boolean}[] = [];
    const run = async (name: string, path: string, failed?: string) => {
      const began = Date.now(); appendFileSync(log,`$ ${path}\n`);
      const {code,killed,output} = await childExec(resolve(cwd,path),[],{cwd,timeoutMs:o.timeoutMs ?? cfg.timeoutMin*60000,env:{...env,LOOP_DEPLOY_FAILED:failed}});
      const seconds = (Date.now()-began)/1000; steps.push({name,path,code,seconds,killed});
      appendFileSync(log,`${output}\n退出码 ${code}，用时 ${seconds} 秒${killed ? "，超时" : ""}\n`);
      return !code && !killed;
    };
    let previous: Deployment | undefined; try { previous=optionalJson(marker); } catch {}
    staticSnapshot(t,cwd,commit,join(evidenceDir,"snapshot-static.json"),previous?.commit);
    await snapshot(t,cwd,commit,join(evidenceDir,"snapshot-before.json"),"live");
    const failed = !await run("cmd",cfg.cmd) ? "cmd" : cfg.check && !await run("check",cfg.check) ? "check" : "";
    const rollbackOK = !!failed && !!cfg.rollback && await run("rollback",cfg.rollback,failed);
    if (!failed && cfg.check) await snapshot(t,cwd,commit,join(evidenceDir,"snapshot-after.json"),"live");
    return {failed,rollbackOK,steps};
  }, text => { if (log) appendFileSync(log,text+"\n"); });
  const message = failed ? cfg.rollback ? rollbackOK ? "已回退" : "回退也失败" : "未回退" : short + (cfg.check ? "" : "，未检查");
  const result = failed ? "部署失败，"+message : cfg.check ? "已部署" : "已部署（未检查）", timing = span(start);
  const r = {executionId:t.executionId,commit,onDev,result,steps,log,evidenceDir,seconds:timing.durationMs/1000};
  const detail = readText(log).trimEnd().split(/\r?\n/).slice(-40).join("\n");
  recordStep(dir,{step:"部署",result,commit,...timing,evidence:[log,evidenceDir],detail},{phase:failed ? "部署失败" : "已部署",message});
  if (failed) throw new LoopError("未知",detail,r);
  writeJson(marker,{executionId:t.executionId,commit,evidenceDir,rollback:cfg.rollback});
  return r;
}
export async function rollback(dir: string, failed: "manual" | "merge" = "manual") {
  const t = taskOf(dir), file = deploymentFile(dir,t.repo), last = optionalJson<Deployment>(file), start = Date.now();
  if (!last || last.executionId !== t.executionId) throw new InputError("只能退回此项目最新的一次部署");
  if (!last.rollback) throw new InputError("这次部署没有登记 rollback，无法退回");
  const cfg = loadDeploy(t.repo), log = join(last.evidenceDir,failed+"-rollback.log");
  const r = await checkout(t.repo,last.commit,cwd => childExec(executable(cwd,last.rollback!),[],{cwd,timeoutMs:(cfg?.timeoutMin || 20)*60000,
    env:{...cfg?.env,...deployEnv(t.repo,last),LOOP_DEPLOY_FAILED:failed}}));
  appendFileSync(log,r.output); const ok = !r.killed && r.code === 0, result = ok?"已退回":"退回失败";
  recordStep(dir,{step:"退回",result,commit:last.commit,...span(start),evidence:[last.evidenceDir,log],detail:r.output},ok?{phase:"已退回",message:"线上已退回；dev 未改动"}:undefined);
  if (!ok) throw new LoopError("未知",r.output || "退回失败"); rmSync(file);
  return {executionId:t.executionId,commit:last.commit,evidenceDir:last.evidenceDir,result};
}
