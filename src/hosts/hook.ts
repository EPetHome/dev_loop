import { locate, fail, taskOf, statusOf, update, move } from "../core/store.ts";
import { convention } from "./convention.ts";
import { registerSession, heartbeat } from "../core/lifecycle.ts";
import { settle } from "../core/settle.ts";
import { startFinish } from "./after-settle.ts";
import { sessionIdOf, lastAssistantMessage, type HookEvent } from "./hook-event.ts";
/** 只有实际返回宿主的事件才确认交接；Stop 必须 block，不能只改状态冒充唤起。 */
function takeReturn(dir: string): string {
  if (!statusOf(dir).loop.pendingReturn) return "";
  let reason = "";
  update(dir, s => {
    if (!(s.state === "working" && s.loop.phase === "开发中") && !(s.state === "input_required" && s.loop.wait === "需手动接入会话")) return;
    reason = s.loop.pendingReturn || ""; if (!reason) return;
    s.loop.pendingReturn = null; move(s,"working","开发中","返修要求已通过 hook 交接。\n" + reason,"developmentMs");
  });
  return reason;
}
export async function handleHook(event: HookEvent, eventName = event.hook_event_name || "", env = process.env): Promise<string> {
  if (!["SessionStart", "PostToolUse", "Stop"].includes(eventName)) return "";
  const dir = locate(event.cwd || process.cwd(), env); if (!dir) return "";
  const block = (reason: string) => JSON.stringify({decision:"block",reason});
  try {
    if (eventName === "SessionStart") {
      const host = event.host === "codex" || event.provider === "codex" || env.LOOP_HOST === "codex" ? "codex" : "claude";
      const pid = Number(event.session_pid || event.pid || process.ppid);
      if (!registerSession(dir, host, sessionIdOf(event), pid, event.transcript_path)) return "";
      return JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:
        convention(taskOf(dir)) + "\n聊天不改变检查结论。\n" + takeReturn(dir)}});
    }
    if (eventName === "PostToolUse") {
      heartbeat(dir, Date.now(), true); const reason = takeReturn(dir);
      return reason ? JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:reason}}) : "";
    }
    heartbeat(dir); const pending = takeReturn(dir); if (pending) return block(pending);
    const r = await settle(dir, lastAssistantMessage(event)); if (r.continue) return block(r.reason);
    await startFinish(dir,env); return "";
  } catch (e) { fail(dir, e); return JSON.stringify({systemMessage:"dev-loop 自身失败：" + (e instanceof Error ? e.message : String(e))}); }
}
export async function hookMain(args = process.argv.slice(2)): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const result = await handleHook(JSON.parse(raw || "{}"), args[0]);
  if (result) process.stdout.write(result + "\n");
}
