import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const tasksRoot = (env: NodeJS.ProcessEnv = process.env) => resolve(env.LOOP_TASKS_ROOT || resolve(homedir(), ".dev-loop/tasks"));
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export const entrypoint=resolve(APP_ROOT,"src/cli/main.ts");
export function wake(dir:string,env=process.env) {
  if (env.LOOP_WAKE==="manual") return;
  const p=spawn(process.execPath,[entrypoint,"tick","--all"],{
    detached:true,stdio:"ignore",env:{...env,LOOP_TASKS_ROOT:dirname(dir),LOOP_TASK_DIR:undefined,LOOP_ROLE:undefined,LOOP_JOB:undefined}
  });
  p.on("error",console.error); p.unref();
}
