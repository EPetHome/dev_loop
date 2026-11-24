import { isAbsolute, relative, resolve } from "node:path";
import { errorText, optionalJson } from "./files.ts";
const projectConfig = (repo: string) => optionalJson<any>(resolve(repo,".autoreview.json"));
export const isObject = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
export interface DeployConfig { cmd: string; check?: string; rollback?: string; timeoutMin: number; env: Record<string,string> }
export function loadDeploy(repo: string): DeployConfig | undefined {
  try {
    const cfg = projectConfig(repo)?.deploy; if (cfg === undefined) return;
    if (!isObject(cfg)) throw new Error("须为对象");
    for (const key of ["cmd","check","rollback"]) if ((key === "cmd" || cfg[key] !== undefined) && !safeRelative(cfg[key]))
      throw new Error(key + " 须为仓库内可执行文件的相对路径");
    const timeoutMin = cfg.timeoutMin === undefined ? 20 : cfg.timeoutMin;
    if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > 240) throw new Error("timeoutMin 须为 1–240 的整数");
    const env = cfg.env === undefined ? {} : cfg.env;
    if (!isObject(env) || Object.entries(env).some(([k,v])=> !/^[A-Z][A-Z0-9_]*$/.test(k) || k.startsWith("LOOP_") || typeof v !== "string")) throw new Error("env 键须为大写环境变量且不能以 LOOP_ 开头，值须为字符串");
    return {env,cmd:cfg.cmd,check:cfg.check,rollback:cfg.rollback,timeoutMin};
  } catch (e) { throw new Error(".autoreview.json 的 deploy 不合法：" + errorText(e)); }
}
export function loadSnapshot(repo: string): string | undefined {
  const path = projectConfig(repo)?.snapshot;
  if (path !== undefined && !safeRelative(path)) throw new Error("snapshot 须为仓库内可执行文件的相对路径"); return path;
}
export interface Config { reviewerModel: string; reviewerThinking: string; reviewerCmd: string; localFiles: string[]; setup: string; proofTestDirs?: string[] }
export const safeRelative = (path: unknown): path is string => typeof path === "string" && !!path && !isAbsolute(path) &&
  !path.split(/[\\/]/).some(p => p === ".." || p === ".git") && !/[\0\r\n]/.test(path);
export const pathPatterns = (v: unknown): v is string[] => Array.isArray(v) && v.every(p => safeRelative(p) && p !== ".");
export const inside = (root: string, file: string) => { const r = relative(root, file); return r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
export function loadConfig(repo: string, proofs = false): Config {
  const config = projectConfig(repo), raw = config === undefined ? {} : config; if (!isObject(raw)) throw new Error(".autoreview.json 须为对象");
  const proofTestDirs = proofs ? raw.proofTestDirs : undefined;
  if (proofTestDirs !== undefined && (!Array.isArray(proofTestDirs) || !proofTestDirs.every(d => typeof d === "string" && d.trim()))) throw new Error("proofTestDirs 须为测试目录数组");
  for (const key of ["reviewerModel", "reviewerThinking", "reviewerCmd", "setup"])
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].includes("\0"))) throw new Error(key + " 须为字符串");
  const localFiles = raw.localFiles ?? []; if (!pathPatterns(localFiles)) throw new Error("localFiles 须为仓库内相对路径数组");
  return { reviewerModel: raw.reviewerModel || "openai-codex/gpt-6-astra", reviewerThinking: raw.reviewerThinking || "xhigh",
    reviewerCmd: raw.reviewerCmd || "", setup: raw.setup || "", localFiles, proofTestDirs };
}
