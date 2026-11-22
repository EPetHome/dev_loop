import { locate, taskOf, statusOf, update, PHASES, appendWindowNote } from "../core/store.ts";
import { registerSession, heartbeat, shutdownSession } from "../core/lifecycle.ts";
import { settle } from "../core/settle.ts";
import { convention } from "./convention.ts";
import { alive } from "../infra/exec.ts";
import { contentText } from "./hook-event.ts";
import { startFinish } from "./after-settle.ts";
import { watchPiEditor, type EditorUI } from "./pi-editor.ts";
interface Context {
  cwd: string; signal?: AbortSignal; shutdown?(): void; hasUI?: boolean; mode?: string; isIdle?(): boolean;
  ui?: EditorUI & { setStatus(key: string, text?: string): void; setTitle(title: string): void };
  sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined; getBranch(): any[] };
}
interface PiAPI {
  on(event: string, handler: (event: any, ctx: Context) => any): unknown; getCommands?(): {name: string; source: string}[];
  sendMessage(message: {customType: string; content: string; display: boolean}, options?: {triggerTurn: boolean}): void;
}
type Options = {env?: NodeJS.ProcessEnv; every?: (fn: () => void, ms: number) => any; clear?: (timer: any) => void};
export function registerPi(pi: PiAPI, options: Options = {}) {
  let dir: string | undefined, context: Context | undefined, name = "", last = "", unwatch: (() => void) | undefined;
  const env = options.env || process.env, clear = options.clear || clearInterval, every = options.every || setInterval;
  const timers: any[] = [], repeat = (fn: () => void, ms: number) => { const timer = every(fn, ms); timer?.unref?.(); timers.push(timer); };
  const cleanup = () => { for (const timer of timers.splice(0)) clear(timer); unwatch?.(); unwatch = undefined; };
  const refresh = () => {
    if (!dir) return;
    try {
      const s = statusOf(dir), phase = s.loop.phase, pending = s.loop.pendingReturn;
      if (pending && s.state === "working" && phase === "开发中" && !alive(s.loop.finisher)) {
        // 重开的会话已在开场承载原话；这里只确认消费，不能再触发一次。
        if (!s.loop.pendingOpening) pi.sendMessage({customType:"dev-loop-return",content:pending,display:true},{triggerTurn:true});
        update(dir,s=>{if(s.loop.pendingReturn===pending){s.loop.pendingReturn=null;s.loop.pendingOpening=false;}});
      }
      if (!context?.ui || context.hasUI === false) return;
      const extra = phase === "评审中" ? "第 " + s.loop.reviewRounds + " 轮" : phase === "等你" ? s.loop.wait || s.message.split("\n")[0].slice(0, 30)
        : phase === "失败" ? s.error?.category : PHASES.indexOf(phase) >= 10 ? s.message : "";
      const title = `【${phase}】${name}`, text = "dev-loop" + title + (extra ? " · " + extra : "");
      if (text !== last) { context.ui.setStatus("dev-loop", text); context.ui.setTitle(title); last = text; }
    } catch {} // 外部状态暂不可读时保留显示，不干扰会话。
  };
  pi.on("session_start", (_event, ctx) => {
    cleanup(); context = ctx; last = "";
    const taskDir = dir = locate(ctx.cwd, env); if (!taskDir) return;
    const id = ctx.sessionManager.getSessionId(); if (!registerSession(taskDir, "pi", id, process.pid, ctx.sessionManager.getSessionFile?.())) { dir = undefined; ctx.shutdown?.(); return; }
    const task = taskOf(taskDir);
    if (task.host === "pi" && ctx.mode === "tui" && ctx.cwd === task.worktree && env.LOOP_PI_WINDOW_OWNER === `${process.ppid}:${id}`)
      unwatch = watchPiEditor(ctx, text => appendWindowNote(taskDir, text), name => pi.getCommands?.().some(c => c.name === name && c.source === "extension") === true);
    repeat(() => { try { heartbeat(taskDir); } catch (e) { console.error("心跳更新失败：", e); } }, 60000);
    name = task.name; refresh(); repeat(refresh, 1000);
    pi.sendMessage({customType:"dev-loop-convention",content:convention(task),display:true});
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!dir) return;
    const messages = event.context?.contextMessages || ctx.sessionManager.getBranch().map((e) => e.message).filter(Boolean);
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const result = await settle(dir, contentText(last?.content), {signal: ctx.signal, ending: last});
    refresh();
    if (result.continue) return {entries:[{type:"custom_message",customType:"dev-loop-return",content:result.reason,display:true}],continue:true};
    await startFinish(dir,env);
  });
  pi.on("session_shutdown", () => {
    cleanup(); if (context?.hasUI !== false) context?.ui?.setStatus("dev-loop", undefined);
    if (dir) shutdownSession(dir); dir = undefined; context = undefined;
  });
}
export default function (pi: PiAPI) { registerPi(pi); }
