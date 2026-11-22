/** 从旧 parseDevelopmentCard 精简：仅 version 1 单任务核心；校验先于创建资源。 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { gitText, repoRoot } from "../infra/git.ts";
import { digest } from "../infra/files.ts";
import { inside, safeRelative } from "../infra/config.ts";
import { HOOK_TIMEOUT_SEC, HOOK_OVERHEAD_SEC } from "../infra/host-limits.ts";
export class InputError extends Error { category = "输入问题"; }
export class UnsupportedError extends InputError { category = "不支持"; }
export interface Scope { allow: string[]; deny: string[] }
export interface Limit { maxRepairs: number; timeoutMin: number }
export interface Card {
  version: 1; name: string; base: string; target: "dev"; host: "pi" | "claude" | "codex"; flow: string[]; after: string[]; next?: string;
  tasks: { name: string; prompt: string; scope: Scope; test: string }[]; acceptance?: string;
  limits: { 测试: Limit; 开发评审: Limit; 部署: Limit };
}
const object = (v: any, label: string) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InputError(label + " 须为对象");
  return v;
};
const only = (o: object, allowed: string[]) => Object.keys(o).every(k => allowed.includes(k));
const text = (v: any, label: string): string => {
  if (typeof v !== "string" || !v.trim() || /[\0\r\n]/.test(v)) throw new InputError(label + " 须为非空单行字符串");
  return v.trim();
};
function reference(value: any, file: string, repo: string, label: string): string {
  const raw = text(value, label);
  if (isAbsolute(raw)) throw new InputError(label + " 须相对卡所在目录");
  const path = realpathSync(resolve(dirname(file), raw)), info = statSync(path), bytes = readFileSync(path);
  if (!inside(repo, path) || !info.isFile() || bytes.length > 200 * 1024 || bytes.includes(0)) throw new InputError(label + " 须为仓库内 <=200KB 文本");
  return path;
}
function limit(v: any, defaults: Limit): Limit {
  const raw = v === undefined ? {} : object(v, "limits"), out = { maxRepairs: raw.maxRepairs ?? defaults.maxRepairs, timeoutMin: raw.timeoutMin ?? defaults.timeoutMin };
  if (!only(raw, ["maxRepairs", "timeoutMin", "maxRecoveries"]) ||
      !Number.isSafeInteger(out.maxRepairs) || out.maxRepairs < 0 || !Number.isSafeInteger(out.timeoutMin) || out.timeoutMin < 1) throw new InputError("限额 maxRepairs 须为非负整数、timeoutMin 须为正整数");
  return out;
}
export function parseScope(value: any): Scope {
  const raw = object(Array.isArray(value) ? { allow: value } : value, "scope");
  if (!only(raw, ["allow", "deny"])) throw new InputError("scope 只支持 allow/deny");
  const out = { allow: raw.allow, deny: raw.deny ?? [] };
  for (const paths of [out.allow, out.deny]) if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || !safeRelative(p) || p === ".")) throw new InputError("scope 须为仓库内相对路径/通配符数组");
  if (!out.allow.length) throw new InputError("scope.allow 不能为空");
  return out;
}
function matches(file: string, pattern: string): boolean {
  pattern = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!/[*?]/.test(pattern)) return file === pattern || file.startsWith(pattern + "/");
  const re = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map((s) =>
    s === "**/" ? "(?:.*/)?" : s === "**" ? ".*" : s === "*" ? "[^/]*" : s === "?" ? "[^/]" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp("^" + re + "$").test(file);
}
export const inScope = (file: string, scope: Scope) => scope.allow.some((p) => matches(file, p)) && !scope.deny.some((p) => matches(file, p));
export function parseDevelopmentCard(content: string, file: string, repo: string): Card {
  const raw = object(JSON.parse(content), "开发卡"); if (raw.version !== 1) throw new InputError("开发卡 version 必须是 1");
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) throw new InputError("tasks 须为非空数组");
  if (raw.tasks.length > 1) throw new UnsupportedError("本步不支持多任务卡；第 3 步支持（须选验收并标明任务归属）");
  if (!Array.isArray(raw.flow) || !raw.flow.length) throw new InputError("flow 须为非空数组");
  const order = ["开发评审", "测试", "合入", "部署", "推送"];
  for (const step of raw.flow) {
    if (step === "提交") throw new UnsupportedError("开发卡的 flow 不写提交：请改写合入，提交已由 bin/loop 交付完成");
    if (step === "验收" || step === "整合") throw new UnsupportedError("本步不支持 flow " + step + "；第 3 步支持");
    if (!order.includes(step)) throw new UnsupportedError("不支持 flow " + step);
  }
  if (raw.nature !== "开发" || raw.flow[0] !== "开发评审" || raw.flow.some((s: string, i: number) => i && order.indexOf(s) <= order.indexOf(raw.flow[i - 1]))) throw new InputError("flow 须按 开发评审, 测试, 合入, 部署, 推送 的顺序且不重复");
  if (raw.flow.some((s: string) => ["部署", "推送"].includes(s)) && !raw.flow.includes("合入")) throw new InputError("flow 写部署或推送须包含合入");
  if (!only(raw, ["version","name","nature","base","target","host","flow","tasks","limits","acceptance","next"])) throw new InputError("开发卡有未知字段");
  if (raw.target !== "dev") throw new InputError("target 必须为 dev，不碰 main");
  const base = text(raw.base ?? raw.target, "base");
  if (base === "main" || base.startsWith("-")) throw new InputError("base 不合法或是 main");
  gitText(repo, ["check-ref-format", "--branch", base]);
  gitText(repo, ["rev-parse", "--verify", "--end-of-options", "refs/heads/" + base + "^{commit}"]);
  const host = raw.host ?? "pi"; if (!["pi","claude","codex"].includes(host)) throw new InputError("host 须为 pi/claude/codex");
  const task = object(raw.tasks[0], "任务"), name = text(task.name, "任务名");
  if (!only(task, ["name","prompt","scope","test","limits"])) throw new InputError("任务有未知字段");
  const test = task.test === undefined ? "无：卡未选择测试" : text(task.test, "test");
  if (raw.flow.includes("测试") && task.test === undefined) throw new InputError("测试 flow 要求填写 test 或「无：原因」");
  if (/^无\s*[:：]/.test(test) && !/^无\s*[:：]\s*\S/.test(test)) throw new InputError("无测试须写原因");
  const limits = raw.limits === undefined ? {} : object(raw.limits, "limits");
  if (!only(limits, ["开发评审","测试","验收","部署"])) throw new InputError("limits 有未知字段");
  const effectiveLimits = { 测试: limit(limits.测试, { maxRepairs: 3, timeoutMin: 20 }), 开发评审: limit(limits.开发评审, { maxRepairs: 4, timeoutMin: 60 }), 部署: limit(limits.部署, { maxRepairs: 2, timeoutMin: 20 }) };
  const hookBudgetSec = (effectiveLimits.测试.timeoutMin + effectiveLimits.开发评审.timeoutMin) * 60 + HOOK_OVERHEAD_SEC;
  if (host !== "pi" && hookBudgetSec > HOOK_TIMEOUT_SEC) throw new UnsupportedError(
    host + " Stop hook 外层时限为 " + HOOK_TIMEOUT_SEC + " 秒；复测和评审合计加 " + HOOK_OVERHEAD_SEC +
    " 秒余量需要 " + hookBudgetSec + " 秒，不支持此配置。请降低两项 timeoutMin 合计至 " +
    ((HOOK_TIMEOUT_SEC - HOOK_OVERHEAD_SEC) / 60) + " 分钟以内，或改用 pi。");
  return { version: 1, name: text(raw.name, "name"), base, target: "dev", host, flow: raw.flow, after: raw.flow.filter((s: string) => order.indexOf(s) >= 2),
    ...(raw.next !== undefined ? { next: reference(raw.next, file, repo, "next") } : {}),
    tasks: [{ name, prompt: reference(task.prompt, file, repo, "prompt"), scope: parseScope(task.scope), test }],
    ...(raw.acceptance ? { acceptance: reference(raw.acceptance, file, repo, "acceptance") } : {}),
    limits: effectiveLimits };
}
export function readCard(file: string) {
  try {
    file = realpathSync(file); const repo = realpathSync(repoRoot(dirname(file))), content = readFileSync(file, "utf8");
    return { file, repo, card: parseDevelopmentCard(content, file, repo), cardHash: digest(content) };
  } catch (e) { if (e instanceof InputError) throw e; throw new InputError(e instanceof Error ? e.message : String(e)); }
}
