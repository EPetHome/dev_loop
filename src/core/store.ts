import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, realpathSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { InputError, type Card, type Proof } from "./card.ts";
import { inside, type Config } from "../infra/config.ts";
import { appendJson, jsonLines, readJson, ifPresent, iso, type span, withLock } from "../infra/files.ts";
import { tree } from "../infra/git.ts";
import { tasksRoot } from "../infra/paths.ts";
import type { Identity } from "../infra/exec.ts";
export const PHASES = ["准备中","开发中","已交付","复测中","评审中","等你","完成","失败","已停止","已放弃","已合入","合入失败","推送中","已推送","推送失败","推送结果不确定","部署中","已部署","部署失败","收尾中","已退回"] as const;
export type Phase = typeof PHASES[number];
export class LoopError extends Error { category: string; result?: unknown; constructor(category:string, message:string, result?:unknown) { super(message); this.category=category; this.result=result; } }
export type Task = Omit<Card["tasks"][number],"proofs"> & {
  proofs?: (Proof & {before:string})[]; executionId:string; dir:string; repo:string; card:string; cardHash:string; acceptance?:string;
  host:"pi"; limits:Config["limits"]; config:Config; base:string; baseCommit:string; branch:string; worktree:string; createdAt:string; dispatchId:string|null; after:string[];
};
export interface Hashes { promptHash:string; acceptanceHash:string; e2eHash?:string }
export interface Check extends Hashes, ReturnType<typeof span> {
  commit:string; tree:string; step:string; result:string; evidence:string[]; detail?:string; attempt?:string; unit?:string; missingScenarios?:string[];
}
export type Step = "准备"|"开窗口"|"收货"|"复测"|"评审"|"分诊"|"合入"|"部署"|"推送"|"释放"|"放弃"|"陪跑"|"退回";
export type Kind = "重试"|"超时"|"产品"|"冲突"|"未知"|"环境"|"疑问";
export type Wait = "需求疑问"|"轮数用完"|"开发推不动"|"环境修不好";
export interface Receipt {commit:string; tree:string; note:string; at:string; images:string[]}
export interface Job {step:Step; sha:string; key:string; retry?:boolean; source?:number; devBefore?:string; note?:string; images?:string[]; file?:string; auto?:boolean; target?:string}
export interface Outcome { result:string; kind?:Kind; text?:string; check?:Check; value?:any; flaky?:string; blocker?:string; baseFiles?:Record<string,string> }
export interface Entry extends Partial<Job>, Partial<Outcome> {
  type:string; n:number; at:string; ref?:number; owner?:Identity; todo?:string; wait?:Wait; rule?:number; status?:string;
  sent?:number[]; ending?:string; aborted?:boolean; context?:number; error?:string; level?:"复测"|"评审"|"部署"; count?:number;
  task?:Task; batch?:string[]; deps?:string[]; limit?:number; instruction?:string; proof?:Hashes; boundTree?:string;
}
export const ledgerFile = (dir:string) => join(dir,"ledger.jsonl");
export const hasLedger = (dir:string) => existsSync(ledgerFile(dir));
export const cardLock = (dir:string) => join(dir,"card.lock");
export class Ledger {
  readonly dir:string; readonly rows:Entry[]; readonly open:Entry; readonly task:Task;
  constructor(dir:string) {
    this.dir=dir; this.rows=jsonLines<Entry>(ledgerFile(dir));
    if (this.rows[0]?.type!=="开工" || !this.rows[0].task) throw new InputError("没有新版开工账本："+dir);
    this.open=this.rows[0]; const t=this.open.task!, baseCommit=this.last("准备好")?.sha || this.rows.find(r=>r.type==="开始" && r.step==="准备")?.sha || "";
    this.task={...t,baseCommit,proofs:t.proofs?.map(p=>({...p,before:p.before || baseCommit}))};
  }
  last(type:string) { return this.rows.findLast(r=>r.type===type); }
  add(entry:Omit<Entry,"n"|"at">, now=Date.now()) {
    const row={...entry,n:(this.rows.at(-1)?.n || 0)+1,at:iso(now)}; appendJson(ledgerFile(this.dir),row); this.rows.push(row); return row;
  }
  get delivery():Receipt|undefined { return this.last("提交")?.value; }
  get checks() { return this.rows.flatMap(r=>r.check ? [r.check] : []); }
}
export const locked = <T>(dir:string,fn:(l:Ledger)=>T,wait=2000) => withLock(cardLock(dir),()=>fn(new Ledger(dir)),wait);
export const taskOf = (dir:string):Task => hasLedger(dir) ? new Ledger(dir).task : readJson(join(dir,"task.json"));
export const checksOf=(dir:string)=>new Ledger(dir).checks;
export const allTasks = (root=tasksRoot()) => (ifPresent(()=>readdirSync(root,{withFileTypes:true})) || []).flatMap(e=>{
  const dir=join(root,e.name); return e.isDirectory() && !e.name.startsWith(".") && (hasLedger(dir) || existsSync(join(dir,"task.json"))) ? [dir] : [];
});
export const locate=(cwd:string,env=process.env)=>env.LOOP_TASK_DIR ? resolve(env.LOOP_TASK_DIR) : allTasks(tasksRoot(env)).find(d=>{const w=taskOf(d).worktree;return w && inside(w,realpathSync(cwd));});
export function recordStep(dir:string,entry:Omit<Check,keyof Hashes|"tree"> & Partial<Hashes & {tree:string}>) {
  locked(dir,l=>l.add({type:entry.step,check:{promptHash:"",acceptanceHash:"",...entry,tree:entry.tree ?? tree(l.task.repo,entry.commit)}}));
}
export function batchResult(t:Task,lines:string[],marker:string) {
  const batch=dirname(t.card), file=join(batch,"结果.md");
  if (realpathSync.native(batch)!==batch || !inside(t.repo,batch)) throw new InputError("批次目录已移动或越界："+batch);
  const fd=openSync(file,constants.O_CREAT|constants.O_APPEND|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o644);
  try {
    const info=fstatSync(fd); if (!info.isFile() || info.nlink!==1) throw new InputError("结果.md 不是批次独有的普通文件："+file);
    if (!readFileSync(fd,"utf8").split("\n").includes(marker)) appendFileSync(fd,[...lines,marker,""].join("\n"));
  } finally { closeSync(fd); }
}
