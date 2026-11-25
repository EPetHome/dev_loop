import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { commitOf, gitText, repoRoot, historyEnv } from "../infra/git.ts";
import { digest, errorText, readText } from "../infra/files.ts";
import { inside, isObject, pathPatterns, type Limits } from "../infra/config.ts";
export class InputError extends Error { category = "输入问题"; }
export class UnsupportedError extends InputError { category = "不支持"; }
export interface Scope { allow: string[]; deny: string[] }
export type Observation = string | number | boolean | null;
type Checkpoint = string | {id: string; expected: Observation};
export interface Scenario { id: string; paths?: string[]; checks: Checkpoint[]; dependencies?: string[] }
export type Proof = {
  issue: string; before?: string; testFiles: string[]; test: string; expected: Observation; beforeActual: Observation;
} & ({scenario: string; checkpoint: string; testName?: never} | {testName: string; scenario?: never; checkpoint?: never});
export const noTest = (test: string) => /^无\s*[:：]/.test(test);
export const noE2eCommand = "声明了 E2E 场景，却没有执行命令";
export interface Card {
  version: 1; name: string; base: string; target: "dev"; host: "pi"; flow: string[]; after: string[];
  tasks: { name: string; prompt: string; scope: Scope; test: string; e2e?: Scenario[]; proofs?: Proof[]; 版式?: {草图:string; 页面:string[]} }[]; acceptance?: string;
  limits: Partial<Limits>;
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
  const entries=v.map(parse); if (new Set(entries.map(key)).size!==entries.length) throw new InputError(label+" 有重复项"); return entries;
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
  const common={issue:text(issue,"问题单标识"),before:old,testFiles:files.sort(),test:command,expected,beforeActual};
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
  const raw = object(JSON.parse(content),"开发卡","version name nature base target host flow tasks limits acceptance");
  if (raw.version !== 1) throw new InputError("开发卡 version 必须是 1");
  for (const field of ["tasks","flow"]) if (!Array.isArray(raw[field]) || !raw[field].length) throw new InputError(field+" 须为非空数组");
  if (raw.tasks.length > 1) throw new UnsupportedError("本步不支持多任务卡；第 3 步支持（须选验收并标明任务归属）");
  const order = ["开发评审", "测试", "合入", "部署", "推送"];
  for (const step of raw.flow) {
    if (step === "提交") throw new UnsupportedError("开发卡的 flow 不写提交：请改写合入，提交已由 bin/loop 交付完成");
    if (!order.includes(step)) throw new UnsupportedError("不支持 flow " + step);
  }
  if (raw.nature !== "开发" || raw.flow[0] !== "开发评审" || raw.flow.some((s: string, i: number) => i && order.indexOf(s) <= order.indexOf(raw.flow[i - 1]))) throw new InputError("flow 须按 开发评审, 测试, 合入, 部署, 推送 的顺序且不重复");
  if (raw.flow.some((s: string) => ["部署", "推送"].includes(s)) && !raw.flow.includes("合入")) throw new InputError("flow 写部署或推送须包含合入");
  if (raw.target !== "dev") throw new InputError("target 必须为 dev，不碰 main");
  const base = text(raw.base ?? raw.target,"base"); if (base === "main" || base.startsWith("-")) throw new InputError("base 不合法或是 main");
  gitText(repo,["check-ref-format","--branch",base]); commitOf(repo,"refs/heads/"+base);
  const host = raw.host ?? "pi"; if (host !== "pi") throw new InputError("host 只支持 pi");
  const task = object(raw.tasks[0],"任务","name prompt scope test limits e2e proofs 版式"), name = text(task.name,"任务名");
  const test = task.test === undefined ? "无：卡未选择测试" : text(task.test, "test"), e2e = task.e2e === undefined ? undefined : parseE2e(task.e2e);
  if (raw.flow.includes("测试") && task.test === undefined && !e2e) throw new InputError("测试 flow 要求填写 test 或「无：原因」");
  if (noTest(test) && !/^无\s*[:：]\s*\S/.test(test)) throw new InputError("无测试须写原因");
  const limits = raw.limits === undefined ? {} : object(raw.limits,"limits","开发评审 测试 验收 部署");
  for (const [k,v] of Object.entries(limits)) object(v,k,"timeoutMin maxRepairs maxRecoveries");
  const ui = task.版式 === undefined ? undefined : object(task.版式,"版式","草图 页面");
  const 版式 = ui && {草图:reference(ui.草图,file,repo,"版式草图"),页面:list(ui.页面,"页面",p=>text(p,"页面"),p=>p)};
  if (版式 && (!版式.页面.length || 版式.页面.some((p:string)=>basename(p)!==p || /[\\/]/.test(p)))) throw new InputError("页面须为非空截图名清单（不含路径）");
  return { version: 1, name: text(raw.name, "name"), base, target: "dev", host, flow: raw.flow, after: raw.flow.filter((s: string) => order.indexOf(s) >= 2),
    tasks:[{name,prompt:reference(task.prompt,file,repo,"prompt"),scope:parseScope(task.scope),test,e2e,版式,
      proofs:task.proofs === undefined ? undefined : parseProofs(task.proofs,repo)}], limits,
    acceptance:raw.acceptance ? reference(raw.acceptance,file,repo,"acceptance") : undefined};
}
export function readCard(file: string) {
  try {
    file = realpathSync(file); const repo = realpathSync(repoRoot(dirname(file))), content = readText(file);
    return { file, repo, card: parseDevelopmentCard(content, file, repo), cardHash: digest(content) };
  } catch (e) { if (e instanceof InputError) throw e; throw new InputError(errorText(e)); }
}
