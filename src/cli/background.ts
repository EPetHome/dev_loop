import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { APP_ROOT } from "../infra/paths.ts";
import { fail, type Task } from "../core/store.ts";
export async function background(t: Task, resuming: boolean | "review" = false, finishing = false): Promise<void> {
  const fd = openSync(join(t.dir,finishing?"finish.log":"launcher.log"),"a");
  try {
    const args=finishing?[join(APP_ROOT,"src/cli/main.ts"),"收尾",t.dir,"--auto","--json"]:[join(APP_ROOT,"src/hosts/launch.ts"),t.dir,...(resuming === "review" ? ["--review"] : resuming ? ["--resume"] : [])];
    const child = spawn(process.execPath,args,
      {cwd:t.repo,env:{...process.env,LOOP_TASK_DIR:t.dir,LOOP_TASKS_ROOT:dirname(t.dir)},detached:true,stdio:["ignore",fd,fd]});
    await new Promise<void>((ok,no)=>{child.once("spawn",ok);child.once("error",no);}); child.unref();
  } catch(e) { fail(t.dir,e); throw e; } finally { closeSync(fd); }
}
