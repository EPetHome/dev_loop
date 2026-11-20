import { join, dirname } from "node:path";
import { APP_ROOT } from "../infra/paths.ts";
import { detach } from "../infra/exec.ts";
import { fail, type Task } from "../core/store.ts";
export async function background(t: Task, mode: "resume" | "review" | "handoff" | "finish" | {delivery: string} | "" = "") {
  const finish = mode === "finish", handoff = mode === "handoff";
  const flags = typeof mode === "object" ? ["--delivery", mode.delivery] : mode ? ["--" + mode] : [];
  const args = finish ? [join(APP_ROOT,"src/cli/main.ts"),"收尾",t.dir,"--auto","--json"] : [join(APP_ROOT,"src/hosts/launch.ts"),t.dir,...flags];
  try { await detach(process.execPath,args,join(t.dir,finish?"finish.log":"launcher.log"),t.repo,{...process.env,LOOP_TASK_DIR:t.dir,LOOP_TASKS_ROOT:dirname(t.dir)},handoff); }
  catch(e) { if (!handoff) fail(t.dir,e); throw e; } // 未领到的接力保留分配，下次收尾可补派。
}
