import { readdirSync, mkdirSync, writeFileSync, realpathSync, constants, openSync, fstatSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { readCard, parseE2e, noTest, noE2eCommand, InputError, type Card, type Proof, type Scenario } from "./card.ts";
import { clip } from "./test-summary.ts";
import { loadConfig, inside, type Config } from "../infra/config.ts";
import { digest, readJson, writeJson, withLock, jsonLines, appendJson, iso, span, ifPresent, errorText, readText } from "../infra/files.ts";
import { commitOf, tree, historyEnv } from "../infra/git.ts";
import { tasksRoot } from "../infra/paths.ts";
import type { Identity } from "../infra/exec.ts";
import { idleSleep } from "../infra/idle-sleep.ts";
export const PHASES = ["准备中", "开发中", "已交付", "复测中", "评审中", "等你", "完成", "失败", "已停止", "已放弃", "已合入", "合入失败", "推送中", "已推送", "推送失败", "推送结果不确定", "部署中", "已部署", "部署失败", "收尾中", "已退回"] as const;
export type Phase = typeof PHASES[number];
export const ENV_WAIT = "复测环境未就绪";
export type WaitReason = "复测退回到上限" | "评审必修到上限" | "停下没交付" | "模型出错" | "需手动接入会话" | "收尾没走完" | typeof ENV_WAIT;
export class LoopError extends Error {
  category: string; result?: unknown;
  constructor(category: string, message: string, result?: unknown) { super(message); this.category = category; this.result = result; }
}
export type State = "working" | "input_required" | "completed" | "failed" | "cancelled";
export type Resolution = "续跑" | "收尾" | "合入（接受未验证）" | "停止" | "放弃" | "沿用通过记录" | "本人接受环境缺项";
interface Facts {
  name: string; startedAt: string; resumes: number;
  stops: {at: string; step: Phase; state: State; reason: string; message: string; resumedAt: string | null; resolvedBy: Resolution | null}[];
}
const newFacts = (t: Task): Facts => ({name: t.name, startedAt: t.createdAt, resumes: 0, stops: []});
const labels = {developmentMs:"开发", testMs:"复测", reviewMs:"评审", inputMs:"等你", selfMs:"dev-loop 自身"};
export type Bucket = keyof typeof labels;
export type Task = Omit<Card["tasks"][number],"proofs"> & {
  proofs?: (Proof & {before: string})[];
  executionId: string; dir: string; repo: string; card: string; cardHash: string; acceptance?: string;
  host: Card["host"]; limits: Card["limits"]; config: Config;
  baseCommit: string; branch: string; worktree: string; createdAt: string; dispatchId: string | null; after?: string[]; next?: string;
};
export interface Hashes { promptHash: string; acceptanceHash: string; e2eHash?: string }
export interface Check extends Hashes, ReturnType<typeof span> {
  commit: string; tree: string; step: string; result: string;
  evidence: string[]; detail?: string; attempt?: string; unit?: string; missingScenarios?: string[];
}
export interface ReleasePending { at: string; auto?: true; target?: {gitDir: string; id: string} }
export type Status = ReturnType<typeof initialStatus> & {loop: {
  pendingOpening?: boolean; launchStarted?: boolean; next?: string; releasePending?: ReleasePending | null;
  remindedCandidates?: string[]; retestAttempt?: string; reviewRequest?: string;
}};
function initialStatus(t: Task) {
  const {dir,executionId,dispatchId,createdAt,prompt,card,limits} = t, now = Date.now();
  return {protocol:"loop-status/1",source:{worker:"loop",instance:hostname()},executionId,dispatchId,batchId:null,
    state:"working" as State,message:"已接收，后台准备工作区",updatedAt:createdAt,seq:1,generation:1,heartbeatSec:60,timeLimitSec:null as number|null,
    refs:{prompt,acceptance:t.acceptance || null,card},error:null as {category:string;raw:string}|null,
    evidence:[join(dir,"summary.md"),join(dir,"checks.jsonl")],actions:["查询","续跑","答复","停止","放弃"],
    warnings:t.e2e && noTest(t.test) ? [noE2eCommand] : undefined,
    loop:{phase:"准备中" as Phase,wait:null as WaitReason|null,facts:newFacts(t) as Facts|undefined,commit:null as string|null,
      testReturns:0,reviewRounds:0,reviewReturns:0,deployReturns:0,pendingReturn:null as string|null,answerCount:0,
      session:null as (Identity & {host:string;id:string;file?:string;endedAt?:string})|null,
      startingSession:null as (Identity & {launchId:string})|null,launcher:null as Identity|null,finisher:null as Identity|null,activeProcess:null as Identity|null,
      ready:false,prepared:false,abandoned:false,released:false,durations:{developmentMs:0,testMs:0,reviewMs:0,inputMs:0,selfMs:0},
      bucket:"selfMs" as Bucket|null,clockAt:now,stepStartedAt:now,afterCommit:null as string|null,previousMustFix:[] as string[],previousReviewCommit:null as string|null,
      delivery:null as {commit:string;tree:string;note:string;at:string}|null,testAllowance:limits.测试.maxRepairs,reviewAllowance:limits.开发评审.maxRepairs,reused:false}};
}
export const taskOf = (dir: string) => readJson<Task>(join(dir, "task.json"));
export const answersOf = (dir: string) => jsonLines<{at: string; text: string}>(join(dir, "answers.jsonl"));
export const statusOf = (dir: string) => { const s = readJson<Status>(join(dir, "status.json")); s.loop.answerCount = answersOf(dir).length; return s; };
export const launchStarted = ({loop}: Status) => Boolean(loop.launchStarted || loop.prepared || loop.launcher || loop.session);
export const checksOf = (dir: string) => jsonLines<Check>(join(dir, "checks.jsonl"));
export const appendCheck = (dir: string, check: Check) => appendJson(join(dir, "checks.jsonl"), check);
export function summary(dir: string, s = statusOf(dir)): void {
  const checks = checksOf(dir), steps = new Map<string,{result:string; ms:number}>(), {loop} = s;
  for (const {step,result,durationMs} of checks) steps.set(step,{result,ms:(steps.get(step)?.ms || 0)+durationMs});
  const row = (step: string, result: string, ms: number) => `| ${step} | ${result} | ${(ms/1000).toFixed(2)}s |`;
  const fallback: Partial<Record<Bucket,string>> = {developmentMs:loop.delivery ? "已交付" : "未交付", inputMs:s.state === "input_required" ? "等待决定" : "—"};
  const rows = (Object.keys(labels) as Bucket[]).map(k => row(labels[k],steps.get(labels[k])?.result || fallback[k] || (loop.ready ? "就绪" : s.state),loop.durations[k]));
  rows.splice(-1,0,...[...steps].filter(([step]) => !Object.values(labels).includes(step)).map(([step,v]) => row(step,v.result,v.ms)));
  const test = lastTest(checks,loop.commit), e2e = test?.attempt ? ["",`复测尝试：${test.attempt} / ${test.result}`,clip(test.detail || "",4096),...test.evidence.slice(0,3)] : [];
  writeFileSync(join(dir,"summary.md"),[`# ${s.executionId}`,"",`${loop.phase}：${s.message.replace(/\s+/g," ").slice(0,220)}`,
    ...(loop.reused ? ["结论：沿用此 commit 的已有检查。"] : []),"","| 步骤 | 结论 | 累计耗时 |","|---|---|---|",...rows,...e2e,
    "","commit："+(loop.commit || "未交付"),"详情："+join(dir,"checks.jsonl"),""].join("\n"));
}
export function update(dir: string, action: (s: Status) => void, resolvedBy: Resolution = "续跑", when = (_: Status) => true): Status {
  return withLock(join(dir,"status.lock"), () => {
    const s = statusOf(dir); if (!when(s)) return s;
    const now = Date.now(), previousBucket = s.loop.bucket, before = {state:s.state,phase:s.loop.phase}; s.loop.facts ||= newFacts(taskOf(dir));
    if (s.loop.bucket) s.loop.durations[s.loop.bucket] += Math.max(0, now - s.loop.clockAt);
    s.loop.clockAt = now; action(s);
    const stopped = ["input_required", "failed", "cancelled"].includes(s.state), at = iso(now);
    const entered = stopped && (before.state !== s.state || before.phase !== s.loop.phase), facts = s.loop.facts!, last = facts.stops.at(-1);
    const destination = s.state === "cancelled" ? s.loop.phase === "已放弃" ? "放弃" : "停止" : resolvedBy;
    if (last && !last.resumedAt && (entered || !stopped)) { last.resumedAt = at; last.resolvedBy = destination; }
    if (entered) facts.stops.push({at, step: before.phase, state: s.state,
      reason: s.state === "input_required" ? s.loop.wait || "" : s.state === "failed" ? s.error?.category || "未知" : s.loop.phase === "已放弃" ? "已放弃" : "已停止",
      message: [...s.message].slice(0, 200).join(""), resumedAt: null, resolvedBy: null});
    facts.stops = facts.stops.slice(-50);
    if (s.loop.bucket !== previousBucket) s.loop.stepStartedAt = now; s.seq++; s.updatedAt = at;
    const session = s.loop.session, owner = session && ["claude", "codex"].includes(session.host) && ["开发中", "已交付"].includes(s.loop.phase) && !session.endedAt ? session : undefined;
    writeJson(join(dir, "status.json"), s); idleSleep(dir, s.state === "working", now, process.env, owner); summary(dir, s); return s;
  });
}
export function move(s: Status, state: State, phase: Phase, message: string, bucket: Bucket | null, timeLimitSec: number | null = null) {
  if (s.state === "cancelled" && state !== "cancelled") return false;
  Object.assign(s,{state,message,error:null,timeLimitSec}); Object.assign(s.loop,{phase,bucket,wait:null});
  if (state !== "working" || phase !== "评审中") delete s.loop.reviewRequest;
  if (state === "completed" || ["准备中","开发中","收尾中"].includes(phase)) delete s.loop.retestAttempt; return true;
}
export const matchesReviewRequest = ({state,loop}: Status, request: string) => !!request && state === "working" && loop.phase === "评审中" && loop.reviewRequest === request;
export const transition = (dir: string, state: State, phase: Phase, message: string, bucket: Bucket | null, timeout?: number | null) => update(dir, s => { move(s,state,phase,message,bucket,timeout); });
export function waiting(s: Status, reason: WaitReason, message: string, pendingReturn?: string) {
  if (move(s,"input_required","等你",message,"inputMs")) Object.assign(s.loop,{wait:reason,...(pendingReturn === undefined ? {} : {pendingReturn})});
}
export const waitFor = (dir: string, reason: WaitReason, message: string, pendingReturn?: string) => update(dir, s => waiting(s,reason,message,pendingReturn));
export function fail(dir: string, error: unknown, category?: string, when?: (s: Status) => boolean): void {
  const raw = errorText(error), kind = category || (/EACCES|EPERM|Permission denied|权限/.test(raw) ? "权限不足" : error instanceof Error ? "工具内部错误" : "未知");
  update(dir,s => { if (!s.loop.releasePending && !s.loop.released && move(s,"failed","失败",raw,null)) s.error = {category:kind,raw}; },undefined,when);
}
export function batchResult(t: Task, lines: string[], marker?: string) {
  const batch = dirname(t.card), file = join(batch,"结果.md");
  if (!marker) return appendFileSync(file,lines.join("\n"));
  if (realpathSync.native(batch) !== batch || !inside(t.repo,batch)) throw new InputError("批次目录已移动或越界："+batch);
  const fd = openSync(file,constants.O_CREAT|constants.O_APPEND|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o644);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new InputError("结果.md 不是批次独有的普通文件："+file);
    if (!readFileSync(fd,"utf8").split("\n").includes(marker)) appendFileSync(fd,[...lines,marker,""].join("\n"));
  } finally { closeSync(fd); }
}
const ascii = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 25) || digest(s).slice(0, 8);
export function createTask(file: string, root = tasksRoot(), dispatchId: string | null = null, baseCommit?: string): Task {
  const {repo,card,file:source,cardHash} = readCard(file), task = card.tasks[0];
  let config: Config;
  try { config = loadConfig(repo,Boolean(task.proofs?.length)); } catch (e) { throw new InputError(errorText(e)); }
  const startCommit = !task.proofs?.length && baseCommit || commitOf(repo,baseCommit || "refs/heads/"+card.base,task.proofs?.length ? historyEnv() : undefined);
  const proofs = task.proofs?.map(p => ({...p,before:p.before ?? startCommit}));
  mkdirSync(root, { recursive: true }); root = realpathSync(root);
  const executionId = [...[basename(repo),card.name,task.name].map(ascii),randomBytes(3).toString("hex")].join("-");
  const dir = join(root,executionId), createdAt = iso(), {acceptance,host,limits,after,next} = card;
  const t: Task = {...task,proofs,executionId,dir,repo,card:source,cardHash,acceptance,host,limits,config,after,next,createdAt,dispatchId,
    baseCommit:startCommit,branch:"dev-loop/"+executionId,worktree:join(dir,"worktree")};
  mkdirSync(dir); writeJson(join(dir, "task.json"), t); // 编号碰撞时 mkdir 拒绝覆盖。
  const s = initialStatus(t); writeJson(join(dir,"status.json"),s); idleSleep(dir,true);
  for (const file of ["checks.jsonl","instructions.jsonl"]) writeFileSync(join(dir,file),""); summary(dir,s); return t;
}
export const allTasks = (root = tasksRoot()) => (ifPresent(() => readdirSync(root,{withFileTypes:true})) || []).flatMap(e => e.isDirectory() ? [join(root,e.name)] : []);
export function locate(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LOOP_TASK_DIR) { taskOf(env.LOOP_TASK_DIR); return resolve(env.LOOP_TASK_DIR); }
  const current = realpathSync(cwd); return allTasks(tasksRoot(env)).find(d=>inside(taskOf(d).worktree,current));
}
export function inputs(t: Task) {
  const prompt = readText(t.prompt), acceptance = t.acceptance ? readText(t.acceptance) : "";
  // 只重读正式卡源的场景；旧执行永远沿用启动时未接入的语义。
  const e2e = t.e2e && parseE2e(readJson<{tasks: {e2e?: Scenario[]}[]}>(t.card).tasks[0].e2e);
  return {prompt,acceptance,e2e,promptHash:digest(prompt),acceptanceHash:digest(acceptance), ...(e2e ? {e2eHash:digest(JSON.stringify(e2e))} : {})};
}
export const sameInputs = (a: Hashes, b: Hashes) => a.promptHash === b.promptHash && a.acceptanceHash === b.acceptanceHash && a.e2eHash === b.e2eHash;
const testPassed = (c?: Check) => !!c && (c.e2eHash ? !!c.attempt && ["通过","本人接受环境缺项"].includes(c.result) : ["通过","没验证"].includes(c.result));
export const lastTest = (records: Check[], commit: string | null, match = (_: Check) => true) => records.findLast(c => c.step === "复测" && c.commit === commit && match(c));
export function qualifiedTest(records: Check[], commit: string, hashes: Hashes) {
  const match = (c: Check) => sameInputs(c,hashes) && (hashes.e2eHash ? !!c.attempt && c.result !== "已停止" : testPassed(c));
  const test = lastTest(records,commit,match); return testPassed(test) ? test : undefined;
}
export const reviewFor = (records: Check[], test: Check) => records.findLast(c => c.step === "评审" && c.result !== "已停止" &&
  c.commit === test.commit && c.tree === test.tree && c.attempt === test.attempt && sameInputs(c,test));
export function missingChecks(dir: string, commit: string, hashes: Hashes = inputs(taskOf(dir))): string[] {
  const records = checksOf(dir).filter(c => c.commit === commit && ["复测","评审"].includes(c.step)), test = qualifiedTest(records,commit,hashes);
  const review = hashes.e2eHash ? !!test && reviewFor(records,test)?.result === "通过" : records.some(c => c.step === "评审" && c.result === "通过" && sameInputs(c,hashes));
  const missing = [...(test ? [] : ["复测：没有通过记录"]), ...(review ? [] : ["评审：没有通过记录"])];
  if (missing.length && records.some(c => !sameInputs(c,hashes))) missing.push((hashes.e2eHash ? "提示词、验收标准或 E2E 清单" : "提示词或验收标准") + "已变化，原检查不再算数");
  return missing;
}
export const checked = (dir: string, commit: string, hashes?: Hashes) => !missingChecks(dir,commit,hashes).length;
interface StepView { phase: Phase; message: string; complete?: boolean }
const stepView = (dir: string, {phase,message,complete}: StepView) => update(dir,s => {
  if (s.state === "completed" || s.state === "input_required" && complete) move(s,"completed",phase,message,null);
  else if (s.state === "working" && s.loop.finisher) move(s,"working",phase,message,s.loop.bucket);
}, "合入（接受未验证）");
export const annotate = (dir: string, phase: Phase, message: string) => stepView(dir,{phase,message});
export function recordStep(dir: string, entry: Omit<Check, keyof Hashes | "tree"> & Partial<Hashes & {tree:string}>, view?: StepView): void {
  const t = taskOf(dir);
  let hashes: Hashes = {promptHash:"",acceptanceHash:""};
  if (entry.promptHash === undefined) try { const {prompt,acceptance,e2e,...bound} = inputs(t); hashes = bound; } catch {} // 附加步骤可单独记录。
  appendCheck(dir,{...hashes,...entry,tree:entry.tree ?? tree(t.repo,entry.commit)});
  if (view) stepView(dir,view); else summary(dir);
}
