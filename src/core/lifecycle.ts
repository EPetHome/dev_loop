import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitText, head, changes } from "../infra/git.ts";
import { inside } from "../infra/config.ts";
import { lock, withLock, BusyError, appendJson } from "../infra/files.ts";
import { InputError } from "./card.ts";
import { alive, signalProcess, identity } from "../infra/exec.ts";
import { taskOf, statusOf, answersOf, update, move, appendCheck, checksOf, inputs, checked, type Status, type Task } from "./store.ts";
import { clearCheck, operationPath, run } from "./run.ts";
export function copyLocalFiles(t: Task, cwd = t.worktree) {
  for (const path of t.config.localFiles) {
    const source = resolve(t.repo, path), dest = resolve(cwd, path);
    if (!existsSync(source)) throw new Error("localFiles 不存在：" + source);
    mkdirSync(dirname(dest), {recursive: true});
    if (!inside(realpathSync(cwd), realpathSync(dirname(dest)))) throw new Error("localFiles 目标越出 worktree：" + path);
    cpSync(source, dest, {recursive: true, dereference: false, force: true});
  }
}
export async function setup(t: Task, log: string, signal?: AbortSignal, timeoutMs = t.limits.测试.timeoutMin * 60000) {
  if (!t.config.setup) return;
  const result = await run(t, "sh", ["-c", t.config.setup], timeoutMs, signal);
  writeFileSync(join(t.dir, log), result.output);
  if ((result.code || result.killed) && statusOf(t.dir).state !== "cancelled") throw new Error("setup 失败"+(result.killed?"（超时或取消）":"（可修正环境后续跑）")+"\n"+result.output);
}
export async function prepare(dir: string): Promise<void> {
  const release = lock(operationPath(dir), 2000), t = taskOf(dir), start = Date.now();
  try {
    const s = statusOf(dir); if (s.state === "cancelled" || s.loop.ready) return;
    if (!s.loop.prepared) {
      if (!existsSync(join(t.worktree, ".git"))) gitText(t.repo, ["worktree", "add", "-b", t.branch, t.worktree, t.baseCommit]);
      copyLocalFiles(t); update(dir, s => { s.loop.prepared = true; });
    }
    if (t.config.setup) {
      update(dir, s => { s.timeLimitSec = t.limits.测试.timeoutMin * 60; }); await setup(t,"setup.log");
    }
    if (statusOf(dir).state === "cancelled") return;
    const {promptHash, acceptanceHash} = inputs(t);
    appendCheck(dir, {promptHash, acceptanceHash, commit: t.baseCommit, tree: gitText(t.worktree, ["rev-parse", "HEAD^{tree}"]),
      step: "dev-loop 自身", result: "就绪", startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - start, evidence: t.config.setup ? [join(dir, "setup.log")] : [] });
    update(dir, s => { if (move(s,"working","开发中","工作区已就绪，等待开发会话","developmentMs")) s.loop.ready = true; });
  } finally { release(); }
}
export function registerSession(dir: string, host: string, id: string, pid = process.pid, file?: string): boolean {
  let registered = false; update(dir, s => {
    if (s.state === "cancelled" || s.loop.abandoned) return;
    const p = identity(pid), starting = s.loop.startingSession;
    if (!p.startedAt) throw new Error("无法读取开发会话进程身份：" + pid);
    if (starting && (starting.pid !== p.pid || starting.startedAt !== p.startedAt)) return;
    s.loop.session = {...p,host,id,...(file?{file}:{})}; s.loop.startingSession = null; registered = true;
  }); return registered;
}
export function heartbeat(dir: string, now = Date.now(), throttled = false): void {
  const s = statusOf(dir); if (s.state !== "working" || (throttled && now - Date.parse(s.updatedAt) < 60000)) return;
  try { update(dir, () => {}); } catch (e) { if (!(e instanceof BusyError)) throw e; }
}
export function shutdownSession(dir: string): void { update(dir, s => {
  if (s.loop.session) s.loop.session.endedAt = new Date().toISOString();
  if (s.loop.bucket === "developmentMs") s.loop.bucket = null;
}); }
/** 只复用同一交付、同一输入下的复测；检查失败记录仍须是最近一次核心检查。 */
export function retryReview(dir: string) {
  const t = taskOf(dir), s = statusOf(dir), commit = s.loop.delivery?.commit;
  if (!commit || !existsSync(t.worktree) || head(t.worktree) !== commit || changes(t.worktree).length) return;
  const h = inputs(t), records = checksOf(dir), last = records.findLast(c => c.step === "复测" || c.step === "评审");
  const same = (c: typeof last) => c?.commit === commit && c.promptHash === h.promptHash && c.acceptanceHash === h.acceptanceHash;
  if (last?.step === "评审" && last.result === "失败" && same(last)) return records.findLast(c => c.step === "复测" && ["通过","没验证"].includes(c.result) && same(c));
}
function requireNotReleasing({loop,executionId}: Status) {
  if (loop.releasePending) throw new InputError("工作区释放尚未结束；可运行 bin/loop " + (loop.releasePending.auto ? "收尾 " : "释放 ") + executionId + " 补齐");
}
export function resume(dir: string, text?: string, answering = false): {reused: boolean; running: boolean; reviewOnly?: boolean; status: Status} {
  if ((text !== undefined || answering) && !text?.trim()) throw new InputError("话不能为空");
  const t = taskOf(dir), s = statusOf(dir);
  const requireResumable = (s: Status) => {
    if (answering && s.state !== "input_required") throw new InputError("答复只在「等你」时接收；当前为「" + s.loop.phase + "」");
    requireNotReleasing(s);
    if (s.loop.released || s.loop.abandoned) throw new Error((s.loop.released ? "工作区已释放" : "已放弃并删除 worktree") + "，不能续跑；请重新启动卡");
  }; requireResumable(s);
  if (s.loop.phase === "收尾中" || alive(s.loop.finisher) || alive(s.loop.startingSession) || alive(s.loop.activeProcess) || alive(s.loop.launcher)) throw new Error("执行正在准备或检查，请先停止再续跑");
  const running = alive(s.loop.session) && !s.loop.session?.endedAt, commit = s.loop.delivery?.commit, after = Boolean(t.after?.length || t.next), pending = after && s.loop.afterCommit !== commit;
  const reused = text === undefined && s.loop.wait !== "收尾没走完" && (!after || s.state === "completed" || pending) && Boolean(commit && existsSync(t.worktree) && head(t.worktree) === commit && !changes(t.worktree).length && checked(dir, commit));
  const reviewOnly = !reused && text === undefined && s.state === "failed" && s.error?.category === "临时故障" && Boolean(retryReview(dir));
  if (!reused && !reviewOnly && running && s.state !== "input_required") throw new Error("开发会话仍在运行；请在原会话继续或先停止");
  const status = update(dir, s => {
    requireResumable(s); s.loop.reused = reused;
    if (reused) {
      s.loop.facts!.resumes++; s.state = "working"; if (pending) s.loop.afterCommit = commit;
      move(s,pending ? "working" : "completed",pending ? "收尾中" : ["等你","已停止"].includes(s.loop.phase) ? "完成" : s.loop.phase,"沿用此 commit 的复测与评审通过记录",pending ? "selfMs" : null); return;
    }
    if (reviewOnly) { if (move(s,"working","评审中","已续跑，后台只重做评审","selfMs")) s.loop.facts!.resumes++; return; }
    if (s.state === "input_required") {
      const startedAt = new Date(s.loop.stepStartedAt).toISOString(), {promptHash,acceptanceHash} = inputs(t);
      appendCheck(dir,{commit:s.loop.commit || t.baseCommit,tree:s.loop.delivery?.tree || "",step:"等你",result:"已续跑",startedAt,endedAt:new Date().toISOString(),durationMs:Math.max(0,Date.now()-Date.parse(startedAt)),evidence:[],promptHash,acceptanceHash});
    }
    if (answering) { appendJson(join(dir, "answers.jsonl"), {at: new Date().toISOString(), text}); s.loop.answerCount = answersOf(dir).length; }
    if (text !== undefined) {
      s.loop.pendingReturn = [s.loop.pendingReturn, answering ? "本人答复：" + text : text].filter(Boolean).join("\n\n");
      s.loop.pendingOpening = !running && t.host === "pi";
    }
    s.loop.testAllowance = Math.max(t.limits.测试.maxRepairs, s.loop.testReturns + 1);
    s.loop.reviewAllowance = Math.max(t.limits.开发评审.maxRepairs, s.loop.reviewReturns + 1); s.loop.facts!.resumes++; s.state = "working";
    const note = text !== undefined ? (t.host === "pi" ? "；话已写入待送" : "；未送达，需在窗口里说；下一次 hook 交接") : running ? "，请在原开发会话继续" : "";
    move(s,"working",s.loop.ready ? "开发中" : "准备中","已续跑" + note + "；到上限的步骤再给一轮","developmentMs");
  }, reused ? "沿用通过记录" : "续跑"); return {reused,running,...(reviewOnly ? {reviewOnly} : {}),status};
}
export function stop(dir: string, abandon = false): Status {
  const t = taskOf(dir);
  const stopped = update(dir,s=>{
    requireNotReleasing(s); if (s.loop.released) throw new InputError("工作区已释放，不能停止或放弃");
    move(s,"cancelled",abandon ? "已放弃" : "已停止",abandon ? "已放弃，保留分支和证据" : "已停止；可续跑",null);
  });
  const {startingSession,activeProcess,launcher,session} = stopped.loop;
  signalProcess(startingSession); signalProcess(activeProcess,true); signalProcess(launcher,true); signalProcess(session);
  if (abandon) withLock(operationPath(dir), () => {
    clearCheck(t); if (existsSync(t.worktree)) gitText(t.repo, ["worktree", "remove", "--force", t.worktree]);
    rmSync(t.worktree, { recursive: true, force: true }); update(dir, (s) => { s.loop.abandoned = true; });
  });
  return abandon ? statusOf(dir) : stopped;
}
