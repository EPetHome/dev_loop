import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lock, withLock, BusyError, optionalJson, writeJson } from "../infra/files.ts";
import { projectFile } from "../infra/project.ts";
import { alive, identity } from "../infra/exec.ts";
import { gitText } from "../infra/git.ts";
import { taskOf, statusOf, update, move, transition, waitFor, recordStep, checked, checksOf, createTask, launchStarted, LoopError } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { operationPath } from "../core/run.ts";
import { merge, prepareMerge } from "../steps/merge.ts";
import { deploy, rollback, type DeployResult } from "../steps/deploy.ts";
import { push } from "../steps/push.ts";
import { queued } from "./queue.ts";
import { background } from "./background.ts";
import { releaseWorktree } from "./inspect.ts";
export function pendingAcceptance(card: string): number {
  const current = dirname(card), parent = dirname(current);
  return readdirSync(parent,{withFileTypes:true}).filter(e=>{
    try { return e.isDirectory() && join(parent,e.name) !== current && readFileSync(join(parent,e.name,"验收.md"),"utf8").split(/\r?\n/)[0] === "状态：待验"; } catch { return false; }
  }).length;
}
export async function finish(dir: string, automatic = false) {
  const t = taskOf(dir), after = t.after || []; if (!after.length && !t.next) throw new InputError("这张卡没有约定收尾");
  const start = Date.now(), shouldRelease = !t.next && after.includes("合入"), owner = identity();
  let release: () => void, commit="", claimed=false, restore=false, deployed: DeployResult | undefined, before="", deploying=false;
  try { release=lock(join(dir,"finish.lock")); } catch(e) { if(e instanceof BusyError)throw new InputError("正在收尾"); throw e; }
  const record = (result: string, detail: string) => recordStep(dir,{step:"收尾",result,commit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:deployed?[deployed.evidenceDir]:[],detail});
  const facts = (result: string) => appendFileSync(join(dirname(t.card),"结果.md"), ["", "## " + new Date().toISOString(), "执行："+t.executionId,"版本："+commit,"结果："+result,
    "dev："+before+" → "+gitText(t.repo,["rev-parse","dev"]),"部署时间："+(deployed?.result.startsWith("已部署")?new Date().toISOString():"未成功部署"),"证据："+(deployed?.evidenceDir || join(dir,"checks.jsonl")),
    "退回次数："+(statusOf(dir).loop.deployReturns || 0),...checksOf(dir).filter(c=>c.step==="收尾" && c.result==="退回开发方").map(c=>"退回原因："+c.detail),
    "恢复入口：bin/loop 退回 "+t.executionId,"验收标准："+(t.acceptance || "未登记"),""].join("\n"));
  const cleanup = () => { try { releaseWorktree(dir, true); } catch (e) { console.error("释放工作区未登记：", e); } return statusOf(dir); };
  try {
    if (statusOf(dir).loop.releasePending?.auto) { if (automatic) throw new InputError("不自动重试已发起的收尾；收尾已通过，待手工接手释放"); return cleanup(); }
    withLock(operationPath(dir), () => update(dir,s=>{
      if(alive(s.loop.finisher))throw new InputError("正在收尾");
      const interrupted=s.state==="working" && s.loop.finisher && s.loop.afterCommit===s.loop.commit;
      if(s.state==="cancelled" || (s.loop.phase!=="收尾中" && s.loop.wait!=="收尾没走完" && !interrupted))throw new InputError("当前不在待收尾");
      if(automatic && (s.loop.phase!=="收尾中" || s.loop.finisher))throw new InputError("不自动重试已发起的收尾；请显式运行 bin/loop 收尾 手工接手");
      if(!s.loop.commit)throw new InputError("没有交付记录");
      s.loop.afterCommit=commit=s.loop.commit; s.loop.finisher=owner; move(s,"working","收尾中","开始收尾","selfMs");
    }, "收尾"), 0); claimed=true;
    await queued(dir, async () => {
      const cancelled = () => statusOf(dir).state === "cancelled"; before = gitText(t.repo,["rev-parse","dev"]);
      if (after.includes("部署")) {
        const prepared = prepareMerge(dir,commit);
        if (cancelled()) return;
        const marker=projectFile(dirname(dir),t.repo,"deployed");let previous: unknown;try{previous=optionalJson(marker);}catch{}
        deploying=true; deployed = await deploy(dir,{commit:prepared,automatic:true}); deploying=false; if (cancelled()) return;
        try { merge(dir,{commit,prepared,acceptUnverified:false}); }
        catch(e) {
          if(gitText(t.repo,["rev-parse","dev"])===prepared)throw e;
          const raw=e instanceof Error?e.message:String(e);
          try { await rollback(dir,"merge"); }
          catch(r) { throw new LoopError("未知",raw+"\n回退也失败："+String(r),{...deployed,result:"合入失败，回退也失败"}); }
          if(previous)writeJson(marker,previous);
          throw new LoopError("输入问题",raw+"\n线上已回退；dev 和用户本地改动未变。",{...deployed,result:"合入失败，线上已回退"});
        }
        update(dir,s=>{if(s.state==="working") s.loop.phase="已部署";});
      } else if (after.includes("合入")) merge(dir,{commit,acceptUnverified:false});
      if (cancelled()) return; if (after.includes("推送")) await push(dir);
      if (!cancelled() && t.next) {
        const {delivery, next: id} = statusOf(dir).loop, root = dirname(dir);
        if (delivery?.commit !== commit || !checked(dir, commit)) throw new InputError("接力须有当前交付的正式复测与评审通过记录");
        const next = id ? taskOf(join(root,id)) : createTask(t.next,root,t.dispatchId,commit);
        if (!id) update(dir,s=>{s.loop.next=next.executionId;});
        if (next.baseCommit !== commit) throw new InputError("已分配的下一卡起点不是本次交付：" + next.executionId);
        if (!launchStarted(statusOf(next.dir))) await background(next,"handoff");
      }
      if (cancelled()) return;
      const reasons = checksOf(dir).flatMap(c=>c.step==="收尾" && c.result==="退回开发方" ? [c.detail] : []).join("；"), returns = statusOf(dir).loop.deployReturns || 0;
      const message = `收尾已走完；验收标准：${t.acceptance || "未登记"}；中途退回 ${returns} 次${reasons ? "："+reasons : ""}；另有 ${pendingAcceptance(t.card)} 批待验`; facts(message); record("通过",message);
      update(dir, s=>{ if (move(s,"completed",after.length?s.loop.phase:"完成",message,null) && shouldRelease) s.loop.releasePending = {at:new Date().toISOString(),auto:true}; });
    }, true);
    if (shouldRelease) cleanup();
  } catch (e) {
    if (!claimed) throw e; if (statusOf(dir).state === "completed") return cleanup();
    let reason = e instanceof Error ? e.message : String(e); const result = e instanceof LoopError ? e.result as any : undefined;
    if (result?.evidenceDir) deployed=result;
    if (result?.log && result.result?.startsWith("部署失败")) { try { reason=readFileSync(result.log,"utf8").trimEnd().split(/\r?\n/).slice(-60).join("\n"); } catch {} }
    reason = (result?.result || "收尾失败") + "\n" + reason; record("失败",reason);
    const repairable = result?.conflict || (result?.result === "合入失败" && /CONFLICT/.test(reason)) || result?.result === "部署失败，已回退" || (deploying && e instanceof InputError);
    if (statusOf(dir).state !== "cancelled" && repairable && t.host === "pi" && (statusOf(dir).loop.deployReturns || 0) < (t.limits.部署?.maxRepairs ?? 2)) {
      update(dir,s=>{s.loop.deployReturns=(s.loop.deployReturns || 0)+1;s.loop.pendingReturn=reason;});
      transition(dir,"working","开发中","收尾退回返修，请修改后重新交付。\n"+reason,"developmentMs"); record("退回开发方",reason);
      const {session}=statusOf(dir).loop; restore=!alive(session) || !!session?.endedAt;
    } else waitFor(dir,"收尾没走完",reason + (repairable?"\n自动返修已到上限或此宿主需手动续跑。":"") + "\n可修改后续跑开发，或运行 bin/loop 收尾 " + t.executionId + " 手工重试。");
    facts(reason);
  } finally { try { if(claimed)update(dir,s=>{if(s.loop.finisher?.pid===owner.pid && s.loop.finisher.startedAt===owner.startedAt)s.loop.finisher=null;}); } finally { release(); } }
  if (restore && statusOf(dir).state === "working") await background(t,"resume"); return statusOf(dir);
}
