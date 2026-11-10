import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const tasksRoot = (env: NodeJS.ProcessEnv = process.env) => resolve(env.LOOP_TASKS_ROOT || resolve(homedir(), ".dev-loop/tasks"));
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
