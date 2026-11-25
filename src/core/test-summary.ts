import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Check } from "./store.ts";
import type { ExecResult } from "../infra/exec.ts";
import { stripVTControlCharacters } from "node:util";
export function legacyResult(command: string, log: string, run?: ExecResult) {
  const evidence=[log],detail="命令："+command; if (!run || run.code===0 && !run.killed) return {result:run?"通过":"没验证",evidence,detail};
  const lines = run.output.trimEnd().split(/\r?\n/);
  return {result:"失败",evidence,detail:[`复测失败${run.killed ? "（超时或取消）" : ""}，请修复后重新交付。`,detail,
    "输出最后 60 行：",...lines.slice(-60),"error/fail 行：",...lines.filter(s => /error|fail/i.test(s))].join("\n")};
}
const bytes = Buffer.byteLength;
export function clip(text: string, limit: number, tail = false): string {
  const b=Buffer.from(text); if (b.length<=limit) return text; let cut=tail ? b.length-limit+3 : limit-3;
  while ((b[cut] & 0xc0) === 0x80) cut += tail ? 1 : -1; // 不切断 UTF-8 字符
  return tail ? "…" + b.toString("utf8", cut) : b.toString("utf8", 0, cut) + "…";
}
export function testLogSummary(command: string, result: string, log: string, budget = 8192): string {
  let raw: Buffer | undefined; try { raw = readFileSync(log); } catch {} // 原文缺失不阻断补评审
  const lines = raw?.toString("utf8").trimEnd().split(/\r\n|\r|\n/).map(stripVTControlCharacters) ?? [], counts: Record<string,number> = {}, names = new Set<string>();
  for (const line of lines) {
    const count = /^(?:#|ℹ)\s+(pass|fail)\s+(\d{1,15})\s*$/.exec(line); if (count) counts[count[1]] = Number(count[2]);
    const maven = /^(?:\[(?:INFO|ERROR)\]\s+)?Tests run: (\d{1,15}), Failures: (\d{1,15}), Errors: (\d{1,15}), Skipped: (\d{1,15})\s*$/.exec(line);
    if (maven) { counts.fail = Number(maven[2])+Number(maven[3]); counts.pass = Number(maven[1])-counts.fail-Number(maven[4]); }
    const name = /^\s*not ok \d+ - (.+)$/.exec(line)?.[1] ?? /^\s*✖ (.+) \([\d.]+m?s\)\s*$/.exec(line)?.[1];
    if (name && names.size < 6 && !/\s+#\s*(?:TODO|SKIP)\b/i.test(name)) names.add(clip(name, 240));
  }
  const path = /[\r\n]/.test(log) ? JSON.stringify(log) : log;
  const header = [`命令：${clip(command, 1024)}`, `结果：${result}`, `通过数：${counts.pass ?? "未识别"}；失败数：${counts.fail ?? "未识别"}`,
    `失败测试名：${[...names].join("；") || (counts.fail === 0 ? "无" : "未识别")}`,
    `原文：${bytes(path) <= 4500 ? path : JSON.stringify(basename(log)) + "（相对执行目录）"}${raw ? `（${raw.length} 字节）` : "（复测原文缺失，字节数未知）"}`,
    "输出尾部（最多 20 行，超长截断）："].join("\n");
  const limit = Math.min(512, Math.floor((budget - bytes(header)) / 20) - 5); // 每行另有换行和四格缩进
  return limit < 3 ? clip(header,budget) : [header, ...lines.slice(-20).map(line => "    " + clip(line, limit, true))].join("\n");
}
export function reviewTestSummary(command: string, test: Check, history: Check[]) {
  const log = testLogSummary(command,test.result,test.evidence[0],test.attempt ? 4096 : 8192); if (!test.attempt) return log;
  const previous = history.filter(c => c.step === "复测" && c.result === "失败" && c.attempt).slice(-3);
  const one = (c: Check, budget: number) => clip(`${c.attempt} / ${c.commit}\n${c.evidence.slice(0,3).join("\n")}\n${c.detail || c.result}`,budget);
  return [log,"本轮 E2E：",one(test,2450),...previous.flatMap(c => ["历史失败：",one(c,500)])].join("\n");
}
