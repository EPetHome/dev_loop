import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, watch, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTask, statusOf, type Task } from "../src/core/store.ts";
import { prepare } from "../src/core/lifecycle.ts";
import { signalProcess } from "../src/infra/exec.ts";
export const ROOT = resolve(import.meta.dirname, "..");
export const NODE = process.execPath;
export const PASS = "## 结论：通过\n## 必修\n无\n## 小问题\n- 建议示例\n## 需求疑问\n- 疑问示例\n## 上轮必修复查\n无\n";
export const MUST = "## 结论：需返修\n## 必修\n1. 位置：src/app.txt:1\n   触发：输入 bad 时\n   问题：返回错误结果\n   依据：需求 A1\n   建议：修正结果\n## 小问题\n- 不要退回此建议\n## 需求疑问\n- 不要退回此疑问\n## 上轮必修复查\n无\n";
export const getJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8"));
export const write = (p: string, s: string) => { mkdirSync(resolve(p, ".."), { recursive: true }); writeFileSync(p, s); };
export function fixture(t: {after: (f: () => any) => any}, options: {test?: string; reviewer?: string; config?: any; card?: any} = {}) {
  const base = mkdtempSync(join(tmpdir(), "dev-loop-test-")), repo = join(base, "repo with 空格"), root = join(base, "tasks");
  mkdirSync(repo); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "dev"); git("config", "user.name", "Loop Test"); git("config", "user.email", "loop-test@example.invalid");
  write(join(repo, "src/app.txt"), "good\n"); write(join(repo, "outside.txt"), "protected\n");
  write(join(repo, "prompt.md"), "实现 good；不要改 scope 外文件。\n");
  write(join(repo, "criteria.md"), "A1. 操作：读取 app\n预期：good\n");
  write(join(repo, "AGENTS.md"), "初始规则\n");
  write(join(repo, ".gitignore"), "dist/\nlocal.txt\n");
  write(join(repo, "local.txt"), "local secret fixture\n");
  const reviewer = options.reviewer || "printf '%s' " + sq(PASS);
  write(join(repo, "reviewer.sh"), '#!/bin/sh\nprintf "review\\n" >> "$LOOP_TASK_DIR/order"\n' + reviewer + "\n");
  execFileSync("chmod", ["+x", join(repo, "reviewer.sh")]);
  const command = options.test ?? 'printf "test\\n" >> "$LOOP_TASK_DIR/order"; if grep -q bad src/app.txt; then echo "Error: failed app"; echo "tail marker"; exit 1; fi';
  write(join(repo, ".autoreview.json"), JSON.stringify({ reviewerCmd: "./reviewer.sh", localFiles: ["local.txt"], ...options.config }));
  const raw = {version: 1, name: "one", nature: "开发", base: "dev", target: "dev", host: "pi",
    flow: ["开发评审", "测试"], tasks: [{name: "task", prompt: "prompt.md", scope: ["src/**"], test: command}],
    acceptance: "criteria.md", ...options.card};
  const card = join(repo, "card.json"); write(card, JSON.stringify(raw));
  git("add", "."); git("commit", "-m", "fixture");
  const launch = join(base, "fake-launch.cjs");
  write(launch, "#!" + NODE + "\nconst fs=require('fs'); fs.writeFileSync(process.env.LOOP_TASK_DIR+'/opened.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),task:process.env.LOOP_TASK_DIR}));\n");
  execFileSync("chmod", ["+x", launch]);
  const env = {...process.env, LOOP_TASK_DIR: undefined, LOOP_HOST: undefined, LOOP_TASKS_ROOT: root, LOOP_LAUNCH_CMD: launch, PATH: resolve(NODE, "..") + ":" + process.env.PATH};
  let task: Task | undefined;
  t.after(() => {
    if (existsSync(root)) for (const entry of execFileSync("ls", [root], {encoding:"utf8"}).trim().split("\n").filter(Boolean)) {
      try { const s = statusOf(join(root, entry)); signalProcess(s.loop.activeProcess, true); signalProcess(s.loop.launcher, true); } catch {}
    }
    rmSync(base, {recursive: true, force: true});
  });
  return {base, repo, root, card, raw, git, env,
    async prepare() { task = createTask(card, root); await prepare(task.dir); return task; },
    async cli(args: string[], cwd = repo, extraEnv: NodeJS.ProcessEnv = {}) {
      return promisify(execFile)(join(ROOT, "bin/loop"), args, {cwd, env: {...env, ...extraEnv}, timeout: 15000});
    }
  };
}
export const sq = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
/** 事件驱动地等文件/状态变化；只有总截止时间，没有固定 sleep。 */
export function until<T>(dir: string, get: () => T, ready: (v: T) => boolean): Promise<T> {
  return new Promise((accept, reject) => {
    const signal = AbortSignal.timeout(12000);
    let watcher: ReturnType<typeof watch>;
    const close = () => { watcher?.close(); signal.removeEventListener("abort", abort); };
    const check = () => {
      try { const value = get(); if (ready(value)) { close(); accept(value); } }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") { close(); reject(e); } }
    };
    const abort = () => { close(); reject(new Error("等待文件事件超时：" + dir)); };
    watcher = watch(dir, {recursive:true}, check); signal.addEventListener("abort", abort, {once:true}); check();
  });
}
