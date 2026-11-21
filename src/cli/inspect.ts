import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { changes, gitTry, head } from "../infra/git.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { taskOf, statusOf, checksOf, update, recordStep, type Status, type Task } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { onTaskBranch, undeliveredCommit, waitingForDelivery } from "../core/deliver.ts";
import { snapshot, differences } from "../core/snapshot.ts";
import { clearCheck } from "../core/run.ts";
export function publicStatus(dir: string) {
  const s = statusOf(dir); if (!waitingForDelivery(s)) return s;
  try {
    const t = taskOf(dir), commit = head(t.worktree);
    if (!onTaskBranch(t) || !undeliveredCommit(t, s, commit) || changes(t.worktree).length) return s;
    const deliveryConfirmation = {label: "用当前提交交付", commit, command: APP_ROOT + "/bin/loop 续跑 " + t.executionId + " --交付提交 " + commit};
    return {...s, loop: {...s.loop, deliveryConfirmation}};
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
// 在状态事务内调用，避免停止和手工释放与收尾的删除决定交错。
export function releaseDevelopmentWorktree(t: Task, s: Status, automatic = false) {
  const start = Date.now(); let result = "已释放", detail: string | undefined;
  try {
    const dirty = changes(t.worktree);
    if (!dirty.length) {
      clearCheck(t); const removed = gitTry(t.repo, ["-c", "status.showUntrackedFiles=all", "worktree", "remove", t.worktree]);
      if (removed.code) throw new Error(removed.stderr || removed.stdout); s.loop.released = true;
    } else if (automatic) { result = "保留"; detail = dirty.slice(0, 20).join("\n"); }
    else throw new InputError("工作区有未提交文件，无法释放：\n" + dirty.join("\n"));
  } catch (e) { if (!automatic) throw e; result = "失败"; detail = e instanceof Error ? e.message : String(e); }
  return {step:"释放",result,commit:s.loop.commit || t.baseCommit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:[],detail};
}
export function releaseWorktree(dir: string) {
  const t = taskOf(dir); let entry: ReturnType<typeof releaseDevelopmentWorktree>;
  update(dir, s => {
    if (s.state !== "completed" || s.loop.released) throw new InputError(s.loop.released ? "工作区已释放" : "未完成，无法释放工作区");
    entry = releaseDevelopmentWorktree(t, s);
  });
  recordStep(dir, entry!); return {executionId:t.executionId,released:true};
}
