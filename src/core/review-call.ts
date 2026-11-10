/** 从旧 staticReviewer/executeStaticReview 精简：新上下文、只读工具、限时、重试一次、保留原文。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { APP_ROOT } from "../infra/paths.ts";
import { run } from "./run.ts";
import { parseReview } from "./review-parse.ts";
import { statusOf, type Task } from "./store.ts";
export async function executeStaticReview(t: Task, round: number, input: string, timeoutMs: number, signal?: AbortSignal) {
  const inputPath = join(t.dir, "review-input-r" + round + ".md"), evidence: string[] = [];
  writeFileSync(inputPath, input);
  const deadline = Date.now() + timeoutMs;
  let rawError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (statusOf(t.dir).state === "cancelled") return { error: "已停止", evidence };
    const remaining = deadline - Date.now(), session = randomUUID();
    if (remaining <= 0) { rawError += "\n评审每轮时限已用完，无法再次调用"; break; }
    const cmd = t.config.reviewerCmd;
    const command = cmd ? isAbsolute(cmd) ? cmd : resolve(t.worktree, cmd) : process.env.PI_BIN || "/Users/Admin/.local/bin/pi";
    const args = cmd ? [String(round), inputPath, session] : ["--offline", "-p", "--session-id", session,
      "--model", t.config.reviewerModel, "--thinking", t.config.reviewerThinking, "--no-extensions", "--no-mcp",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,grep,find,ls",
      "--append-system-prompt", join(APP_ROOT, "src/core/review-prompt.md"), "@" + inputPath];
    try {
      const result = await run(t, command, args, remaining, signal);
      const path = join(t.dir, "review-" + statusOf(t.dir).loop.commit + "-r" + round + "-a" + attempt + ".md");
      writeFileSync(path, result.stdout + (result.stderr ? "\n" + result.stderr : "")); evidence.push(path);
      const parsed = parseReview(result.stdout);
      if (!result.killed && result.code === 0 && parsed.ok) return { review: parsed.review, evidence };
      rawError += "\n第 " + attempt + " 次：退出码 " + result.code + (result.killed ? "（超时或取消）" : "") +
        "\n" + result.output + (parsed.ok ? "" : "\n" + parsed.error);
    } catch (e) {
      rawError += "\n" + (e instanceof Error ? e.message : String(e));
      const path = join(t.dir, "review-error-r" + round + "-a" + attempt + ".log");
      writeFileSync(path, rawError); evidence.push(path);
    }
  }
  return { error: rawError, evidence };
}
