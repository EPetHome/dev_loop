import { spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { optionalJson, writeJson } from "./files.ts";
import { alive, identity, type Identity } from "./exec.ts";
interface Lease extends Identity { renewAt: number; owner?: Identity }
/** 调用方持有状态锁：有定时心跳用120秒租约；hook长调用绑定宿主进程，不新增监控进程。 */
export function idleSleep(dir: string, working: boolean, now = Date.now(), env = process.env, owner?: Identity): void {
  if (process.platform !== "darwin" && !env.LOOP_CAFFEINATE_CMD) return;
  const file = join(dir, "idle-sleep.json");
  const warn = (e: unknown) => { try { appendFileSync(join(dir, "idle-sleep.log"), String(e) + "\n"); } catch {} };
  const release = (lease?: Lease) => { if (alive(lease)) { try { process.kill(lease!.pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") warn(e); } } };
  try {
    const previous = optionalJson<Lease>(file); if (!working) { release(previous); if (previous) rmSync(file,{force:true}); return; }
    const attached = alive(owner) ? owner : undefined;
    const sameOwner = previous?.owner?.pid === attached?.pid && previous?.owner?.startedAt === attached?.startedAt;
    if (previous && sameOwner && ((attached && alive(previous)) || (now < previous.renewAt && now >= previous.renewAt - 60000))) return;
    const args = attached ? ["-i", "-w", String(attached.pid)] : ["-i", "-t", "120"];
    const child = spawn(env.LOOP_CAFFEINATE_CMD || "/usr/bin/caffeinate",args,{env:{...env,LOOP_TASK_DIR:dir},detached:true,stdio:"ignore"});
    child.once("error", warn); child.unref();
    writeJson(file, {...(child.pid ? identity(child.pid) : {pid: 0, startedAt: ""}), renewAt: now + 60000, ...(attached ? {owner: attached} : {})});
    release(previous);
  } catch (e) { warn(e); } // 防睡不可用只留原文，不增加任务拒绝点。
}
