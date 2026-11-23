import { join, dirname } from "node:path";
import { APP_ROOT } from "../infra/paths.ts";
import { detach } from "../infra/exec.ts";
import { span } from "../infra/files.ts";
import { statusOf, taskOf, checksOf, recordStep } from "../core/store.ts";
const worker = (dir: string, command: string, log: string, env: NodeJS.ProcessEnv) =>
  detach(join(APP_ROOT,"bin/loop"),[command,dir,...(command === "收尾" ? ["--auto"] : []),"--json"],join(dir,log),taskOf(dir).repo,
    {...process.env,...env,LOOP_TASK_DIR:dir,LOOP_TASKS_ROOT:dirname(dir)});
export async function startFinish(dir: string, env = process.env): Promise<void> {
  const {phase,finisher} = statusOf(dir).loop; if (phase === "收尾中" && !finisher) await worker(dir,"收尾","finish.log",env);
}
export async function startCompanion(dir: string, env = process.env): Promise<void> {
  if (taskOf(dir).e2e || checksOf(dir).some(c=>c.step==="陪跑"))return;
  try { await worker(dir,"陪跑","companion.log",env); }
  catch (e) { const at = Date.now(); recordStep(dir,{step:"陪跑",result:"失败",commit:taskOf(dir).baseCommit,...span(at,at),evidence:[],detail:String(e)}); }
}
