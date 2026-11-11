import { readdirSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { readCard, InputError, type Card } from "./card.ts";
import { loadConfig, inside, type Config } from "../infra/config.ts";
import { digest, readJson, writeJson, withLock, jsonLines, appendJson } from "../infra/files.ts";
import { gitText } from "../infra/git.ts";
import { tasksRoot } from "../infra/paths.ts";
import type { Identity } from "../infra/exec.ts";
export const PHASES = ["准备中", "开发中", "已交付", "复测中", "评审中", "等你", "完成", "失败", "已停止", "已放弃", "已合入", "合入失败", "推送中", "已推送", "推送失败", "推送结果不确定", "部署中", "已部署", "部署失败", "收尾中", "已退回"] as const;
export type Phase = typeof PHASES[number];
export type WaitReason = "复测退回到上限" | "评审必修到上限" | "停下没交付" | "需手动接入会话" | "收尾没走完";
export class LoopError extends Error {
  category: string; result?: unknown;
  constructor(category: string, message: string, result?: unknown) { super(message); this.category = category; this.result = result; }
}
export type State = "working" | "input_required" | "completed" | "failed" | "cancelled";
export type Bucket = "developmentMs" | "testMs" | "reviewMs" | "inputMs" | "selfMs";
export interface Task {
  executionId: string; dir: string; repo: string; card: string; cardHash: string; name: string; prompt: string; acceptance?: string;
  scope: Card["tasks"][number]["scope"]; test: string; host: Card["host"]; limits: Card["limits"]; config: Config;
  baseCommit: string; branch: string; worktree: string; createdAt: string; dispatchId: string | null; after?: string[]; next?: string;
}
export interface Check {
  commit: string; tree: string; step: string; result: string; startedAt: string; endedAt: string; durationMs: number;
  evidence: string[]; promptHash: string; acceptanceHash: string; detail?: string;
}
export interface Status {
  protocol: string; source: {worker: string; instance: string}; executionId: string; dispatchId: string | null; batchId: null;
  state: State; message: string; updatedAt: string; seq: number; generation: number; heartbeatSec: number; timeLimitSec: number | null;
  refs: {prompt: string; acceptance: string | null; card: string}; error: {category: string; raw: string} | null;
  evidence: string[]; actions: string[];
  loop: {
    phase: Phase; wait?: WaitReason | null; commit: string | null; testReturns: number; reviewRounds: number; reviewReturns: number;
    session: (Identity & {host: string; id: string; file?: string; endedAt?: string}) | null;
    startingSession: (Identity & {launchId: string}) | null;
    finisher?: Identity | null; afterCommit?: string | null; deployReturns?: number; pendingReturn?: string | null; next?: string; released?: boolean;
    activeProcess: Identity | null; launcher: Identity | null; ready: boolean; prepared: boolean; abandoned: boolean;
    durations: Record<Bucket, number>; bucket: Bucket | null; clockAt: number; stepStartedAt: number;
    delivery: {commit: string; tree: string; note: string; at: string} | null;
    warned: boolean; previousMustFix: string[]; previousReviewCommit: string | null;
    testAllowance: number; reviewAllowance: number; reused: boolean;
  };
}
export const taskOf = (dir: string) => readJson<Task>(join(dir, "task.json"));
export const statusOf = (dir: string) => readJson<Status>(join(dir, "status.json"));
export const checksOf = (dir: string) => jsonLines<Check>(join(dir, "checks.jsonl"));
export const appendCheck = (dir: string, check: Check) => appendJson(join(dir, "checks.jsonl"), check);
export function summary(dir: string, s = statusOf(dir)): void {
  const labels: Record<Bucket, string> = { developmentMs: "开发", testMs: "复测", reviewMs: "评审", inputMs: "等你", selfMs: "dev-loop 自身" };
  const checks = checksOf(dir), lines = ["# " + s.executionId, "", s.loop.phase + "：" + s.message.replace(/\s+/g, " ").slice(0, 220),
    s.loop.reused ? "结论：沿用此 commit 的已有检查。" : "", "", "| 步骤 | 结论 | 累计耗时 |", "|---|---|---|"];
  for (const [bucket, label] of Object.entries(labels)) {
    if (bucket === "selfMs") for (const extra of new Set(checks.map(c => c.step).filter(step => !Object.values(labels).includes(step)))) {
      const records = checks.filter(c => c.step === extra);
      lines.push("| " + extra + " | " + records.at(-1)!.result + " | " + (records.reduce((n, c) => n + c.durationMs, 0) / 1000).toFixed(2) + "s |");
    }
    const step = bucket === "testMs" ? "复测" : bucket === "reviewMs" ? "评审" : label;
    const last = checks.filter((c) => c.step === step).at(-1);
    const result = last?.result || (bucket === "inputMs" ? s.state === "input_required" ? "等待决定" : "—" : bucket === "developmentMs" ? s.loop.delivery ? "已交付" : "未交付" : s.loop.ready ? "就绪" : s.state);
    lines.push("| " + label + " | " + result + " | " + (s.loop.durations[bucket as Bucket] / 1000).toFixed(2) + "s |");
  }
  lines.push("", "commit：" + (s.loop.commit || "未交付"), "详情：" + join(dir, "checks.jsonl"));
  writeFileSync(join(dir, "summary.md"), lines.filter((s, i, a) => s || a[i - 1] !== "").join("\n") + "\n");
}
export function update(dir: string, action: (s: Status) => void): Status {
  return withLock(join(dir, "status.lock"), () => {
    const s = statusOf(dir), now = Date.now(), previousBucket = s.loop.bucket;
    if (s.loop.bucket) s.loop.durations[s.loop.bucket] += Math.max(0, now - s.loop.clockAt);
    s.loop.clockAt = now; action(s);
    if (s.loop.bucket !== previousBucket) s.loop.stepStartedAt = now;
    s.seq++; s.updatedAt = new Date(now).toISOString();
    writeJson(join(dir, "status.json"), s); summary(dir, s); return s;
  });
}
export function transition(dir: string, state: State, phase: Phase, message: string, bucket: Bucket | null, timeLimitSec: number | null = null): Status {
  return update(dir, (s) => {
    if (s.state === "cancelled" && state !== "cancelled") return;
    s.state = state; s.loop.phase = phase; s.message = message; s.loop.bucket = bucket; s.timeLimitSec = timeLimitSec;
    s.error = null; if (phase !== "等你") s.loop.wait = null;
  });
}
export function waitFor(dir: string, reason: WaitReason, message: string): void {
  transition(dir, "input_required", "等你", message, "inputMs");
  update(dir, (s) => { if (s.state === "input_required") s.loop.wait = reason; });
}
export function fail(dir: string, error: unknown, category?: string): void {
  const raw = error instanceof Error ? error.message : String(error);
  update(dir, (s) => {
    if (s.state === "cancelled") return;
    s.state = "failed"; s.loop.phase = "失败"; s.loop.wait = null; s.message = raw; s.loop.bucket = null; s.timeLimitSec = null;
    s.error = { category: category || (/EACCES|EPERM|Permission denied|权限/.test(raw) ? "权限不足" : error instanceof Error ? "工具内部错误" : "未知"), raw };
  });
}
const ascii = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 25) || digest(s).slice(0, 8);
export function createTask(file: string, root = tasksRoot(), dispatchId: string | null = null, baseCommit?: string): Task {
  const parsed = readCard(file), { repo, card } = parsed, task = card.tasks[0];
  let config: Config;
  try { config = loadConfig(repo); } catch (e) { throw new InputError(e instanceof Error ? e.message : String(e)); }
  mkdirSync(root, { recursive: true }); root = realpathSync(root);
  const executionId = [basename(repo), card.name, task.name].map(ascii).join("-") + "-" + randomBytes(3).toString("hex");
  const dir = join(root, executionId), createdAt = new Date().toISOString();
  const t: Task = { executionId, dir, repo, card: parsed.file, cardHash: parsed.cardHash, name: task.name,
    prompt: task.prompt, acceptance: card.acceptance, scope: task.scope, test: task.test, host: card.host, limits: card.limits, config,
    after: card.after, ...(card.next ? {next: card.next} : {}),
    baseCommit: baseCommit || gitText(repo, ["rev-parse", "refs/heads/" + card.base]), branch: "dev-loop/" + executionId,
    worktree: join(dir, "worktree"), createdAt, dispatchId };
  mkdirSync(dir); // 随机编号若碰撞，拒绝而不是覆盖已有执行。
  writeJson(join(dir, "task.json"), t);
  const s: Status = { protocol: "loop-status/1", source: {worker: "loop", instance: hostname()}, executionId, dispatchId, batchId: null,
    state: "working", message: "已接收，后台准备工作区", updatedAt: createdAt, seq: 1, generation: 1, heartbeatSec: 60, timeLimitSec: null,
    refs: { prompt: t.prompt, acceptance: t.acceptance || null, card: t.card }, error: null,
    evidence: [join(dir, "summary.md"), join(dir, "checks.jsonl")], actions: ["查询","续跑","停止","放弃"],
    loop: { phase: "准备中", wait: null, commit: null, testReturns: 0, reviewRounds: 0, reviewReturns: 0, session: null, startingSession: null, activeProcess: null, launcher: null, finisher: null, afterCommit: null, deployReturns: 0, pendingReturn: null,
      ready: false, prepared: false, abandoned: false, durations: { developmentMs: 0, testMs: 0, reviewMs: 0, inputMs: 0, selfMs: 0 },
      bucket: "selfMs", clockAt: Date.now(), stepStartedAt: Date.now(), delivery: null, warned: false, previousMustFix: [], previousReviewCommit: null,
      testAllowance: card.limits.测试.maxRepairs, reviewAllowance: card.limits.开发评审.maxRepairs, reused: false } };
  writeJson(join(dir, "status.json"), s);
  writeFileSync(join(dir, "checks.jsonl"), ""); writeFileSync(join(dir, "instructions.jsonl"), ""); summary(dir, s);
  return t;
}
export function allTasks(root = tasksRoot()): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
export function locate(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LOOP_TASK_DIR) { taskOf(env.LOOP_TASK_DIR); return resolve(env.LOOP_TASK_DIR); }
  const current = realpathSync(cwd);
  return allTasks(tasksRoot(env)).find((d) => inside(taskOf(d).worktree, current));
}
export function inputs(t: Task) {
  const prompt = readFileSync(t.prompt, "utf8"), acceptance = t.acceptance ? readFileSync(t.acceptance, "utf8") : "";
  return { prompt, acceptance, promptHash: digest(prompt), acceptanceHash: digest(acceptance) };
}
export function missingChecks(dir: string, commit: string, hashes = inputs(taskOf(dir))): string[] {
  const records = checksOf(dir).filter(c => c.commit === commit && ["复测", "评审"].includes(c.step));
  const same = records.filter(c => c.promptHash === hashes.promptHash && c.acceptanceHash === hashes.acceptanceHash), missing: string[] = [];
  if (!same.some(c => c.step === "复测" && ["通过", "没验证"].includes(c.result))) missing.push("复测：没有通过记录");
  if (!same.some(c => c.step === "评审" && c.result === "通过")) missing.push("评审：没有通过记录");
  if (missing.length && records.length !== same.length) missing.push("提示词或验收标准已变化，原检查不再算数");
  return missing;
}
export const checked = (dir: string, commit: string, hashes = inputs(taskOf(dir))) => missingChecks(dir, commit, hashes).length === 0;
interface StepView { phase: Phase; message: string; complete?: boolean }
function stepView(dir: string, view: StepView): void {
  update(dir, s => {
    if (s.state !== "completed" && !(s.state === "input_required" && view.complete) && !(s.state === "working" && s.loop.finisher)) return;
    if (s.state !== "working") { s.state = "completed"; s.loop.bucket = null; }
    s.loop.wait = null; s.timeLimitSec = null; s.error = null;
    s.loop.phase = view.phase; s.message = view.message;
  });
}
export function annotate(dir: string, phase: Phase, message: string): void { stepView(dir, {phase, message}); }
export function recordStep(dir: string, entry: Omit<Check, "tree" | "promptHash" | "acceptanceHash">, view?: StepView): void {
  const t = taskOf(dir); let hashes = {promptHash: "", acceptanceHash: ""};
  try { hashes = inputs(t); } catch {} // 附加步骤不依赖提示词仍然存在。
  appendCheck(dir, {...entry, tree: gitText(t.repo, ["rev-parse", entry.commit + "^{tree}"]), promptHash: hashes.promptHash, acceptanceHash: hashes.acceptanceHash});
  if (view) stepView(dir, view);
  summary(dir);
}
