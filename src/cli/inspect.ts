import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { changes, gitText, head } from "../infra/git.ts";
import { APP_ROOT } from "../infra/paths.ts";
import { taskOf, statusOf, checksOf, update, recordStep } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { onTaskBranch, undeliveredCommit, waitingForDelivery } from "../core/deliver.ts";
import { snapshot, differences } from "../core/snapshot.ts";

export function publicStatus(dir: string) {
  const s = statusOf(dir);
  if (!waitingForDelivery(s)) return s;
  try {
    const t = taskOf(dir), commit = head(t.worktree);
    if (!onTaskBranch(t) || !undeliveredCommit(t, s, commit) || changes(t.worktree).length) return s;
    const deliveryConfirmation = {label: "用当前提交交付", commit, command: APP_ROOT + "/bin/loop 续跑 " + t.executionId + " --交付提交 " + commit};
    return {...s, loop: {...s.loop, deliveryConfirmation}};
  } catch { return s; } // Git 现场不可读时仍返回状态，但不声称可确认。
}

export async function comparison(dir: string, other?: string) {
  const t=taskOf(dir), deployed=(d: string)=>checksOf(d).filter(c=>c.step==="部署" && c.result.startsWith("已部署")).at(-1);
  const first=deployed(dir), second=other?deployed(other):undefined, report=join(dir,"comparison-"+Date.now()+".md");
  let text="没有基线";
  if(first) {
    const base=join(first.evidence[1],"snapshot-after.json"), current=other && second?join(second.evidence[1],"snapshot-after.json"):join(dir,"snapshot-live-"+Date.now()+".json");
    if(!other)await checkout(t.repo,first.commit,async cwd=>{await snapshot(t,cwd,first.commit,current,"live");});
    if(!other || second)text=differences(base,current);
  }
  writeFileSync(report,"# 运行差异\n\n"+text+"\n"); return {report,diff:text};
}
export function releaseWorktree(dir: string) {
  const t=taskOf(dir), s=statusOf(dir), start=Date.now();
  if(s.state!=="completed" || s.loop.released)throw new InputError(s.loop.released?"工作区已释放":"未完成，无法释放工作区");
  gitText(t.repo,["worktree","remove","--force",t.worktree]);
  update(dir,s=>{s.loop.released=true;});
  recordStep(dir,{step:"释放",result:"已释放",commit:s.loop.commit || t.baseCommit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:[]});
  return {executionId:t.executionId,released:true};
}
