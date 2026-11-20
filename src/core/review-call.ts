/** 从旧 staticReviewer/executeStaticReview 精简：新上下文、只读工具、限时、重试一次、保留原文。 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { APP_ROOT } from "../infra/paths.ts";
import { run } from "./run.ts";
import { parseReview } from "./review-parse.ts";
import { statusOf, type Task } from "./store.ts";

const overflow = /\bcontext_length_exceeded\b|\bprompt(?: is| was)? too long\b|\bexceed(?:s|ed|ing)? (?:the )?(?:model.s )?(?:maximum )?context (?:window|length|limit)\b|\b(?:maximum context length is \d+|context (?:window|length|limit) (?:has been |was |is )?exceeded)\b/i;
/** 只看本次调用独占的目录及匹配 ID 的会话最后一条助手消息，不从评审正文猜错因。 */
function contextError(dir: string, id: string): {raw: string; path: string} | undefined {
  for (const file of readdirSync(dir, {withFileTypes: true})) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const path = join(dir, file.name);
    try {
      const [first, ...lines] = readFileSync(path, "utf8").split("\n");
      const header = JSON.parse(first);
      if (header?.type !== "session" || header.id !== id) continue;
      for (const line of lines.reverse()) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const message = entry?.message;
        if (entry?.type !== "message" || message?.role !== "assistant") continue;
        if (message.stopReason === "error" && typeof message.errorMessage === "string" && overflow.test(message.errorMessage)) {
          return {raw: message.errorMessage, path};
        }
        break;
      }
    } catch {} // 会话可能根本未能写出；评审失败仍走原调用结果。
  }
}
export async function executeStaticReview(t: Task, round: number, input: string, timeoutMs: number, signal?: AbortSignal) {
  const inputPath = join(t.dir, "review-input-r" + round + ".md"), evidence: string[] = [];
  writeFileSync(inputPath, input);
  const deadline = Date.now() + timeoutMs;
  let rawError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (statusOf(t.dir).state === "cancelled") return { error: "已停止", evidence };
    const remaining = deadline - Date.now(), session = randomUUID();
    if (remaining <= 0) { rawError += "\n评审每轮时限已用完，无法再次调用"; break; }
    const sessionDir = join(t.dir, "review-sessions", session);
    const cmd = t.config.reviewerCmd;
    const command = cmd ? isAbsolute(cmd) ? cmd : resolve(t.worktree, cmd) : process.env.PI_BIN || "/Users/Admin/.local/bin/pi";
    const args = cmd ? [String(round), inputPath, session] : ["--offline", "-p", "--session-id", session, "--session-dir", sessionDir,
      "--model", t.config.reviewerModel, "--thinking", t.config.reviewerThinking, "--no-extensions", "--no-mcp",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,grep,find,ls",
      "--append-system-prompt", join(APP_ROOT, "src/core/review-prompt.md"), "@" + inputPath];
    try {
      mkdirSync(sessionDir, {recursive: true});
      const result = await run(t, command, args, remaining, signal, {LOOP_REVIEW_SESSION_DIR: sessionDir});
      const path = join(t.dir, "review-" + statusOf(t.dir).loop.commit + "-r" + round + "-a" + attempt + ".md");
      writeFileSync(path, result.stdout + (result.stderr ? "\n" + result.stderr : "")); evidence.push(path);
      const ending = contextError(sessionDir, session);
      if (ending) return {error: ending.raw, contextOverflow: true, evidence: [...evidence, ending.path]};
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
