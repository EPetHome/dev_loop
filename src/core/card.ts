import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { commitOf, gitText, repoRoot, historyEnv } from "../infra/git.ts";
import { digest, errorText, readText } from "../infra/files.ts";
import { inside, isObject, pathPatterns } from "../infra/config.ts";
import { HOOK_TIMEOUT_SEC, HOOK_OVERHEAD_SEC } from "../infra/host-limits.ts";
export class InputError extends Error { category = "输入问题"; }
export class UnsupportedError extends InputError { category = "不支持"; }
export interface Scope { allow: string[]; deny: string[] }
export interface Limit { maxRepairs: number; timeoutMin: number }
export type Observation = string | number | boolean | null;
type Checkpoint = string | {id: string; expected: Observation};
export interface Scenario { id: string; paths?: string[]; checks: Checkpoint[]; dependencies?: string[] }
export type Proof = {
  issue: string; before?: string; testFiles: string[]; test: string; expected: Observation; beforeActual: Observation;
} & ({scenario: string; checkpoint: string; testName?: never} | {testName: string; scenario?: never; checkpoint?: never});
export const noTest = (test: string) => /^无\s*[:：]/.test(test);
export const noE2eCommand = "声明了 E2E 场景，却没有执行命令";
export interface Card {
  version: 1; name: string; base: string; target: "dev"; host: "pi" | "claude" | "codex"; flow: string[]; after: string[]; next?: string;
  tasks: { name: string; prompt: string; scope: Scope; test: string; e2e?: Scenario[]; proofs?: Proof[] }[]; acceptance?: string;
  limits: { 测试: Limit; 开发评审: Limit; 部署: Limit };
}
const object = (v: any, label: string, keys?: string) => {
  if (!isObject(v)) throw new InputError(label + " 须为对象");
  if (keys && Object.keys(v).some(k => !keys.split(" ").includes(k))) throw new InputError(label+" 有未知字段"); return v;
};
const text = (v: any, label: string): string => {
  if (typeof v !== "string" || !v.trim() || /[\0\r\n]/.test(v)) throw new InputError(label+" 须为非空单行字符串"); return v.trim();
};
export const observed = (v: unknown): v is Observation => v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) || typeof v === "string" && !!v.trim();
export const checkId = (c: Checkpoint) => typeof c === "string" ? c : c.id;
function list<T>(v: any, label: string, parse: (entry: any) => T, key: (entry: T) => string): T[] {
  if (!Array.isArray(v)) throw new InputError(label + " 须为数组");
  const entries = v.map(parse); if (new Set(entries.map(key)).size !== entries.length) throw new InputError(label+" 有重复项");
  return entries;
}
export const parseE2e = (value: unknown): Scenario[] => list(value,"e2e",v => {
  const {id,paths,checks,dependencies} = object(v,"e2e 场景","id paths checks dependencies");
  if (paths !== undefined && (!pathPatterns(paths) || !paths.length)) throw new InputError("e2e.paths 须为非空仓库相对路径/通配符数组");
  const steps = list<Checkpoint>(checks,"e2e.checks",entry => {
    if (typeof entry === "string") return text(entry,"检查点");
    const {id,expected} = object(entry,"检查点","id expected");
    if (!observed(expected)) throw new InputError("检查点须声明单个 JSON 标量 expected");
    return {id:text(id,"检查点 id"),expected};
  },checkId);
  if (!steps.length) throw new InputError("e2e.checks 不能为空");
  return {id:text(id,"场景 id"),paths,checks:steps,dependencies:dependencies === undefined ? undefined : list(dependencies,"e2e.dependencies",d => text(d,"外部依赖"),d => d)};
},s => s.id);
const parseProofs = (value: unknown, repo: string) => list<Proof>(value,"proofs", entry => {
  const {issue,before,testFiles,test,expected,beforeActual,scenario,checkpoint,testName} = object(entry,"proofs 项",
    "issue before testFiles test expected beforeActual scenario checkpoint testName");
  if (!observed(expected) || !observed(beforeActual) || expected === beforeActual) throw new InputError("proofs 须声明不同的 JSON 标量 expected 和 beforeActual");
  const files = list(testFiles,"proofs.testFiles",path => text(path,"测试材料路径"),path => path);
  if (!files.length) throw new InputError("proofs.testFiles 不能为空");
  const command = text(test,"proofs.test"); if (noTest(command)) throw new InputError("proofs.test 须为实际执行命令");
  const old = before === undefined ? undefined : commitOf(repo,text(before,"旧版提交"),historyEnv());
  const common = {issue:text(issue,"问题单标识"),before:old,
    testFiles:files.sort((a,b) => a < b ? -1 : Number(a > b)),test:command,expected,beforeActual};
  if (testName === undefined) return {...common,scenario:text(scenario,"proofs.scenario"),checkpoint:text(checkpoint,"proofs.checkpoint")};
  if (scenario !== undefined || checkpoint !== undefined) throw new InputError("proofs 每项只选场景及检查点，或定向测试名");
  return {...common,testName:text(testName,"proofs.testName")};
}, p => JSON.stringify(p));
function reference(value: any, file: string, repo: string, label: string): string {
  const raw = text(value,label); if (isAbsolute(raw)) throw new InputError(label+" 须相对卡所在目录");
  const path = realpathSync(resolve(dirname(file),raw)), info = statSync(path);
  if (!inside(repo,path) || !info.isFile() || info.size > 200 * 1024 || readFileSync(path).includes(0)) throw new InputError(label + " 须为仓库内 <=200KB 文本");
  return path;
}
function limit(v: any, defaults: Limit): Limit {
  const raw = v === undefined ? {} : object(v, "limits"), out = { maxRepairs: raw.maxRepairs ?? defaults.maxRepairs, timeoutMin: raw.timeoutMin ?? defaults.timeoutMin };
  if (Object.keys(raw).some((k) => !["maxRepairs", "timeoutMin", "maxRecoveries"].includes(k)) ||
      !Number.isSafeInteger(out.maxRepairs) || out.maxRepairs < 0 || !Number.isSafeInteger(out.timeoutMin) || out.timeoutMin < 1) throw new InputError("限额 maxRepairs 须为非负整数、timeoutMin 须为正整数");
  return out;
}
export function parseScope(value: any): Scope {
  const raw = object(Array.isArray(value) ? {allow:value} : value,"scope","allow deny"), {allow} = raw, deny = raw.deny ?? [];
  if (!pathPatterns(allow) || !pathPatterns(deny)) throw new InputError("scope 须为仓库内相对路径/通配符数组");
  if (!allow.length) throw new InputError("scope.allow 不能为空"); return {allow,deny};
}
export function matches(file: string, pattern: string): boolean {
  pattern = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!/[*?]/.test(pattern)) return file === pattern || file.startsWith(pattern + "/");
  const re = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map((s) =>
    s === "**/" ? "(?:.*/)?" : s === "**" ? ".*" : s === "*" ? "[^/]*" : s === "?" ? "[^/]" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp("^" + re + "$").test(file);
}
export const inScope = (file: string, scope: Scope) => scope.allow.some((p) => matches(file, p)) && !scope.deny.some((p) => matches(file, p));
export function parseDevelopmentCard(content: string, file: string, repo: string): Card {
  const raw = object(JSON.parse(content),"开发卡","version name nature base target host flow tasks limits acceptance next");
  if (raw.version !== 1) throw new InputError("开发卡 version 必须是 1");
  for (const field of ["tasks","flow"]) if (!Array.isArray(raw[field]) || !raw[field].length) throw new InputError(field+" 须为非空数组");
  if (raw.tasks.length > 1) throw new UnsupportedError("本步不支持多任务卡；第 3 步支持（须选验收并标明任务归属）");
  const order = ["开发评审", "测试", "合入", "部署", "推送"];
  for (const step of raw.flow) {
    if (step === "提交") throw new UnsupportedError("开发卡的 flow 不写提交：请改写合入，提交已由 bin/loop 交付完成");
    if (step === "验收" || step === "整合") throw new UnsupportedError("本步不支持 flow " + step + "；第 3 步支持");
    if (!order.includes(step)) throw new UnsupportedError("不支持 flow " + step);
  }
  if (raw.nature !== "开发" || raw.flow[0] !== "开发评审" || raw.flow.some((s: string, i: number) => i && order.indexOf(s) <= order.indexOf(raw.flow[i - 1]))) throw new InputError("flow 须按 开发评审, 测试, 合入, 部署, 推送 的顺序且不重复");
  if (raw.flow.some((s: string) => ["部署", "推送"].includes(s)) && !raw.flow.includes("合入")) throw new InputError("flow 写部署或推送须包含合入");
  if (raw.target !== "dev") throw new InputError("target 必须为 dev，不碰 main");
  const base = text(raw.base ?? raw.target,"base"); if (base === "main" || base.startsWith("-")) throw new InputError("base 不合法或是 main");
  gitText(repo, ["check-ref-format", "--branch", base]);
  gitText(repo, ["rev-parse", "--verify", "--end-of-options", "refs/heads/" + base + "^{commit}"]);
  const host = raw.host ?? "pi"; if (!["pi","claude","codex"].includes(host)) throw new InputError("host 须为 pi/claude/codex");
  const task = object(raw.tasks[0],"任务","name prompt scope test limits e2e proofs"), name = text(task.name,"任务名");
  const test = task.test === undefined ? "无：卡未选择测试" : text(task.test, "test"), e2e = task.e2e === undefined ? undefined : parseE2e(task.e2e);
  if (raw.flow.includes("测试") && task.test === undefined && !e2e) throw new InputError("测试 flow 要求填写 test 或「无：原因」");
  if (noTest(test) && !/^无\s*[:：]\s*\S/.test(test)) throw new InputError("无测试须写原因");
  const limits = raw.limits === undefined ? {} : object(raw.limits,"limits","开发评审 测试 验收 部署");
  const effectiveLimits = { 测试: limit(limits.测试, { maxRepairs: 3, timeoutMin: 20 }), 开发评审: limit(limits.开发评审, { maxRepairs: 4, timeoutMin: 60 }), 部署: limit(limits.部署, { maxRepairs: 2, timeoutMin: 20 }) };
  const hookBudgetSec = (effectiveLimits.测试.timeoutMin + effectiveLimits.开发评审.timeoutMin) * 60 + HOOK_OVERHEAD_SEC;
  if (host !== "pi" && hookBudgetSec > HOOK_TIMEOUT_SEC) throw new UnsupportedError(
    `${host} Stop hook 外层时限为 ${HOOK_TIMEOUT_SEC} 秒；复测和评审合计加 ${HOOK_OVERHEAD_SEC} 秒余量需要 ${hookBudgetSec} 秒，不支持此配置。`+
    `请降低两项 timeoutMin 合计至 ${(HOOK_TIMEOUT_SEC-HOOK_OVERHEAD_SEC)/60} 分钟以内，或改用 pi。`);
  return { version: 1, name: text(raw.name, "name"), base, target: "dev", host, flow: raw.flow, after: raw.flow.filter((s: string) => order.indexOf(s) >= 2),
    tasks:[{name,prompt:reference(task.prompt,file,repo,"prompt"),scope:parseScope(task.scope),test,e2e,
      proofs:task.proofs === undefined ? undefined : parseProofs(task.proofs,repo)}], limits:effectiveLimits,
    next:raw.next === undefined ? undefined : reference(raw.next,file,repo,"next"),
    acceptance:raw.acceptance ? reference(raw.acceptance,file,repo,"acceptance") : undefined};
}
export function readCard(file: string) {
  try {
    file = realpathSync(file); const repo = realpathSync(repoRoot(dirname(file))), content = readText(file);
    return { file, repo, card: parseDevelopmentCard(content, file, repo), cardHash: digest(content) };
  } catch (e) { if (e instanceof InputError) throw e; throw new InputError(errorText(e)); }
}
