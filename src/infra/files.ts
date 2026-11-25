import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, openSync, closeSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
  const temp=path+"."+randomUUID()+".tmp"; try {mkdirSync(dirname(path),{recursive:true});writeFileSync(temp,text);renameSync(temp,path);}finally{rmSync(temp,{force:true});}
}
export const writeJson = (path: string, value: unknown) => atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
export const appendJson = (path: string, value: unknown) => appendFileSync(path, JSON.stringify(value) + "\n");
export const jsonLines = <T>(path: string): T[] => (ifPresent(() => readText(path)) || "").split("\n").filter(Boolean).map(s => JSON.parse(s));
export class BusyError extends Error {}
// 锁附着在本进程持有的 fd；进程被杀由内核释放，不能 unlink 锁文件。
export function lock(path: string, waitMs = 0): () => void {
  const fd = openSync(path,"a",0o600), mac = process.platform === "darwin", secs = String(Math.ceil(waitMs/1000));
  const {status,error,stderr} = spawnSync(mac ? "/usr/bin/lockf" : "flock",mac ? ["-s","-t",secs,"3"] : ["-E","75","-w",secs,"3"],{stdio:["ignore","ignore","pipe",fd]});
  if (status === 0) return () => closeSync(fd);
  closeSync(fd); if (status === 75) throw new BusyError("任务正在处理，请稍后重试"); throw error || new Error("不能取得文件锁："+stderr);
}
export function withLock<T>(path: string, action: () => T, waitMs = 2000): T { const release = lock(path,waitMs); try { return action(); } finally { release(); } }
export async function underLock<T>(path: string, action: () => Promise<T>, waitMs = 0) {
  const release=lock(path,waitMs);try{return await action();}finally{release();}
}
