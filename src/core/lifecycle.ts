import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitText, head, changes } from "../infra/git.ts";
import { inside } from "../infra/config.ts";
import { lock } from "../infra/files.ts";
import { alive, signalProcess, identity } from "../infra/exec.ts";
import { taskOf, statusOf, update, transition, appendCheck, inputs, checked, type Status } from "./store.ts";
import { operationPath, run } from "./run.ts";
export async function prepare(dir: string): Promise<void> {
  const release = lock(operationPath(dir), 2000), t = taskOf(dir), start = Date.now();
  try {
    if (statusOf(dir).state === "cancelled") return;
    if (!statusOf(dir).loop.prepared) {
      if (!existsSync(join(t.worktree, ".git"))) gitText(t.repo, ["worktree", "add", "-b", t.branch, t.worktree, t.baseCommit]);
      for (const path of t.config.localFiles) {
        const source = resolve(t.repo, path), dest = resolve(t.worktree, path);
        if (!existsSync(source)) throw new Error("localFiles 不存在：" + source);
        mkdirSync(dirname(dest), { recursive: true });
        if (!inside(realpathSync(t.worktree), realpathSync(dirname(dest)))) throw new Error("localFiles 目标越出 worktree：" + path);
        cpSync(source, dest, { recursive: true, dereference: false, force: true });
      }
      update(dir, (s) => { s.loop.prepared = true; });
    }
    if (t.config.setup && !statusOf(dir).loop.ready) {
      update(dir, (s) => { s.timeLimitSec = t.limits.测试.timeoutMin * 60; });
      const result = await run(t, "sh", ["-c", t.config.setup], t.limits.测试.timeoutMin * 60000);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "setup.log"), result.output);
      if (statusOf(dir).state === "cancelled") return;
      if (result.code !== 0) throw new Error("setup 失败（可修正环境后续跑）\n" + result.output);
    }
    if (statusOf(dir).state === "cancelled") return;
    const h = inputs(t);
    appendCheck(dir, { promptHash: h.promptHash, acceptanceHash: h.acceptanceHash, commit: t.baseCommit, tree: gitText(t.worktree, ["rev-parse", "HEAD^{tree}"]),
      step: "dev-loop 自身", result: "就绪", startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - start, evidence: t.config.setup ? [join(dir, "setup.log")] : [] });
    update(dir, (s) => { s.loop.ready = true; });
    transition(dir, "working", "开发中", "工作区已就绪，等待开发会话", "developmentMs");
  } finally { release(); }
}
export function registerSession(dir: string, host: string, id: string, pid = process.pid, file?: string): boolean {
  let registered = false;
  update(dir, (s) => {
    if (s.state === "cancelled" || s.loop.abandoned) return;
    const p = identity(pid), starting = s.loop.startingSession;
    if (!p.startedAt) throw new Error("无法读取开发会话进程身份：" + pid);
    if (starting && (starting.pid !== p.pid || starting.startedAt !== p.startedAt)) return;
    s.loop.session = { ...p, host, id, ...(file ? { file } : {}) };
    s.loop.startingSession = null; registered = true;
  });
  return registered;
}
export function heartbeat(dir: string, now = Date.now(), throttled = false): void {
  const s = statusOf(dir);
  if (s.state !== "working" || (throttled && now - Date.parse(s.updatedAt) < 60000)) return;
  update(dir, () => {});
}
export function shutdownSession(dir: string): void {
  update(dir, (s) => {
    if (s.loop.session) s.loop.session.endedAt = new Date().toISOString();
    if (s.loop.bucket === "developmentMs") s.loop.bucket = null;
  });
}
export function resume(dir: string): {reused: boolean; running: boolean; status: Status} {
  const t = taskOf(dir), s = statusOf(dir);
  if (s.loop.abandoned) throw new Error("已放弃并删除 worktree，不能续跑；请重新启动卡");
  if (alive(s.loop.startingSession) || alive(s.loop.activeProcess) || alive(s.loop.launcher)) throw new Error("执行正在准备或检查，请先停止再续跑");
  const running = alive(s.loop.session) && !s.loop.session?.endedAt;
  if (s.loop.delivery && existsSync(t.worktree) && head(t.worktree) === s.loop.delivery.commit && !changes(t.worktree).length && checked(dir, s.loop.delivery.commit)) {
    update(dir, (s) => { s.state = "working"; s.loop.reused = true; });
    return { reused: true, running: Boolean(running), status: transition(dir, "completed", "完成", "沿用此 commit 的复测与评审通过记录", null) };
  }
  if (running && s.state !== "input_required") throw new Error("开发会话仍在运行；请在原会话继续或先停止");
  const startedAt = new Date(s.loop.stepStartedAt).toISOString();
  if (s.state === "input_required") appendCheck(dir, { commit: s.loop.commit || t.baseCommit, tree: s.loop.delivery?.tree || "",
    step: "等你", result: "已续跑", startedAt, endedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
    evidence: [], promptHash: inputs(t).promptHash, acceptanceHash: inputs(t).acceptanceHash });
  update(dir, (s) => {
    s.loop.testAllowance = Math.max(t.limits.测试.maxRepairs, s.loop.testReturns + 1);
    s.loop.reviewAllowance = Math.max(t.limits.开发评审.maxRepairs, s.loop.reviewReturns + 1); s.loop.warned = false; s.state = "working";
    s.loop.reused = false;
  });
  return { reused: false, running: Boolean(running), status: transition(dir, "working", "开发中", running ? "已续跑，请在原开发会话继续；到上限的步骤再给一轮" : "已续跑；到上限的步骤再给一轮", "developmentMs") };
}
export function stop(dir: string, abandon = false): Status {
  const t = taskOf(dir);
  // 取取消事务内的身份快照，不能先读状态再取消，否则会漏掉并发创建/登记的进程。
  const stopped = transition(dir, "cancelled", "已停止", abandon ? "已放弃，保留分支和证据" : "已停止；可续跑", null);
  signalProcess(stopped.loop.startingSession);
  signalProcess(stopped.loop.activeProcess, true); signalProcess(stopped.loop.launcher, true); signalProcess(stopped.loop.session);
  if (abandon) {
    const release = lock(operationPath(dir), 2000);
    try {
      if (existsSync(t.worktree)) gitText(t.repo, ["worktree", "remove", "--force", t.worktree]);
      rmSync(t.worktree, { recursive: true, force: true }); update(dir, (s) => { s.loop.abandoned = true; });
    } finally { release(); }
  }
  return abandon ? statusOf(dir) : stopped;
}
