import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

const maxBytes = 8192, maxTailLines = 20;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
function clip(s: string, limit: number, tail = false): string {
  const b = Buffer.from(s);
  if (b.length <= limit) return s;
  if (limit < 3) return "";
  let cut = tail ? b.length - limit + 3 : limit - 3;
  // 不在 UTF-8 连续字节上截断，保留清楚的截断标记。
  while ((b[cut] & 0xc0) === 0x80) cut += tail ? 1 : -1;
  return tail ? "…" + b.toString("utf8", cut) : b.toString("utf8", 0, cut) + "…";
}

/** 正文只放复测摘要；原文原样保留，未知计数不按零填。 */
export function testLogSummary(command: string, result: string, log: string): string {
  let raw: Buffer | undefined;
  try { raw = readFileSync(log); } catch {} // 补评审可沿用记录，不要求证据文件仍在。
  const lines = raw?.toString("utf8").trimEnd().split(/\r\n|\n|\r/) || [];
  let pass: number | string | undefined, fail: number | string | undefined;
  const names = new Set<string>();
  for (const rawLine of lines) {
    const line = stripVTControlCharacters(rawLine);
    const tap = /^(?:#|ℹ)\s+(pass|fail)\s+(\d{1,15})\s*$/.exec(line);
    if (tap?.[1] === "pass") pass = tap[2];
    if (tap?.[1] === "fail") fail = tap[2];
    const maven = /^(?:\[(?:INFO|ERROR)\]\s+)?Tests run: (\d{1,15}), Failures: (\d{1,15}), Errors: (\d{1,15}), Skipped: (\d{1,15})\s*$/.exec(line);
    if (maven) {
      fail = Number(maven[2]) + Number(maven[3]);
      pass = Number(maven[1]) - fail - Number(maven[4]);
    }
    if (names.size >= 6) continue;
    const name = /^\s*not ok \d+ - (.+)$/.exec(line)?.[1] || /^\s*✖ (.+) \([\d.]+m?s\)\s*$/.exec(line)?.[1];
    if (name && !/\s+#\s*(?:TODO|SKIP)\b/i.test(name)) names.add(clip(name, 240));
  }
  const displayPath = /[\r\n]/.test(log) ? JSON.stringify(log) : log;
  const heading = [
    "命令：" + clip(command.replace(/[\r\n]+/g, "\\n"), 1024),
    "结果：" + result,
    "通过数：" + (pass ?? "未识别") + "；失败数：" + (fail ?? "未识别"),
    "失败测试名：" + ([...names].join("；") || (String(fail) === "0" ? "无" : "未识别")),
    "原文：" + (bytes(displayPath) <= 4500 ? displayPath : basename(log) + "（相对执行目录）") + (raw ? "（" + raw.length + " 字节）" : "（复测原文缺失，字节数未知）"),
    "输出尾部（最多 " + maxTailLines + " 行，超长截断）：",
  ].join("\n");
  let remaining = maxBytes - bytes(heading);
  const tail: string[] = [];
  for (const line of lines.slice(-maxTailLines).reverse()) {
    if (remaining < 8) break;
    const text = "    " + clip(stripVTControlCharacters(line), Math.min(512, remaining - 5), true);
    remaining -= bytes(text) + 1;
    tail.push(text);
  }
  return [heading, ...tail.reverse()].join("\n");
}
