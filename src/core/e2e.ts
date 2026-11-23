import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { inside, safeRelative } from "../infra/config.ts";
import { changedSince } from "../infra/git.ts";
import { errorText, readJson, writeJson } from "../infra/files.ts";
import type { ExecResult } from "../infra/exec.ts";
import { checkId, matches, observed, noE2eCommand, type Observation, type Scenario } from "./card.ts";
import type { Hashes, Task } from "./store.ts";
export function planIn<T>(dir: string, plan: T) {
  mkdirSync(dir,{mode:0o700});
  writeJson(join(dir,"plan.json"),plan);
  return {dir,plan};
}
export function planE2e(t: Task, commit: string, attempt: string, hashes: Hashes, e2e: Scenario[]) {
  const root = join(t.dir,"e2e"), paths = changedSince(t.repo,t.baseCommit,commit);
  const scenarios = e2e.filter(s => !s.paths || s.paths.some(p => paths.some(file => matches(file,p))));
  mkdirSync(root,{recursive:true});
  return planIn(join(root,attempt),{executionId:t.executionId,attempt,commit,...hashes,scenarios});
}
export function requireReport(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
type Binding = {executionId:string; attempt:string; commit:string};
const bind = (data: Partial<Binding>, plan: Binding, label: string) => (["executionId","attempt","commit"] as const).forEach(k =>
  requireReport(data?.[k] === plan[k],`${label} ${k} 不符：应为 ${plan[k]}，实得 ${JSON.stringify(data?.[k])}`));
const load = <T>(read: () => T, label: string) => { try { return read(); } catch (e) { throw new Error(`${label}：${errorText(e)}`); } };
export function evidenceFile(dir: string, name: unknown) {
  requireReport(safeRelative(name),"证据路径越界或不合法："+JSON.stringify(name));
  const path = resolve(dir,name), real = realpathSync(path), info = lstatSync(path);
  requireReport(inside(dir,real),"证据越出本次目录："+name);
  requireReport(info.isFile() && info.nlink === 1,"证据不是本次的普通文件："+name);
  return real;
}
export function boundReport<T>(dir: string, plan: Binding, evidence: Set<string>) {
  requireReport(JSON.stringify(readJson(evidenceFile(dir,"plan.json"))) === JSON.stringify(plan),"项目改写了 plan.json");
  const report = load(() => {
    const path = evidenceFile(dir,"result.json");
    evidence.add(path);
    return readJson<T & Partial<Binding>>(path);
  },"result.json 无法读取");
  bind(report,plan,"result.json");
  return report;
}
function indexed(rows: unknown, expected: string[], label: string) {
  requireReport(Array.isArray(rows),label+"须为数组");
  const found = new Map<string,any>();
  for (const row of rows) {
    requireReport(expected.includes(row?.id),label+"多报编号："+JSON.stringify(row?.id));
    requireReport(!found.has(row.id),label+"重复编号："+row.id);
    found.set(row.id,row);
  }
  return found;
}
export interface Measurement {status:string; actual:Observation}
export type ReportExit = Pick<ExecResult,"code"|"killed">;
export function e2eResult({dir,plan}: ReturnType<typeof planE2e>, command: string, run?: ReportExit, witness?: (target: Measurement) => void) {
  const files = ["test.log","plan.json","result.json"].map(p => join(dir,p)), evidence = new Set(files.slice(0,2));
  const ids = plan.scenarios.map(s => s.id), missing = new Set(ids), notes: string[] = [], failures: string[] = [];
  const statuses = ["通过","失败","未验证"];
  let unit: string | undefined, result = "失败", target: Measurement | undefined;
  const finish = () => ({result,unit,attempt:plan.attempt,missingScenarios:[...missing],evidence:[...evidence],
    detail:[`命令：${command}`,run && `退出码：${run.code}${run.killed ? "（超时或取消）" : ""}`,
      ids.length ? "本次选中："+ids.join("、") : "本次未选中 E2E 场景",...failures,...notes].filter(Boolean).join("\n")});
  if (!run) { result = "没验证"; unit = "未验证"; notes.push(noE2eCommand); return finish(); }
  try {
    const report = boundReport<{unit:string; scenarios:unknown}>(dir,plan,evidence);
    requireReport(statuses.includes(report.unit),"普通检查 unit 须为通过、失败或未验证");
    unit = report.unit; (unit === "失败" ? failures : notes).push("普通检查："+unit);
    const scenarios = indexed(report.scenarios,ids,"场景");
    for (const {id,checks,dependencies} of plan.scenarios) {
      const scene = scenarios.get(id); requireReport(scene,"缺少场景："+id);
      const steps = indexed(scene.steps,checks.map(checkId),id+" 检查点"), incomplete = new Set<string>();
      for (const [index,check] of checks.entries()) {
        const name = checkId(check), step = steps.get(name), label = id+" / "+name;
        if (!step) { requireReport(incomplete.size && index === steps.size,"缺少检查点："+label); break; }
        const {actual,dependency,error,cause} = step, expected = typeof check === "string" ? undefined : check.expected;
        requireReport(statuses.includes(step.status) && observed(actual),label+"：缺少有效状态或实得值 actual");
        if (witness) target = {status:step.status,actual};
        const status = step.status === "通过" && expected !== undefined && actual !== expected ? "失败" : step.status;
        if (!incomplete.has(status)) (status === "失败" ? failures : notes).push(
          `${label}：${status}${expected === undefined ? "" : "；预期："+JSON.stringify(expected)}；实得：${typeof actual === "string" ? actual : JSON.stringify(actual)}`);
        if (status !== "通过") incomplete.add(status);
        load(() => {
          requireReport(Array.isArray(step.evidence) && step.evidence.length,"缺少证据");
          const paths: string[] = step.evidence.map((p: unknown) => evidenceFile(dir,p));
          requireReport(!paths.some(p => files.includes(p)),"计划、报告和命令日志不能作为检查点证据"); paths.forEach(p => evidence.add(p));
          if (status !== "未验证") return;
          const probe = paths[step.evidence.indexOf(step.probe)], invalid = "前置探测须与已声明依赖、不可用结果、诊断和原错一致";
          requireReport(cause === "外部环境" && dependencies?.includes(dependency) && typeof error === "string" && error.trim() && probe,invalid);
          const proof = load(() => readJson<Binding & {dependency?: string; result?: string; error?: string}>(probe),`${invalid}；${step.probe} 不是探测记录：${error}`);
          bind(proof,plan,"前置探测"); requireReport(proof.dependency === dependency && proof.result === "不可用" && proof.error === error,invalid);
          notes.push(`${label}：外部依赖 ${dependency}\n${error}`);
        },label);
      }
      const status = statuses.find(k => incomplete.has(k)) || "通过";
      requireReport(scene.status === status,`${id}：场景状态 ${JSON.stringify(scene.status)} 与检查点结论 ${status} 不符`); if (status === "通过") missing.delete(id);
    }
    if (!failures.length) {
      const pass = !missing.size && unit === "通过" && run.code === 0, wait = missing.size > 0 && run.code === 75;
      requireReport(!run.killed && (pass || wait),"退出码、普通检查或场景结论不一致"); result = pass ? "通过" : "环境未验证";
    }
    if (unit === "通过" && target) witness?.(target);
  } catch (e) { notes.unshift(errorText(e)); }
  return finish();
}
