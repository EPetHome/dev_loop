import { isAbsolute, relative, resolve } from "node:path";
import { errorText, optionalJson, readJson } from "./files.ts";
import { APP_ROOT } from "./paths.ts";
export type Limits = Record<"测试" | "开发评审" | "部署", {maxRepairs:number; timeoutMin:number}>;
export const defaults = () => readJson<Config>(resolve(APP_ROOT,"config/defaults.json"));
const projectConfig = (repo: string) => optionalJson<any>(resolve(repo,".autoreview.json"));
export const isObject = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
export interface DeployConfig { cmd: string; check?: string; rollback?: string; timeoutMin: number; env: Record<string,string> }
export function loadDeploy(repo: string): DeployConfig | undefined {
  try {
    const cfg = projectConfig(repo)?.deploy; if (cfg === undefined) return;
    if (!isObject(cfg)) throw new Error("须为对象");
    for (const key of ["cmd","check","rollback"]) if ((key === "cmd" || cfg[key] !== undefined) && !safeRelative(cfg[key]))
      throw new Error(key + " 须为仓库内可执行文件的相对路径");
    const timeoutMin = cfg.timeoutMin ?? defaults().limits.部署.timeoutMin;
    if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > 240) throw new Error("timeoutMin 须为 1–240 的整数");
    const env = cfg.env === undefined ? {} : cfg.env;
    if (!isObject(env) || Object.entries(env).some(([k,v])=> !/^[A-Z][A-Z0-9_]*$/.test(k) || k.startsWith("LOOP_") || typeof v !== "string")) throw new Error("env 键须为大写环境变量且不能以 LOOP_ 开头，值须为字符串");
    return {env,cmd:cfg.cmd,check:cfg.check,rollback:cfg.rollback,timeoutMin};
  } catch (e) { throw new Error(".autoreview.json 的 deploy 不合法：" + errorText(e)); }
}
export interface Config {
  developerModel:string; developerThinking:string; reviewerModel:string; reviewerThinking:string; triageModel:string; triageThinking:string;
  retry:{times:number; delaysMin:number[]}; cardRetryBudget:number; maxParallelCards:number; newSessionAtContext:number; tickIntervalSec:number;
  notifyAutoSummary:boolean; limits:Limits; reviewerCmd:string; localFiles:string[]; setup:string; proofTestDirs?:string[];
  windowStartupSec:number; inboxIntervalMs:number; snapshotTimeoutMin:number; pushTimeoutSec:number; pushVerifyTimeoutSec:number;
  deploy?:DeployConfig; snapshot?:string;
}
export const safeRelative = (path: unknown): path is string => typeof path === "string" && !!path && !isAbsolute(path) &&
  !path.split(/[\\/]/).some(p => p === ".." || p === ".git") && !/[\0\r\n]/.test(path);
export const pathPatterns = (v: unknown): v is string[] => Array.isArray(v) && v.every(p => safeRelative(p) && p !== ".");
export const inside = (root: string, file: string) => { const r = relative(root, file); return r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
export function loadConfig(repo: string, proofs = false, limits?: Partial<Limits>, autoDeploy = false): Config {
  const raw = projectConfig(repo) ?? {}, base = defaults(); if (!isObject(raw)) throw new Error(".autoreview.json 须为对象");
  const cfg = {...base,...Object.fromEntries(Object.entries(raw).filter(([k])=>Object.hasOwn(base,k))),proofTestDirs:proofs ? raw.proofTestDirs : undefined};
  cfg.retry = {...base.retry,...raw.retry}; const integer = (n: number, min: number) => Number.isSafeInteger(n) && n >= min;
  for (const key of ["developerModel","developerThinking","reviewerModel","reviewerThinking","triageModel","triageThinking","reviewerCmd","setup"] as const)
    if (typeof cfg[key] !== "string" || cfg[key].includes("\0")) throw new Error(key+" 须为字符串");
  for (const key of ["maxParallelCards","tickIntervalSec","windowStartupSec","inboxIntervalMs","snapshotTimeoutMin","pushTimeoutSec","pushVerifyTimeoutSec"] as const)
    if (!integer(cfg[key],1)) throw new Error(key+" 须为正整数");
  if (!integer(cfg.retry.times,0) || !integer(cfg.cardRetryBudget,0) || !Array.isArray(cfg.retry.delaysMin) || cfg.retry.delaysMin.length < cfg.retry.times ||
      !cfg.retry.delaysMin.every(n=>Number.isFinite(n) && n>=0) || !(cfg.newSessionAtContext>0 && cfg.newSessionAtContext<=1) || typeof cfg.notifyAutoSummary!=="boolean") throw new Error("重试、上下文或通知配置不合法");
  if (!pathPatterns(cfg.localFiles) || cfg.proofTestDirs !== undefined && !pathPatterns(cfg.proofTestDirs) || cfg.reviewerCmd && !safeRelative(cfg.reviewerCmd)) throw new Error("localFiles/proofTestDirs/reviewerCmd 须为仓库相对路径");
  cfg.limits = {...base.limits};
  for (const k of Object.keys(base.limits) as (keyof Limits)[]) {
    const level = {...base.limits[k],...raw.limits?.[k],...limits?.[k]};
    if (!integer(level.maxRepairs,0) || !integer(level.timeoutMin,1)) throw new Error("限额 maxRepairs 须为非负整数、timeoutMin 须为正整数");
    cfg.limits[k] = level;
  }
  try { cfg.deploy = loadDeploy(repo); } catch (e) { if (autoDeploy) throw e; }
  if (raw.snapshot!==undefined && !safeRelative(raw.snapshot)) throw new Error("snapshot 须为仓库内可执行文件的相对路径");
  return {...cfg,snapshot:raw.snapshot};
}
