import { locate, fail, taskOf, statusOf, update, PHASES } from "../core/store.ts";
import { registerSession, heartbeat, shutdownSession } from "../core/lifecycle.ts";
import { settle } from "../core/settle.ts";
import { convention } from "./convention.ts";
import { alive } from "../infra/exec.ts";
import { contentText } from "./hook-event.ts";
import { startFinish } from "./after-settle.ts";
/** 只用 Pi 的公开生命周期子集；结构类型让核心测试不依赖 pi 包。 */
interface Context {
  cwd: string; signal?: AbortSignal; shutdown?(): void; hasUI?: boolean;
  ui?: { setStatus(key: string, text?: string): void; setTitle(title: string): void };
  sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined; getBranch(): any[] };
}
interface PiAPI {
  on(event: string, handler: (event: any, ctx: Context) => any): unknown;
  sendMessage(message: {customType: string; content: string; display: boolean}, options?: {triggerTurn: boolean}): void;
}
export function registerPi(pi: PiAPI, options: {
  env?: NodeJS.ProcessEnv;
  every?: (callback: () => void, ms: number) => any;
  clear?: (timer: any) => void;
} = {}) {
  let dir: string | undefined, timer: any, viewTimer: any, context: Context | undefined, name = "", last = "";
  const clear = options.clear || clearInterval;
  const refresh = () => {
    if (!dir) return;
    try {
      const s = statusOf(dir), phase = s.loop.phase, pending = s.loop.pendingReturn;
      if (pending && s.state === "working" && phase === "开发中" && !alive(s.loop.finisher)) {
        pi.sendMessage({customType:"dev-loop-return",content:pending,display:true},{triggerTurn:true});
        update(dir,s=>{if(s.loop.pendingReturn===pending)s.loop.pendingReturn=null;});
      }
      if (!context?.ui || context.hasUI === false) return;
      const extra = phase === "评审中" ? "第 " + s.loop.reviewRounds + " 轮" : phase === "等你" ? s.loop.wait || s.message.split("\n")[0].slice(0, 30)
        : phase === "失败" ? s.error?.category : PHASES.indexOf(phase) >= 10 ? s.message : "";
      const title = "【" + phase + "】" + name, text = "dev-loop" + title + (extra ? " · " + extra : "");
      if (text === last) return;
      context.ui.setStatus("dev-loop", text); context.ui.setTitle(title); last = text;
    } catch {} // 外部状态暂不可读时保留显示，不干扰会话。
  };
  pi.on("session_start", (_event, ctx) => {
    if (timer !== undefined) clear(timer); if (viewTimer !== undefined) clear(viewTimer);
    timer = viewTimer = undefined; context = ctx; last = "";
    dir = locate(ctx.cwd, options.env || process.env);
    if (!dir) return;
    if (!registerSession(dir, "pi", ctx.sessionManager.getSessionId(), process.pid, ctx.sessionManager.getSessionFile?.())) {
      dir = undefined; timer = undefined; ctx.shutdown?.(); return;
    }
    const taskDir = dir;
    timer = (options.every || setInterval)(() => {
      try { heartbeat(taskDir); } catch (e) { fail(taskDir, e); }
    }, 60000);
    timer?.unref?.();
    name = taskOf(dir).name; refresh();
    viewTimer = (options.every || setInterval)(refresh, 1000); viewTimer?.unref?.();
    pi.sendMessage({customType:"dev-loop-convention",content:convention(taskOf(dir)),display:true});
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!dir) return;
    const messages = event.context?.contextMessages || ctx.sessionManager.getBranch().map((e) => e.message).filter(Boolean);
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const result = await settle(dir, contentText(last?.content), ctx.signal);
    refresh();
    if (!result.continue) await startFinish(dir,options.env || process.env);
    if (result.continue) return {entries:[{type:"custom_message",customType:"dev-loop-return",content:result.reason,display:true}],continue:true};
  });
  pi.on("session_shutdown", () => {
    if (timer !== undefined) clear(timer); if (viewTimer !== undefined) clear(viewTimer); timer = viewTimer = undefined;
    if (context?.hasUI !== false) context?.ui?.setStatus("dev-loop", undefined);
    if (dir) shutdownSession(dir); dir = undefined; context = undefined;
  });
}
export default function (pi: PiAPI) { registerPi(pi); }
