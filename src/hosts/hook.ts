import { locate, fail } from "../core/store.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { registerSession, heartbeat } from "../core/lifecycle.ts";
import { settle } from "../core/settle.ts";
import { sessionIdOf, lastAssistantMessage, type HookEvent } from "./hook-event.ts";
export async function handleHook(event: HookEvent, eventName = event.hook_event_name || "", env = process.env): Promise<string> {
  if (!["SessionStart", "PostToolUse", "Stop"].includes(eventName)) return "";
  const dir = locate(event.cwd || process.cwd(), env);
  if (!dir) return "";
  try {
    if (eventName === "SessionStart") {
      const host = event.host === "codex" || event.provider === "codex" || env.LOOP_HOST === "codex" ? "codex" : "claude";
      const pid = Number(event.session_pid || event.pid || process.ppid);
      if (!registerSession(dir, host, sessionIdOf(event), pid, event.transcript_path)) return "";
      return JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:
        "开发完成后请运行 " + APP_ROOT + "/bin/loop" + " 交付。聊天不改变检查结论。"}});
    }
    if (eventName === "PostToolUse") { heartbeat(dir, Date.now(), true); return ""; }
    heartbeat(dir);
    const r = await settle(dir, lastAssistantMessage(event));
    return r.continue ? JSON.stringify({decision:"block",reason:r.reason}) : "";
  } catch (e) {
    fail(dir, e);
    return JSON.stringify({systemMessage:"dev-loop 自身失败：" + (e instanceof Error ? e.message : String(e))});
  }
}
export async function hookMain(args = process.argv.slice(2)): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const result = await handleHook(JSON.parse(raw || "{}"), args[0]);
  if (result) process.stdout.write(result + "\n");
}
