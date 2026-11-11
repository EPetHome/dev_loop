import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lock, BusyError } from "../infra/files.ts";
import { alive, identity } from "../infra/exec.ts";
import { gitText } from "../infra/git.ts";
import { taskOf, statusOf, update, transition, waitFor, recordStep, checksOf, createTask, LoopError } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { operationPath } from "../core/run.ts";
import { merge, prepareMerge } from "../steps/merge.ts";
import { deploy, type DeployResult } from "../steps/deploy.ts";
import { push } from "../steps/push.ts";
import { queued } from "./queue.ts";
import { background } from "./background.ts";
export function pendingAcceptance(card: string): number {
  const current = dirname(card), parent = dirname(current);
  return readdirSync(parent,{withFileTypes:true}).filter(e => {
    if (!e.isDirectory() || join(parent,e.name) === current) return false;
    try { return readFileSync(join(parent,e.name,"验收.md"),"utf8").split(/\r?\n/)[0] === "状态：待验"; } catch { return false; }
  }).length;
}
export async function finish(dir: string) {
  const t = taskOf(dir), initial = statusOf(dir), start = Date.now();
  if (!t.after?.length && !t.next) throw new InputError("这张卡没有约定收尾");
  if (alive(initial.loop.finisher)) throw new InputError("正在收尾");
  if (initial.loop.phase !== "收尾中" && initial.loop.wait !== "收尾没走完") throw new InputError("当前不在待收尾");
  let release: () => void;
  try { release=lock(join(dir,"finish.lock")); } catch(e) { if(e instanceof BusyError)throw new InputError("正在收尾"); throw e; }
  const commit = initial.loop.commit!;
  let restore = false, deployed: DeployResult | undefined, before = "", step = "合入";
  const record = (result: string, detail: string) => recordStep(dir,{step:"收尾",result,commit,startedAt:new Date(start).toISOString(),endedAt:new Date().toISOString(),durationMs:Date.now()-start,evidence:deployed?[deployed.evidenceDir]:[],detail});
  const facts = (result: string) => appendFileSync(join(dirname(t.card),"结果.md"), ["", "## " + new Date().toISOString(), "执行："+t.executionId,"版本："+commit,"结果："+result,
    "dev："+before+" → "+gitText(t.repo,["rev-parse","dev"]),"部署时间："+(deployed?.result.startsWith("已部署")?new Date().toISOString():"未成功部署"),"证据："+(deployed?.evidenceDir || join(dir,"checks.jsonl")),
    "退回次数："+(statusOf(dir).loop.deployReturns || 0),...checksOf(dir).filter(c=>c.step==="收尾" && c.result==="退回开发方").map(c=>"退回原因："+c.detail),
    "恢复入口：bin/loop 退回 "+t.executionId,"验收标准："+(t.acceptance || "未登记"),""].join("\n"));
  try {
    const operation = lock(operationPath(dir));
    try { update(dir,s=>{ if (s.state !== "cancelled") { s.loop.finisher=identity(); s.loop.afterCommit=commit; } }); }
    finally { operation(); }
    transition(dir,"working","收尾中","开始收尾","selfMs");
    await queued(dir, async () => {
      const cancelled = () => statusOf(dir).state === "cancelled", after = t.after || [];
      before = gitText(t.repo,["rev-parse","dev"]);
      if (after.includes("部署")) {
        const prepared = prepareMerge(dir,commit);
        if (cancelled()) return;
        step="部署"; deployed = await deploy(dir,{commit:prepared,automatic:true});
        if (cancelled()) return;
        step="合入"; merge(dir,{commit,prepared,acceptUnverified:false});
        update(dir,s=>{if(s.state==="working") s.loop.phase="已部署";});
      } else if (after.includes("合入")) merge(dir,{commit,acceptUnverified:false});
      if (cancelled()) return;
      step="推送"; if (after.includes("推送")) await push(dir);
      if (cancelled()) return;
      step="接力";
      if (t.next && !statusOf(dir).loop.next) {
        const next = createTask(t.next,dirname(dir),t.dispatchId,commit);
        update(dir,s=>{s.loop.next=next.executionId;}); await background(next);
      }
      const reasons = checksOf(dir).filter(c=>c.step==="收尾" && c.result==="退回开发方").map(c=>c.detail).join("；");
      const message = "收尾已走完；验收标准：" + (t.acceptance || "未登记") + "；中途退回 " + (statusOf(dir).loop.deployReturns || 0) + " 次" + (reasons?"："+reasons:"") + "；另有 " + pendingAcceptance(t.card) + " 批待验";
      facts(message); record("通过",message);
      transition(dir,"completed",after.length?statusOf(dir).loop.phase:"完成",message,null);
    }, true);
  } catch (e) {
    let reason = e instanceof Error ? e.message : String(e);
    const result = e instanceof LoopError ? e.result as any : undefined;
    if (result?.evidenceDir) deployed=result;
    if (result?.log) { try { reason=readFileSync(result.log,"utf8").trimEnd().split(/\r?\n/).slice(-60).join("\n"); } catch {} }
    reason = (result?.result || "收尾失败") + "\n" + reason; record("失败",reason);
    const repairable = result?.conflict || (result?.result === "合入失败" && /CONFLICT/.test(reason)) || result?.result === "部署失败，已回退" || (step === "部署" && e instanceof InputError);
    if (statusOf(dir).state !== "cancelled" && repairable && t.host === "pi" && (statusOf(dir).loop.deployReturns || 0) < (t.limits.部署?.maxRepairs ?? 2)) {
      update(dir,s=>{s.loop.deployReturns=(s.loop.deployReturns || 0)+1;s.loop.pendingReturn=reason;});
      transition(dir,"working","开发中","收尾退回返修，请修改后重新交付。\n"+reason,"developmentMs"); record("退回开发方",reason);
      const session=statusOf(dir).loop.session; restore=!alive(session) || Boolean(session?.endedAt);
    } else waitFor(dir,"收尾没走完",reason + (repairable?"\n自动返修已到上限或此宿主需手动续跑。":"") + "\n可修改后续跑开发，或运行 bin/loop 收尾 " + t.executionId + " 手工重试。");
    facts(reason);
  } finally { update(dir,s=>{s.loop.finisher=null;}); release(); }
  if (restore && statusOf(dir).state === "working") await background(t,true);
  return statusOf(dir);
}
