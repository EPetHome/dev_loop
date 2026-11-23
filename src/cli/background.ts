import { join, dirname } from "node:path";
import { APP_ROOT } from "../infra/paths.ts";
import { detach } from "../infra/exec.ts";
import { fail, matchesReviewRequest, type Task } from "../core/store.ts";
export async function background(t: Task, mode: "resume" | "handoff" | "finish" | {delivery: string} | {retest: string} | {review: string} | "" = "") {
  const finish = mode === "finish", handoff = mode === "handoff";
  const flags = typeof mode === "object" ? Object.entries(mode).flatMap(([name,id]) => ["--"+name,id]) : mode ? ["--"+mode] : [];
  const args = finish ? [join(APP_ROOT,"src/cli/main.ts"),"收尾",t.dir,"--auto","--json"] : [join(APP_ROOT,"src/hosts/launch.ts"),t.dir,...flags];
  try { await detach(process.execPath,args,join(t.dir,finish?"finish.log":"launcher.log"),t.repo,{...process.env,LOOP_TASK_DIR:t.dir,LOOP_TASKS_ROOT:dirname(t.dir)},handoff); }
  catch (e) { // 接力可补派；过期补评审的启动失败不覆盖新现场。
    if (!handoff) fail(t.dir,e,undefined,typeof mode === "object" && "review" in mode ? s => matchesReviewRequest(s,mode.review) : undefined); throw e;
  }
}
