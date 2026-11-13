import { spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { optionalJson, writeJson } from "./files.ts";
import { alive, identity, type Identity } from "./exec.ts";
interface Lease extends Identity { renewAt: number }
/** 调用方持有状态锁。120秒租约由60秒心跳续期；崩溃后无须清理进程或系统设置。 */
export function idleSleep(dir: string, working: boolean, now = Date.now(), env = process.env): void {
  if (process.platform !== "darwin" && !env.LOOP_CAFFEINATE_CMD) return;
  const file = join(dir, "idle-sleep.json");
  const warn = (e: unknown) => { try { appendFileSync(join(dir, "idle-sleep.log"), String(e) + "\n"); } catch {} };
  const release = (lease?: Lease) => { if (alive(lease)) { try { process.kill(lease!.pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") warn(e); } } };
  try {
    const previous = optionalJson<Lease>(file);
    if (!working) { release(previous); if (previous) rmSync(file, {force: true}); return; }
    if (previous && now < previous.renewAt && now >= previous.renewAt - 60000) return;
    const child = spawn(env.LOOP_CAFFEINATE_CMD || "/usr/bin/caffeinate", ["-i", "-t", "120"], {
      env: {...env, LOOP_TASK_DIR: dir}, detached: true, stdio: "ignore",
    });
    child.once("error", warn); child.unref();
    writeJson(file, {...(child.pid ? identity(child.pid) : {pid: 0, startedAt: ""}), renewAt: now + 60000});
    release(previous);
  } catch (e) { warn(e); } // 防睡不可用只留原文，不增加任务拒绝点。
}
