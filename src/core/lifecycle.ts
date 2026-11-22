import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { gitText, head, changes } from "../infra/git.ts";
import { inside } from "../infra/config.ts";
import { lock, withLock, BusyError, appendJson, iso, span } from "../infra/files.ts";
import { onTaskBranch } from "./deliver.ts";
import { InputError } from "./card.ts";
import { alive, signalProcess, identity } from "../infra/exec.ts";
import { taskOf, statusOf, answersOf, update, move, appendCheck, recordStep, checksOf, inputs, checked, qualifiedTest, sameInputs, lastTest, matchesReviewRequest, ENV_WAIT, type Check, type Status, type Task } from "./store.ts";
import { clearCheck, operationPath, run } from "./run.ts";
export function copyLocalFiles(t: Task, cwd = t.worktree) {
  for (const path of t.config.localFiles) {
    const source = resolve(t.repo,path), dest = resolve(cwd,path); if (!existsSync(source)) throw new Error("localFiles 不存在："+source);
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
  const release = lock(operationPath(dir),2000), start = Date.now();
  try {
    const t = taskOf(dir), s = statusOf(dir); if (s.state === "cancelled" || s.loop.ready) return;
    if (!s.loop.prepared) {
      if (!existsSync(join(t.worktree, ".git"))) gitText(t.repo, ["worktree", "add", "-b", t.branch, t.worktree, t.baseCommit]);
      copyLocalFiles(t); update(dir, s => { s.loop.prepared = true; });
    }
    if (t.config.setup) { update(dir,s=>{s.timeLimitSec=t.limits.测试.timeoutMin*60;}); await setup(t,"setup.log"); }
    if (statusOf(dir).state === "cancelled") return;
    recordStep(dir,{...span(start),commit:t.baseCommit,step:"dev-loop 自身",result:"就绪",evidence:t.config.setup ? [join(dir,"setup.log")] : []});
    update(dir, s => { if (move(s,"working","开发中","工作区已就绪，等待开发会话","developmentMs")) s.loop.ready = true; });
  } finally { release(); }
}
export function registerSession(dir: string, host: string, id: string, pid = process.pid, file?: string): boolean {
  let registered = false; update(dir,s => {
    if (s.state === "cancelled" || s.loop.abandoned) return;
    const p = identity(pid), starting = s.loop.startingSession; if (!p.startedAt) throw new Error("无法读取开发会话进程身份："+pid);
    if (starting && (starting.pid !== p.pid || starting.startedAt !== p.startedAt)) return;
    s.loop.session = {...p,host,id,...(file?{file}:{})}; s.loop.startingSession = null; registered = true;
  }); return registered;
}
export function heartbeat(dir: string, now = Date.now(), throttled = false): void {
  const s = statusOf(dir); if (s.state !== "working" || (throttled && now - Date.parse(s.updatedAt) < 60000)) return;
  try { update(dir, () => {}); } catch (e) { if (!(e instanceof BusyError)) throw e; }
}
export const shutdownSession = (dir: string) => update(dir,({loop}) => {
  if (loop.session) loop.session.endedAt = iso(); if (loop.bucket === "developmentMs") loop.bucket = null;
});
/** 只复用同一交付、同一输入下的复测；检查失败记录仍须是最近一次核心检查。 */
export function retryReview(dir: string) {
  const t = taskOf(dir), s = statusOf(dir), commit = s.loop.delivery?.commit; if (!commit || !deliveryMatches(t,s)) return;
  const h = inputs(t), records = checksOf(dir), last = records.findLast(c => c.step === "复测" || c.step === "评审");
  if (last?.step !== "评审" || last.result !== "失败" || last.commit !== commit || !sameInputs(last,h)) return;
  const test = qualifiedTest(records,commit,h); return test?.attempt === last.attempt ? test : undefined;
}
export const recordedAttempt = ({loop}: Status, records: Check[]) => loop.retestAttempt && loop.delivery
  ? lastTest(records,loop.delivery.commit,c => c.attempt === loop.retestAttempt && c.tree === loop.delivery!.tree && c.result !== "已停止") : undefined;
export const deliveryMatches = (t: Task, s: Status) => Boolean(s.loop.delivery && existsSync(t.worktree) && onTaskBranch(t) && head(t.worktree) === s.loop.delivery.commit && !changes(t.worktree).length);
export const environmentMessage = ({loop,executionId}: Status, check?: Check, canAccept = false) =>
  `${ENV_WAIT}。尝试编号：${loop.retestAttempt || "无"}；缺项：${check?.missingScenarios?.join("、") || "无"}。\n` +
  `可选：bin/loop 续跑 ${executionId}（补跑）${canAccept ? ` / bin/loop 续跑 ${executionId} --接受环境缺项 ${check?.attempt}` : ""} / bin/loop 停止 ${executionId}。`;
export const environmentAcceptable = (c?: Check) => c?.result === "环境未验证" && c.unit === "通过" && !!c.missingScenarios?.length;
function claimRetest(t: Task, s: Status, text: string | undefined, accept: string | undefined) {
  const {state,loop} = s, waiting = loop.wait === ENV_WAIT, records = checksOf(t.dir), previous = recordedAttempt(s,records);
  const working = state === "working" && loop.retestAttempt && ["复测中","评审中"].includes(loop.phase);
  if (working && text !== undefined) throw new InputError(`复测尝试 ${loop.retestAttempt} 已认领；可不带话续跑以恢复检查，或停止。`);
  let h: ReturnType<typeof inputs> | undefined, pinned = false;
  try { h = inputs(t); pinned = deliveryMatches(t,s); }
  catch (e) { if (!waiting || (text === undefined && accept === undefined)) throw e; }
  const current = previous && h && sameInputs(previous,h), canAccept = waiting && current && pinned && environmentAcceptable(previous);
  if (waiting && text !== undefined || accept !== undefined && (!canAccept || accept !== previous?.attempt)) throw new InputError(environmentMessage(s,previous,canAccept));
  const recover = working || loop.retestAttempt && (state === "cancelled" || state === "failed" && !["临时故障","评审上下文超限"].includes(s.error?.category || ""));
  const last = lastTest(records,loop.commit), stale = h && last && !sameInputs(last,h) && (state === "completed" || loop.wait === "收尾没走完");
  if (text !== undefined || !pinned || !(waiting || recover || stale)) return;
  const reusable = current && (!waiting || previous.result !== "环境未验证" || accept) ? previous : undefined;
  const attempt = reusable?.attempt || (working && !previous && loop.phase === "复测中" && loop.retestAttempt) || randomUUID(), accepted = accept || reusable?.result === "本人接受环境缺项";
  const status = update(t.dir,next => {
    if (next.state !== state || next.loop.retestAttempt !== loop.retestAttempt || next.loop.delivery?.at !== loop.delivery?.at || alive(next.loop.launcher)) throw new InputError("现场已变化；请重新查询执行");
    if (accept && (!sameInputs(previous!,inputs(t)) || !deliveryMatches(t,next))) throw new InputError("提交或输入已变化；请重新查询执行");
    if (accept) { const now = Date.now(); appendCheck(t.dir,{...previous!,result:"本人接受环境缺项",...span(now,now)}); }
    next.state = "working"; next.loop.retestAttempt = attempt; // 只允许显式续跑解开已停止。
    move(next,"working","复测中",accepted ? "已登记本人接受环境缺项，等待后台评审" : "已领取后台复测："+attempt,"selfMs");
    if (s.state !== "working") next.loop.facts!.resumes++;
  }, accepted ? "本人接受环境缺项" : "续跑");
  return {reused:false,running:false,retest:attempt,status};
}
const requireNotReleasing = ({loop,executionId}: Status) => { if (loop.releasePending) throw new InputError(`工作区释放尚未结束；可运行 bin/loop ${loop.releasePending.auto ? "收尾" : "释放"} ${executionId} 补齐`); };
interface Resumed {reused: boolean; running: boolean; reviewOnly?: boolean; retest?: string; status: Status}
export function resume(dir: string, text?: string, answering = false, accept?: string): Resumed {
  const t = taskOf(dir); if (!t.e2e && accept !== undefined) throw new InputError("当前没有待处理的复测环境缺项");
  const action = () => resumeLocked(t,text,answering,accept); return t.e2e ? withLock(operationPath(dir),action,0) : action();
}
function resumeLocked(t: Task, text?: string, answering = false, accept?: string): Resumed {
  if ((text !== undefined || answering) && !text?.trim()) throw new InputError("话不能为空");
  const {dir} = t, s = statusOf(dir), {loop,state} = s, {reviewRequest} = loop;
  const requireResumable = (s: Status) => {
    if (answering && s.state !== "input_required") throw new InputError(`答复只在「等你」时接收；当前为「${s.loop.phase}」`);
    requireNotReleasing(s);
    if (s.loop.released || s.loop.abandoned) throw new Error((s.loop.released ? "工作区已释放" : "已放弃并删除 worktree")+"，不能续跑；请重新启动卡");
  }; requireResumable(s);
  if (loop.phase === "收尾中" || [loop.finisher,loop.startingSession,loop.launcher].some(alive) || !loop.retestAttempt && alive(loop.activeProcess)) throw new Error("执行正在准备或检查，请先停止再续跑");
  if (text === undefined && accept === undefined && reviewRequest && matchesReviewRequest(s,reviewRequest) && retryReview(dir))
    return {reused:false,running:false,reviewOnly:true,status:s};
  const retest = t.e2e && claimRetest(t,s,text,accept); if (retest) return retest;
  const running = alive(loop.session) && !loop.session?.endedAt, commit = loop.delivery?.commit, after = !!(t.after?.length || t.next), pending = after && loop.afterCommit !== commit;
  const reused = text === undefined && loop.wait !== "收尾没走完" && (!after || state === "completed" || pending) && !!(commit && deliveryMatches(t,s) && checked(dir,commit));
  const reviewOnly = !reused && text === undefined && state === "failed" && s.error?.category === "临时故障" && !!retryReview(dir);
  if (!reused && !reviewOnly && running && state !== "input_required") throw new Error("开发会话仍在运行；请在原会话继续或先停止");
  const status = update(dir,s => {
    requireResumable(s); s.loop.reused = reused; s.loop.facts!.resumes++;
    if (reused) {
      s.state = "working"; if (pending) s.loop.afterCommit = commit!;
      move(s,pending ? "working" : "completed",pending ? "收尾中" : ["等你","已停止"].includes(s.loop.phase) ? "完成" : s.loop.phase,"沿用此 commit 的复测与评审通过记录",pending ? "selfMs" : null); return;
    }
    if (reviewOnly) { if (move(s,"working","评审中","已续跑，后台只重做评审；若后台退出，可不带话续跑同一请求","selfMs")) s.loop.reviewRequest = randomUUID(); return; }
    if (s.state === "input_required") {
      const {prompt,acceptance,e2e,...hashes} = inputs(t);
      appendCheck(dir,{commit:s.loop.commit || t.baseCommit,tree:s.loop.delivery?.tree || "",step:"等你",result:"已续跑",evidence:[],...hashes,...span(s.loop.stepStartedAt)});
    }
    if (answering) { appendJson(join(dir, "answers.jsonl"), {at:iso(),text}); s.loop.answerCount = answersOf(dir).length; }
    if (text !== undefined) Object.assign(s.loop,{pendingReturn:[s.loop.pendingReturn,answering ? "本人答复："+text : text].filter(Boolean).join("\n\n"),pendingOpening:!running && t.host === "pi"});
    s.loop.testAllowance = Math.max(t.limits.测试.maxRepairs,s.loop.testReturns+1); s.loop.reviewAllowance = Math.max(t.limits.开发评审.maxRepairs,s.loop.reviewReturns+1); s.state = "working";
    const note = text !== undefined ? (t.host === "pi" ? "；话已写入待送" : "；未送达，需在窗口里说；下一次 hook 交接") : running ? "，请在原开发会话继续" : "";
    move(s,"working",s.loop.ready ? "开发中" : "准备中","已续跑" + note + "；到上限的步骤再给一轮","developmentMs");
  }, reused ? "沿用通过记录" : "续跑"); return {reused,running,...(status.loop.reviewRequest ? {reviewOnly:true} : {}),status};
}
export function stop(dir: string, abandon = false): Status {
  const t = taskOf(dir), stopped = update(dir,s=>{
    requireNotReleasing(s); if (s.loop.released) throw new InputError("工作区已释放，不能停止或放弃");
    move(s,"cancelled",abandon ? "已放弃" : "已停止",abandon ? "已放弃，保留分支和证据" : "已停止；可续跑",null);
  });
  const {startingSession,activeProcess,launcher,session} = stopped.loop;
  for (const [p,group] of [[startingSession,false],[activeProcess,true],[launcher,true],[session,false]] as const) signalProcess(p,group);
  if (!abandon) return stopped;
  return withLock(operationPath(dir),() => {
    clearCheck(t); if (existsSync(t.worktree)) gitText(t.repo,["worktree","remove","--force",t.worktree]);
    rmSync(t.worktree,{recursive:true,force:true}); return update(dir,s => { s.loop.abandoned = true; });
  });
}
