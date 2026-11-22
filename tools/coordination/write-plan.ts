import { execFileSync } from "node:child_process";
import { closeSync, constants, linkSync, openSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { bytes, entry, hash, json, missing, mkdir, publish, type Ref } from "./files.ts";

export interface Change { kind: "关单" | "结束提醒" | "月报" | "候选决定" | "候选确认"; to: string; from?: string; before?: string; content: string; summary: string; sources: Ref[] }
export interface Plan { project: string; command: string; changes: Change[]; date?: string; retryOf?: string }
export const planId = (plan: Plan) => hash(json(plan));
export const statePath = (root: string) => join(root, ".dev-loop-coord");
const plans = (root: string) => join(statePath(root),"plans");
const pathOf = (root: string,id: string) => join(plans(root),id);
const receiptPath = (dir:string,index:number) => join(dir,`${index}.result.json`);
const originalPath = (dir:string,index:number) => join(dir,`${index}.original`);
export type WriteResult = { kind: Change["kind"]; path: string; status: "applied" | "conflict"; reason?: string; original?: string };

export function locked<T>(root: string, fn: () => T) {
  const dir = statePath(root), path = join(dir,"write.lock");
  mkdir(root,dir);
  const current = entry(root,path);
  if (current && !current.isFile()) throw new Error("协调锁不是普通文件：" + path);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    // 让子进程在继承的 FD 上取锁。父进程关闭 FD（含被杀）时由内核释放，不删锁文件。
    const [command,args] = process.platform === "darwin" ? ["/usr/bin/lockf",["-t","10","3"]] : ["flock",["-x","-w","10","3"]];
    execFileSync(command,args,{stdio:["ignore","pipe","pipe",fd],timeout:12000});
    return fn();
  } finally { closeSync(fd); }
}
function readRecord<T>(root: string, file: string): T | undefined {
  const content = bytes(root,file);
  if (!content) return;
  try {
    const record = JSON.parse(content.toString("utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("不是对象");
    return record;
  } catch (e) { throw new Error(`登记记录不可读，保留现场：${file}：${e}`); }
}
export function savedPlan(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("无效计划编号");
  const file = join(pathOf(root,id),"plan.json"), plan = readRecord<Plan>(root,file);
  if (!plan) return;
  if (plan.project !== root || planId(plan) !== id) throw new Error("计划文件与预览编号不符：" + file);
  return plan;
}
export function pendingPlans(root:string, dirs: string[]) {
  return dirs.filter(id => {
    const plan = savedPlan(root,id);
    return plan?.changes.some((_,i)=>!entry(root,receiptPath(pathOf(root,id),i)));
  });
}

/** 同一预览并发只认一次；旧尝试完整但有冲突时，新预览另开尝试，不改旧回执。 */
export function previewAttempt(plan: Plan): Plan {
  while (plan.changes.length) {
    const id = planId(plan), dir = pathOf(plan.project,id);
    const results = plan.changes.map((_,i)=>readRecord<WriteResult>(plan.project,receiptPath(dir,i)));
    if (results.some(r=>!r) || !results.some(r=>r?.status === "conflict")) break;
    plan = {...plan,retryOf:id};
  }
  return plan;
}

/** 把已接管但未发布的源按原路径提供给重新预览；真实源路径出现时永远用真实文件。 */
export function capturedOriginals(plan: Plan) {
  const root = plan.project, dir = pathOf(root,planId(plan)), originals = new Map<string,string>();
  for (const [i,{from}] of plan.changes.entries()) {
    if (!from || entry(root,from) || entry(root,receiptPath(dir,i))) continue;
    const original = bytes(root,originalPath(dir,i));
    if (original) originals.set(from,original.toString("utf8"));
  }
  return originals;
}

/** 持项目锁执行。只发布完整文件，保留移动前原件；不以文件名相同认定为本工具的产物。 */
export function applyPlan(plan: Plan, current: Plan, afterCapture?: (change: Change) => void) {
  const root = plan.project, id = planId(plan), dir = pathOf(root,id), manifest = join(dir,"plan.json");
  if (!entry(root,manifest)) publish(root,manifest,json(plan));
  const results: WriteResult[] = [];
  for (const [i, change] of plan.changes.entries()) {
    const {to,from,before,kind,content} = change, receipt = receiptPath(dir,i), original = originalPath(dir,i), staged = join(dir,`${i}.new`);
    const written = readRecord<WriteResult>(root,receipt);
    if (written) { results.push(written); continue; }
    const out: WriteResult = {kind,path:to,status:"applied"};
    const conflict = (reason:string) => { out.status = "conflict"; out.reason = reason; };
    const fresh = current.changes.some(c=>json(c)===json(change)), captured = entry(root,original);
    const dest = entry(root,to), draft = entry(root,staged);
    const alreadyLinked = dest && draft && dest.isFile() && dest.dev === draft.dev && dest.ino === draft.ino;
    if (alreadyLinked) {
      if (hash(bytes(root,to)!) !== hash(content)) conflict("发布后文件已被编辑，保留用户内容");
      if (from && from !== to && entry(root,from)) conflict("源路径已重新出现，未移除该文件");
    } else if (dest && (!from || from !== to || captured)) conflict("目标已存在，未覆盖：" + to);
    else if (!fresh) conflict("预览依据已变化，保留现场；请重新预览");
    else {
      mkdir(root,dirname(to));
      const sourceMode = from ? (captured ?? entry(root,from))?.mode : undefined;
      if (!draft) publish(root,staged,content,sourceMode === undefined ? 0o600 : sourceMode & 0o777);
      if (hash(bytes(root,staged)!) !== hash(content)) conflict("暂存内容已变化");
      if (from && !captured && out.status === "applied") {
        const source = bytes(root,from);
        if (!source || hash(source) !== before) conflict("源文件已变化，未移动：" + from);
        else {
          try { renameSync(from,original); } // 用独立备份接住并发编辑，而不是删除或覆盖原路径。
          catch (e) {
            if (missing(e)) conflict("源路径在移动前已变化：" + from);
            else if ((e as NodeJS.ErrnoException).code === "EXDEV") conflict("源文件与恢复区不在同一文件系统，未移动");
            else throw e;
          }
          if (out.status === "applied") afterCapture?.(change);
        }
      }
      if (from && out.status === "applied") {
        if (!entry(root,original)?.isFile() || hash(bytes(root,original)!) !== before) conflict("原件与预览不同，保留并发改动");
        else if (entry(root,from)) conflict("源路径已重新出现，保留用户内容");
      }
      if (out.status === "applied") {
        try { linkSync(staged,to); } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EXDEV") conflict("目标与恢复区不在同一文件系统，未发布");
          else if (code === "EEXIST") conflict("目标已被创建，未覆盖：" + to);
          else throw e;
        }
        if (from && from !== to && entry(root,from)) conflict("源路径已重新出现，未移除该文件");
      }
    }
    if (from && entry(root,original)) {
      out.original = original;
      if (out.status === "conflict" && !alreadyLinked && !entry(root,from)) {
        // 恢复也不得覆盖后来保存的文件；如已有人补了原路径，原件始终在计划目录。
        const backup = bytes(root,original), mode = entry(root,original)?.mode;
        if (backup) try { publish(root,from,backup,mode === undefined ? 0o600 : mode & 0o777); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      }
    }
    publish(root,receipt,json(out)); results.push(out);
  }
  return {plan:manifest, complete:results.every(r=>r.status === "applied"), results};
}