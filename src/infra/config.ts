import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
export interface DeployConfig { cmd: string; check?: string; rollback?: string; timeoutMin: number }
export function loadDeploy(repo: string): DeployConfig | undefined {
  try {
    const file = resolve(repo, ".autoreview.json"), cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))?.deploy : undefined;
    if (cfg === undefined) return undefined;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("须为对象");
    for (const key of ["cmd", "check", "rollback"]) {
      if (key !== "cmd" && cfg[key] === undefined) continue;
      if (typeof cfg[key] !== "string" || !safeRelative(cfg[key])) throw new Error(key + " 须为仓库内可执行文件的相对路径");
    }
    const timeoutMin = cfg.timeoutMin === undefined ? 20 : cfg.timeoutMin;
    if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > 240) throw new Error("timeoutMin 须为 1–240 的整数");
    return {cmd: cfg.cmd, ...(cfg.check !== undefined ? {check: cfg.check} : {}), ...(cfg.rollback !== undefined ? {rollback: cfg.rollback} : {}), timeoutMin};
  } catch (e) { throw new Error(".autoreview.json 的 deploy 不合法：" + (e instanceof Error ? e.message : String(e))); }
}
export interface Config { reviewerModel: string; reviewerThinking: string; reviewerCmd: string; localFiles: string[]; setup: string }
export function safeRelative(path: string): boolean {
  return Boolean(path && !isAbsolute(path) && !path.split(/[\\/]/).some((p) => p === ".." || p === ".git") && !/[\0\r\n]/.test(path));
}
export const inside = (root: string, file: string) => { const r = relative(root, file); return r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
export function loadConfig(repo: string): Config {
  const file = resolve(repo, ".autoreview.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!raw || Array.isArray(raw) || typeof raw !== "object") throw new Error(".autoreview.json 须为对象");
  for (const key of ["reviewerModel", "reviewerThinking", "reviewerCmd", "setup"])
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].includes("\0"))) throw new Error(key + " 须为字符串");
  const localFiles = raw.localFiles ?? [];
  if (!Array.isArray(localFiles) || localFiles.some((p) => typeof p !== "string" || !safeRelative(p) || p === ".")) throw new Error("localFiles 须为仓库内相对路径数组");
  return { reviewerModel: raw.reviewerModel || "astra", reviewerThinking: raw.reviewerThinking || "xhigh",
    reviewerCmd: raw.reviewerCmd || "", setup: raw.setup || "", localFiles };
}
