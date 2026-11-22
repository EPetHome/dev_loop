import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type Doc = Record<string, unknown>;
export type Ref = { file: string; line?: number; field?: string };
export const object = (value: unknown): Doc => value && typeof value === "object" && !Array.isArray(value) ? value as Doc : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown) => typeof value === "string" ? value : "";
export const strings = (value: unknown) => array(value).filter((v): v is string => typeof v === "string");
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export const ref = (file: string, line?: number, field?: string): Ref => ({file, ...(line !== undefined && {line}), ...(field && {field})});
export const inside = (root: string, file: string) => {
  const r = relative(root, file);
  return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};
export const repoPath = (root: string, name: string) => {
  const path = resolve(root, name);
  if (!name || !inside(root, path) || /[\0\r\n]/.test(name) || relative(root, path).split(sep).includes(".git")) throw new Error("路径不在登记范围内：" + name);
  return path;
};

// 不追踪符号链接；登记根目录先由调用者 realpath。目录走到哪一级缺失就停在哪一级。
export function entry(root: string, path: string) {
  const names = relative(root, repoPath(root, path)).split(sep).filter(Boolean);
  let dir = root;
  for (let i = 0; i <= names.length; i++) {
    const s = lstatSync(dir, {throwIfNoEntry: false});
    if (!s) return;
    if (s.isSymbolicLink() || i < names.length && !s.isDirectory()) throw new Error("不是登记范围内的普通路径：" + dir);
    if (i === names.length) return s;
    dir = resolve(dir, names[i]);
  }
}
export function bytes(root: string, path: string, limit = 64 * 1024 * 1024): Buffer | undefined {
  if (!entry(root, path)) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > limit) throw new Error("不是普通文件或超过读取上限：" + path);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export type Notice = { source: Ref; message: string };
export class Reader {
  root: string;
  warnings: Notice[];
  constructor(root: string, warnings: Notice[] = []) { this.root = root; this.warnings = warnings; }
  warn(file: string, message: string, line?: number) { this.warnings.push({source: ref(file, line), message}); }
  get<T>(file: string, read: () => T): T | undefined {
    try { return read(); } catch (e) { this.warn(file, String(e)); }
  }
  text(file: string) { return this.get(file, () => bytes(this.root, file)?.toString("utf8")); }
  doc(file: string) {
    const text = this.text(file);
    if (text === undefined) return;
    try {
      const value: unknown = JSON.parse(text);
      if (value !== object(value)) throw new Error("应为 JSON 对象");
      return object(value);
    } catch (e) { this.warn(file,String(e)); }
  }
  list(dir: string) { return this.get(dir, () => entry(this.root, dir) ? readdirSync(dir, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name)) : []) || []; }
  lines(file: string) {
    return (this.text(file) ?? "").split(/\r?\n/).flatMap((line, i) => {
      if (!line.trim()) return [];
      try {
        const value: unknown = JSON.parse(line);
        if (value !== object(value)) throw new Error("应为 JSON 对象");
        return [{value: object(value), source: ref(file, i + 1)}];
      } catch { this.warn(file, "JSONL 该行不完整或不可读，未采用", i + 1); return []; }
    });
  }
}
export function mkdir(root: string, dir: string) {
  const s = entry(root, dir);
  if (s?.isDirectory()) return;
  if (s) throw new Error("不是目录：" + dir);
  mkdir(root, dirname(dir));
  try { mkdirSync(dir, {mode: 0o700}); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !entry(root, dir)?.isDirectory()) throw e;
  }
}
/** 独占发布完整文件，不用会覆盖目标的 rename。中断只可能留下独立临时文件。 */
export function publish(root: string, path: string, data: string | Buffer, mode = 0o600) {
  mkdir(root, dirname(path));
  const temp = resolve(dirname(path), ".coord-" + randomUUID() + ".tmp");
  try {
    writeFileSync(temp, data, {flag: "wx", mode});
    linkSync(temp, path);
  } finally { rmSync(temp, {force: true}); }
}
export const canonical = (path: string) => {
  try { return realpathSync(path); } catch (e) { if (!missing(e)) throw e; return resolve(path); }
};
export const sha = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
// 不从文件名、mtime 或只记到日的日期推断部署时间。
export const time = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return;
  const date = value.slice(0,10), midnight = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(date + "T") || Number(value.slice(11,13)) > 23) return;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
export const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const days = (n: number) => n * 86400000;
