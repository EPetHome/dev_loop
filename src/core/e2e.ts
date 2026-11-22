import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { inside, safeRelative } from "../infra/config.ts";
import { changedSince } from "../infra/git.ts";
import { errorText, readJson, readText, writeJson } from "../infra/files.ts";
import type { ExecResult } from "../infra/exec.ts";
import { checkId, matches, observed, noE2eCommand, type Scenario } from "./card.ts";
import type { Hashes, Task } from "./store.ts";
export function planE2e(t: Task, commit: string, attempt: string, hashes: Hashes, e2e: Scenario[]) {
  const dir = join(t.dir,"e2e",attempt), paths = changedSince(t.repo,t.baseCommit,commit);
  const scenarios = e2e.filter(s => !s.paths || s.paths.some(p => paths.some(file => matches(file,p))));
  mkdirSync(join(t.dir,"e2e"),{recursive:true}); mkdirSync(dir,{mode:0o700});
  const plan = {executionId:t.executionId,attempt,commit,...hashes,scenarios}; writeJson(join(dir,"plan.json"),plan); return {dir,plan};
}
function requireReport(value: unknown, reason: string) { if (!value) throw new Error(reason); }
function indexed(rows: any, expected: string[], label: string) {
  requireReport(Array.isArray(rows),label+"须为数组"); const found = new Map<string,any>();
  for (const row of rows) {
    const id = row?.id; requireReport(expected.includes(id),label+"多报编号："+JSON.stringify(id));
    requireReport(!found.has(id),label+"重复编号："+id); found.set(id,row);
  }
  return found;
}
export function e2eResult({dir,plan}: ReturnType<typeof planE2e>, command: string, run?: ExecResult) {
  const files = ["test.log","plan.json","result.json"].map(p => join(dir,p)), evidence = new Set(files.slice(0,2));
  const ids = plan.scenarios.map(s => s.id), missing = new Set(ids), notes: string[] = [], failures: string[] = [];
  const statuses = ["通过","失败","未验证"]; let unit: string | undefined, result = "失败";
  const owned = (name: unknown) => {
    if (!safeRelative(name)) throw new Error("证据路径越界或不合法："+JSON.stringify(name));
    const path = resolve(dir,name), real = realpathSync(path), stat = lstatSync(path);
    requireReport(inside(dir,real),"证据越出本次目录："+name);
    requireReport(stat.isFile() && stat.nlink === 1,"证据不是本次的普通文件："+name); return real;
  };
  const finish = () => ({result,unit,attempt:plan.attempt,missingScenarios:[...missing],evidence:[...evidence],
    detail:[`命令：${command}`,run && `退出码：${run.code}${run.killed ? "（超时或取消）" : ""}`,
      ids.length ? "本次选中："+ids.join("、") : "本次未选中 E2E 场景",...failures,...notes].filter(Boolean).join("\n")});
  if (!run) { result = "没验证"; unit = "未验证"; notes.push(noE2eCommand); return finish(); }
  try {
    requireReport(JSON.stringify(readJson(owned("plan.json"))) === JSON.stringify(plan),"项目改写了 plan.json");
    let report: any;
    try { const path = owned("result.json"); evidence.add(path); report = readJson(path); }
    catch (e) { throw new Error("result.json 无法读取："+errorText(e)); }
    for (const k of ["executionId","attempt","commit"] as const)
      requireReport(report?.[k] === plan[k],`result.json ${k} 不符：应为 ${plan[k]}，实得 ${JSON.stringify(report?.[k])}`);
    requireReport(statuses.includes(report.unit),"普通检查 unit 须为通过、失败或未验证"); unit = report.unit;
    (unit === "失败" ? failures : notes).push("普通检查："+unit);
    const scenarios = indexed(report.scenarios,ids,"场景");
    for (const {id,checks,dependencies} of plan.scenarios) {
      const scene = scenarios.get(id); requireReport(scene,"缺少场景："+id);
      const steps = indexed(scene.steps,checks.map(checkId),id+" 检查点"), incomplete = new Set<string>();
      for (const check of checks) {
        const name = checkId(check), step = steps.get(name), label = id+" / "+name;
        if (!step) { requireReport(incomplete.size,"缺少检查点："+label); continue; }
        const {actual,dependency,error,cause} = step, expected = typeof check === "string" ? undefined : check.expected;
        requireReport(statuses.includes(step.status) && observed(actual),label+"：缺少有效状态或实得值 actual");
        const status = step.status === "通过" && expected !== undefined && actual !== expected ? "失败" : step.status;
        if (!incomplete.has(status)) (status === "失败" ? failures : notes).push(
          `${label}：${status}${expected === undefined ? "" : "；预期："+JSON.stringify(expected)}；实得：${typeof actual === "string" ? actual : JSON.stringify(actual)}`);
        if (status !== "通过") incomplete.add(status);
        try {
          requireReport(Array.isArray(step.evidence) && step.evidence.length,"缺少证据");
          const paths: string[] = step.evidence.map(owned);
          requireReport(!paths.some(p => files.includes(p)),"计划、报告和命令日志不能作为检查点证据"); paths.forEach(p => evidence.add(p));
          if (status !== "未验证") continue;
          requireReport(cause === "外部环境" && dependencies?.includes(dependency) && typeof error === "string" && error.trim() && paths.some(p => readText(p).includes(error)),
            "缺少已声明外部依赖的前置诊断和原错"); notes.push(`${label}：外部依赖 ${dependency}\n${error}`);
        } catch (e) { throw new Error(`${label}：${errorText(e)}`); }
      }
      const status = statuses.find(k => incomplete.has(k)) || "通过";
      requireReport(scene.status === status,`${id}：场景状态 ${JSON.stringify(scene.status)} 与检查点结论 ${status} 不符`);
      if (status === "通过") missing.delete(id);
    }
    if (!failures.length) {
      const pass = !missing.size && unit === "通过" && run.code === 0, wait = missing.size > 0 && run.code === 75;
      requireReport(!run.killed && (pass || wait),"退出码、普通检查或场景结论不一致"); result = pass ? "通过" : "环境未验证";
    }
  } catch (e) { notes.unshift(errorText(e)); } return finish();
}
