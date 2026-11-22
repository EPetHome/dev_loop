import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, openSync, closeSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { identity, alive } from "./exec.ts";
export const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const span = (start: number, end = Date.now()) => ({startedAt:iso(start), endedAt:iso(end), durationMs:Math.max(0,end-start)});
export const readText = (path: string) => readFileSync(path,"utf8");
export const readJson = <T>(path: string): T => JSON.parse(readText(path));
export function ifPresent<T>(read: () => T): T | undefined { try { return read(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
export const optionalJson = <T>(path: string) => ifPresent(() => readJson<T>(path));
export const maybe = <T>(read: () => T) => { try { return read(); } catch { return undefined; } };
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function atomicWrite(path: string, text: string | Buffer): void {
  const temp = path + "." + randomUUID() + ".tmp";
  try { mkdirSync(dirname(path),{recursive:true}); writeFileSync(temp,text); renameSync(temp,path); } finally { rmSync(temp,{force:true}); }
}
export const writeJson = (path: string, value: unknown) => atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
export const appendJson = (path: string, value: unknown) => appendFileSync(path, JSON.stringify(value) + "\n");
export const jsonLines = <T>(path: string): T[] => (ifPresent(() => readText(path)) || "").split("\n").filter(Boolean).map(s => JSON.parse(s));
export class BusyError extends Error {}
/** 长锁用于同任务交付/停下，短锁保护状态读改写。失去进程的锁可恢复，释放要核对 token。 */
export function lock(path: string, waitMs = 0): () => void {
  const owner = {...identity(),token:randomUUID()}, deadline = Date.now()+waitMs, sleep = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
      return () => { if (optionalJson<typeof owner>(path)?.token === owner.token) rmSync(path, { force: true }); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let previous: typeof owner | undefined; try { previous = readJson(path); } catch {}
      if (previous?.startedAt && !alive(previous)) { rmSync(path, { force: true }); continue; }
      if (Date.now() >= deadline) throw new BusyError("任务正在处理，请稍后重试");
      Atomics.wait(sleep,0,0,5);
    }
  }
}
export function withLock<T>(path: string, action: () => T, waitMs = 2000): T { const release = lock(path,waitMs); try { return action(); } finally { release(); } }
export async function underLock<T>(path: string, action: () => Promise<T>, waitMs = 0) {
  const release = lock(path,waitMs);
  try { return await action(); }
  finally { release(); }
}
