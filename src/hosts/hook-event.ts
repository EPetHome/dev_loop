/** 从旧 sessionIdOf/lastAssistantMessage 精简，兼容 Claude/Codex 的 JSONL 消息。 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
export type HookEvent = Record<string, any>;
export const sessionIdOf = (event: HookEvent): string => event.session_id?.trim() ||
  (event.transcript_path ? basename(event.transcript_path).replace(/\.[^.]*$/, "") : "unknown");
export const contentText = (content: any): string => typeof content === "string" ? content : Array.isArray(content) ?
  content.flatMap(b => typeof b?.text === "string" ? [b.text] : []).join("\n") : "";
export function lastAssistantMessage(event: HookEvent): string {
  if (typeof event.last_assistant_message === "string" && event.last_assistant_message.trim()) return event.last_assistant_message;
  if (!event.transcript_path) return "";
  let lines: string[];
  try { lines = readFileSync(event.transcript_path, "utf8").trimEnd().split(/\r?\n/); } catch { return ""; }
  for (const line of lines.reverse()) {
    let record: any; try { record = JSON.parse(line); } catch { continue; }
    for (const m of [record, record.payload, record.message]) if (m?.role === "assistant") {
      const text = contentText(m.content); if (text) return text;
    }
  }
  return "";
}
