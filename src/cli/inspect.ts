import { lstatSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { changes, gitText, gitTry, head, releaseChanges, worktreeOf } from "../infra/git.ts";
import { withLock, iso, span, readText, errorText } from "../infra/files.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { taskOf, statusOf, checksOf, lastTest, update, recordStep, inputs, sameInputs, ENV_WAIT, batchResult, type ReleasePending, type Status, type Task } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { onTaskBranch, undeliveredCommit, waitingForDelivery } from "../core/deliver.ts";
import { snapshot, differences } from "../core/snapshot.ts";
import { clearCheck, operationPath } from "../core/run.ts";
import { deliveryMatches, recordedAttempt, environmentAcceptable, environmentMessage } from "../core/lifecycle.ts";
export function publicStatus(dir: string) {
  const s = statusOf(dir), t = taskOf(dir), records = checksOf(dir), isWaiting = s.loop.wait === ENV_WAIT;
  const test = (isWaiting && recordedAttempt(s,records)) || lastTest(records,s.loop.commit); let stale = false, canAccept = false;
  if (test) try { stale = !sameInputs(test,inputs(t)); canAccept = isWaiting && test.attempt === s.loop.retestAttempt && !stale && environmentAcceptable(test) && deliveryMatches(t,s); }
  catch { stale = true; }
  const message = isWaiting ? [environmentMessage(s,test,canAccept),test?.detail].filter(Boolean).join("\n") : s.message;
  if (test) Object.assign(s.loop,{retest:{result:test.result,commit:test.commit,attempt:test.attempt,missingScenarios:test.missingScenarios || [],canAccept,stale,detail:test.detail,evidence:test.evidence}});
  s.message = message+(stale ? "\n当前输入已变化或不可读，原复测结论不再算数。" : "");
  if (waitingForDelivery(s)) try {
    const commit = head(t.worktree);
    if (onTaskBranch(t) && undeliveredCommit(t,s,commit) && !changes(t.worktree).length)
      Object.assign(s.loop,{deliveryConfirmation:{label:"用当前提交交付",commit,command:`${APP_ROOT}/bin/loop 续跑 ${t.executionId} --交付提交 ${commit}`}});
  } catch {} // Git 现场不可读时不声称可确认。
  return s;
}
export async function comparison(dir: string, other?: string) {
  const deployed = (d: string) => checksOf(d).findLast(c => c.step === "部署" && c.result.startsWith("已部署"));
  const t=taskOf(dir), first=deployed(dir), second=other && deployed(other), report=join(dir,`comparison-${Date.now()}.md`); let text="没有基线";
  if(first && (!other || second)) {
    const current = second ? join(second.evidence[1],"snapshot-after.json") : join(dir,"snapshot-live-"+Date.now()+".json");
    if (!other) await checkout(t.repo,first.commit,cwd => snapshot(t,cwd,first.commit,current,"live"));
    text=differences(join(first.evidence[1],"snapshot-after.json"),current);
  }
  writeFileSync(report,"# 运行差异\n\n"+text+"\n"); return {report,diff:text};
}
const gitDirOf = (worktree: string) => gitText(worktree,["rev-parse","--absolute-git-dir"]);
const gitFileOf = (gitDir: string) => resolve(gitDir,readText(join(gitDir,"gitdir")).trimEnd());
function gitDirIdentity(gitDir: string) { const s = lstatSync(gitDir,{bigint:true,throwIfNoEntry:false}); return s && `${s.dev}:${s.ino}:${s.birthtimeNs}`; }
function releaseTarget({repo,branch,worktree}: Task, expected?: ReleasePending["target"]) {
  const holder = worktreeOf(repo,branch), local = lstatSync(worktree,{throwIfNoEntry:false}), marker = join(worktree,".git");
  if (!local && expected && (!holder || holder === worktree)) {
    const {gitDir,id} = expected, current = gitDirIdentity(gitDir), other = !holder && current && current !== id && gitFileOf(gitDir);
    if (!holder && current !== id && (!other || other !== marker && gitDirOf(dirname(other)) === gitDir)) return null;
    throw new Error("无法确认原工作区已删除，已保留释放意图：" + worktree);
  }
  if (holder === worktree && local?.isDirectory() && lstatSync(marker,{throwIfNoEntry:false})?.isFile()) {
    const gitDir = gitDirOf(worktree), id = gitDirIdentity(gitDir);
    if (id && gitFileOf(gitDir) === marker && (!expected || (gitDir === expected.gitDir && id === expected.id))) return {gitDir,id};
  }
  throw new InputError(`Git 工作区登记不一致，已保留现场：${worktree}（任务分支：${holder || "未检出"}）`);
}
export const releaseWorktree = (dir: string, fromFinish = false) => withLock(operationPath(dir), () => {
  const t = taskOf(dir), s = statusOf(dir), commit = s.loop.commit || t.baseCommit, start = Date.now(); let pending = s.loop.releasePending;
  if (fromFinish && !pending?.auto) return {executionId:t.executionId,released:Boolean(s.loop.released)};
  if (!fromFinish && pending?.auto) throw new InputError("自动释放尚未结束；请运行 bin/loop 收尾 " + t.executionId + " 补齐");
  const requireCompleted = (s: Status) => { if (s.state !== "completed" || s.loop.released) throw new InputError(s.loop.released ? "工作区已释放" : "未完成，无法释放工作区"); }; requireCompleted(s);
  const finishRelease = (released = false, note = "") => update(dir,current=>{
    requireCompleted(current); current.loop.releasePending = null; if (released) current.loop.released = true;
    if (pending?.auto) { current.loop.finisher = null; if (note) current.message += "；" + note; }
  });
  const saved = pending && checksOf(dir).findLast(c=>c.step==="释放" && c.commit===commit && c.startedAt===pending?.at && (fromFinish || c.result==="已释放"));
  let result = saved?.result || "已释放", detail: string | undefined, probing = true;
  if (!saved || result === "已释放") try {
    const target = releaseTarget(t,pending?.target); probing = false; if (saved && target) throw new InputError("工作区与已登记的释放结果不一致，已保留现场：" + t.worktree);
    const dirty = target ? releaseChanges(t.worktree) : [];
    if (dirty.length && !fromFinish) throw new InputError("工作区有未提交文件，无法释放：\n" + dirty.join("\n"));
    if (dirty.length) { result = "保留"; detail = dirty.slice(0,20).join("\n"); }
    else if (target) {
      pending = {...(pending || {at:iso(start)}),target};
      update(dir,current=>{ requireCompleted(current); current.loop.releasePending = pending; }); clearCheck(t);
      if (releaseTarget(t,target)) {
        const {code,stderr,stdout} = gitTry(t.repo,["-c","status.showUntrackedFiles=all","-c","core.fsmonitor=false","worktree","remove",t.worktree]);
        if (code && !pending.auto) try { if (releaseTarget(t,target)) finishRelease(); }
        catch {} // 无法核实时保留意图，不覆盖 Git 原错。
        if (code) throw new Error(stderr || stdout);
      }
    }
  } catch (e) {
    if (!fromFinish || probing && pending?.target && !(e instanceof InputError)) throw e; result = "失败"; detail = errorText(e);
  }
  if (!saved || saved.result !== result) recordStep(dir,{step:"释放",result,commit,...span(start),startedAt:pending?.at || iso(start),evidence:[],detail});
  const released = result === "已释放", note = released ? "工作区已释放" : result === "保留" ? "工作区有未提交文件，已保留" : "";
  if (pending?.auto && note) try {
    batchResult(t,[],`${note}（${t.executionId}，${pending.at}）`);
  } catch (e) { console.error("写入释放说明失败：", e); }
  finishRelease(released,note); return {executionId:t.executionId,released};
});
