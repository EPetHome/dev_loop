import { locate, fail } from "../core/store.ts";
import { registerSession, heartbeat, shutdownSession } from "../core/lifecycle.ts";
import { settle } from "../core/settle.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { contentText } from "./hook-event.ts";
/** 只用 Pi 的公开生命周期子集；结构类型让核心测试不依赖 pi 包。 */
interface Context {
  cwd: string; signal?: AbortSignal; shutdown?(): void;
  sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined; getBranch(): any[] };
}
interface PiAPI {
  on(event: string, handler: (event: any, ctx: Context) => any): unknown;
  sendMessage(message: {customType: string; content: string; display: boolean}): void;
}
export function registerPi(pi: PiAPI, options: {
  env?: NodeJS.ProcessEnv;
  every?: (callback: () => void, ms: number) => any;
  clear?: (timer: any) => void;
} = {}) {
  let dir: string | undefined, timer: any;
  const clear = options.clear || clearInterval;
  pi.on("session_start", (_event, ctx) => {
    if (timer) clear(timer);
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
    pi.sendMessage({customType:"dev-loop-convention",content:"开发完成后运行 " + APP_ROOT + "/bin/loop 交付；会话停下后自动复测、评审。",display:true});
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!dir) return;
    const messages = event.context?.contextMessages || ctx.sessionManager.getBranch().map((e) => e.message).filter(Boolean);
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const result = await settle(dir, contentText(last?.content), ctx.signal);
    if (result.continue) return {entries:[{type:"custom_message",customType:"dev-loop-return",content:result.reason,display:true}],continue:true};
  });
  pi.on("session_shutdown", () => {
    if (timer) clear(timer); timer = undefined;
    if (dir) shutdownSession(dir); dir = undefined;
  });
}
export default function (pi: PiAPI) { registerPi(pi); }
