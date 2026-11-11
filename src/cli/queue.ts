import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { lock, BusyError } from "../infra/files.ts";
import { projectFile } from "../infra/project.ts";
import { taskOf, statusOf, update } from "../core/store.ts";
export async function queued<T>(dir: string, action: () => Promise<T> | T, cancellable = false): Promise<T | undefined> {
  const t = taskOf(dir), path = projectFile(dirname(dir),t.repo,"queue");
  const timer = setInterval(() => { update(dir, () => {}); }, 60000);
  let release: (() => void) | undefined;
  try {
    for (;;) {
      if (cancellable && statusOf(dir).state === "cancelled") return;
      try { release = lock(path); break; }
      catch (e) { if (!(e instanceof BusyError)) throw e; }
      update(dir, s => { if (s.state !== "cancelled") s.message = "排队中，等待同项目的收尾、合入、部署或退回"; });
      await setTimeout(1000);
    }
    if (!cancellable || statusOf(dir).state !== "cancelled") return await action();
  } finally { clearInterval(timer); release?.(); }
}
