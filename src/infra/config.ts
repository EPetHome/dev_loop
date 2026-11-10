import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
