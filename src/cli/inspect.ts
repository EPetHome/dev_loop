import { appendFileSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { changes, git, gitTry, head, releaseChanges } from "../infra/git.ts";
import { withLock } from "../infra/files.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { taskOf, statusOf, checksOf, update, recordStep } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { onTaskBranch, undeliveredCommit, waitingForDelivery } from "../core/deliver.ts";
import { snapshot, differences } from "../core/snapshot.ts";
import { clearCheck, operationPath } from "../core/run.ts";
export function publicStatus(dir: string) {
  const s = statusOf(dir); if (!waitingForDelivery(s)) return s;
  try {
    const t = taskOf(dir), commit = head(t.worktree);
    if (!onTaskBranch(t) || !undeliveredCommit(t, s, commit) || changes(t.worktree).length) return s;
    return {...s, loop:{...s.loop, deliveryConfirmation:{label:"用当前提交交付", commit, command:APP_ROOT + "/bin/loop 续跑 " + t.executionId + " --交付提交 " + commit}}};
  } catch { return s; } // Git 现场不可读时仍返回状态，但不声称可确认。
}
export async function comparison(dir: string, other?: string) {
  const t=taskOf(dir), deployed=(d: string)=>checksOf(d).filter(c=>c.step==="部署" && c.result.startsWith("已部署")).at(-1);
  const first=deployed(dir), second=other?deployed(other):undefined, report=join(dir,"comparison-"+Date.now()+".md"); let text="没有基线";
  if(first && (!other || second)) {
    const current=second?join(second.evidence[1],"snapshot-after.json"):join(dir,"snapshot-live-"+Date.now()+".json");
    if(!other)await checkout(t.repo,first.commit,cwd=>snapshot(t,cwd,first.commit,current,"live"));
    text=differences(join(first.evidence[1],"snapshot-after.json"),current);
  }
  writeFileSync(report,"# 运行差异\n\n"+text+"\n"); return {report,diff:text};
}
export const releaseWorktree = (dir: string, fromFinish = false) => withLock(operationPath(dir), () => {
  const t = taskOf(dir), s = statusOf(dir), {releasePending:pending} = s.loop, commit = s.loop.commit || t.baseCommit;
  if (fromFinish && !pending) return {executionId:t.executionId,released:Boolean(s.loop.released)};
  const stopped = fromFinish && s.state === "cancelled";
  if (s.loop.released || (s.state !== "completed" && !stopped)) throw new InputError(s.loop.released ? "工作区已释放" : "未完成，无法释放工作区");
  const saved = pending && checksOf(dir).findLast(c=>c.step==="释放" && c.commit===commit && c.startedAt===pending && (fromFinish || c.result==="已释放"));
  const start = Date.now(); let result = saved ? saved.result : "已释放", detail: string | undefined;
  if (!saved) try {
    const missing = pending && !lstatSync(t.worktree,{throwIfNoEntry:false}), dirty = missing || stopped ? [] : releaseChanges(t.worktree);
    if (dirty.length) {
      if (!fromFinish) throw new InputError("工作区有未提交文件，无法释放：\n" + dirty.join("\n"));
      result = "保留"; detail = dirty.slice(0,20).join("\n");
    } else if (!missing || git(t.repo,["worktree","list","--porcelain","-z"]).split("\0").includes("worktree "+t.worktree)) {
      if (!stopped) clearCheck(t);
      if (!stopped && statusOf(dir).state === "completed") {
        const removed = gitTry(t.repo,["-c","status.showUntrackedFiles=all","-c","core.fsmonitor=false","worktree","remove",t.worktree]);
        if (removed.code) throw new Error(removed.stderr || removed.stdout);
      } else if (fromFinish) result = ""; else throw new InputError("未完成，无法释放工作区");
    }
  } catch (e) { if (!fromFinish) throw e; result = "失败"; detail = e instanceof Error ? e.message : String(e); }
  if (!saved && result) recordStep(dir,{step:"释放",result,commit,startedAt:pending || new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:[],detail});
  const released = result === "已释放", note = released ? "工作区已释放" : result === "保留" ? "工作区有未提交文件，已保留" : "";
  if (pending && note) try {
    const report = join(dirname(t.card),"结果.md"), line = `${note}（${t.executionId}，${pending}）\n`;
    if (!readFileSync(report,"utf8").includes(line)) appendFileSync(report,line);
  } catch (e) { console.error("写入释放说明失败：", e); }
  update(dir, current=>{
    if (pending) { current.loop.releasePending = current.loop.finisher = null; if (current.state === "completed" && note) current.message += "；" + note; }
    if (released) current.loop.released = true;
  });
  return {executionId:t.executionId,released};
});
