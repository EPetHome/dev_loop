import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { APP_ROOT } from "../infra/paths.ts";
import { jsonLines } from "../infra/files.ts";
import { run } from "./run.ts";
import { parseReview } from "./review-parse.ts";
import { statusOf, type Task } from "./store.ts";
const overflow = /\bcontext_length_exceeded\b|\bprompt(?: is| was)? too long\b|\bexceed(?:s|ed|ing)? (?:the )?(?:model.s )?(?:maximum )?context (?:window|length|limit)\b|\b(?:maximum context length is \d+|context (?:window|length|limit) (?:has been |was |is )?exceeded)\b|\binput token count\s*\([\d,]+\)\s*exceeds the maximum number of tokens allowed\s*\([\d,]+\)/i;
function contextError(dir: string, id: string) {
  try {
    const file = readdirSync(dir).find(name => name.endsWith("_" + id + ".jsonl"));
    if (!file) return;
    const path = join(dir, file), records = jsonLines<{type: string; id?: string; message?: {role: string; stopReason?: string; errorMessage?: string}}>(path);
    if (records[0]?.type !== "session" || records[0].id !== id) return;
    const end = records.findLast(entry => entry.type === "message" && entry.message?.role === "assistant")?.message;
    if (end?.stopReason === "error" && typeof end.errorMessage === "string" && overflow.test(end.errorMessage)) return {raw: end.errorMessage, path};
  } catch {} // 未写出可读会话时，按调用结果走普通重试。
}
export async function executeStaticReview(t: Task, round: number, input: string, timeoutMs: number, signal?: AbortSignal) {
  const inputPath = join(t.dir, "review-input-r" + round + ".md"), evidence: string[] = [];
  writeFileSync(inputPath, input);
  const keep = (path: string, text: string) => { writeFileSync(path,text); evidence.push(path); };
  const deadline = Date.now() + timeoutMs; let rawError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (statusOf(t.dir).state === "cancelled") return { error: "已停止", evidence };
    const remaining = deadline - Date.now(), session = randomUUID();
    if (remaining <= 0) { rawError += "\n评审每轮时限已用完，无法再次调用"; break; }
    const sessionDir = join(t.dir, "review-sessions", session), cmd = t.config.reviewerCmd;
    const args = cmd ? [String(round), inputPath, session] : ["--offline", "-p", "--session-id", session, "--session-dir", sessionDir,
      "--model", t.config.reviewerModel, "--thinking", t.config.reviewerThinking, "--no-extensions", "--no-mcp",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,grep,find,ls",
      "--append-system-prompt", join(APP_ROOT, "src/core/review-prompt.md"), "@" + inputPath];
    try {
      mkdirSync(sessionDir, {recursive: true});
      const command = cmd ? resolve(t.worktree, cmd) : process.env.PI_BIN || "/Users/Admin/.local/bin/pi";
      const result = await run(t, command, args, remaining, signal, {LOOP_REVIEW_SESSION_DIR: sessionDir});
      keep(join(t.dir,"review-"+statusOf(t.dir).loop.commit+"-r"+round+"-a"+attempt+".md"), result.stdout+(result.stderr?"\n"+result.stderr:""));
      const ending = contextError(sessionDir, session);
      if (ending) return {error: ending.raw, contextOverflow: true, evidence: [...evidence, ending.path]};
      const parsed = parseReview(result.stdout);
      if (!result.killed && result.code === 0 && parsed.ok) return { review: parsed.review, evidence };
      rawError += "\n第 " + attempt + " 次：退出码 " + result.code + (result.killed ? "（超时或取消）" : "") +
        "\n" + result.output + (parsed.ok ? "" : "\n" + parsed.error);
    } catch (e) {
      rawError += "\n" + (e instanceof Error ? e.message : String(e));
      keep(join(t.dir,"review-error-r"+round+"-a"+attempt+".log"), rawError);
    }
  }
  return { error: rawError, evidence };
}
