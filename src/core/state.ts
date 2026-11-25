import { join } from "node:path";
import { alive } from "../infra/exec.ts";
import { acceptanceOf, binding, evidence } from "./inputs.ts";
import { maybe } from "../infra/files.ts";
import { Ledger, hasLedger, type Entry, type Step } from "./store.ts";
export const resets = ["答复","续跑","加轮","接受未验证"];
export const waiting = (rows:Entry[])=>rows.findLast(r=>r.wait && !rows.some(e=>
  e.n>r.n && (resets.includes(e.type) || r.wait==="需求疑问" && e.type==="窗口原话")));
const lastSettled=(rows:Entry[])=>rows.findLast(r=>r.type==="窗口" && r.status==="闲");
export const windowSuspended=(rows:Entry[],settled=lastSettled(rows))=>settled?.aborted && !rows.some(r=>
  r.n>settled.n && ["答复","窗口原话","续跑"].includes(r.type));
export const success = (r:Entry) =>
  (r.type==="准备好" || r.type==="提交" || r.result==="成功" || ["通过","必修","没验证"].includes(r.check?.result || "")) && !r.kind && !r.blocker;
export const pendingStarts=(l:Ledger)=>l.rows.filter(r=>r.type==="开始" && !l.rows.some(e=>e.ref===r.n && [r.step,"准备好","提交","部署已回退"].includes(e.type)));
export const online=(step?:Step)=>step==="部署" || step==="退回";
export const pendingDeploy=({rows}:Ledger)=>rows.findLast(r=>r.type==="部署开始" && !rows.some(e=>
  e.type==="部署已回退" && e.repair===r.ref || e.type==="部署" && e.ref===r.ref && /^(已部署|部署失败，已回退)/.test(e.check?.result || "")));
export const projectedStop = (l:Ledger):Entry|undefined => {
  const stop=l.last("停"); if (stop && (stop.result==="已放弃" || stop.n>(l.last("续跑")?.n || 0))) return stop;
  return l.open.deps?.flatMap(id=>{ const dir=join(l.dir,"..",id); return hasLedger(dir) ? [projectedStop(new Ledger(dir))] : []; }).find(Boolean);
};
const siblings=(l:Ledger,ids:string[])=>ids.map(id=>maybe(()=>new Ledger(join(l.dir,"..",id))));
export const batchPresent=(l:Ledger)=>siblings(l,l.open.batch || []).every(Boolean);
export function batchReady(l:Ledger) {
  const before=(l.open.batch || []).slice(0,l.open.batch?.indexOf(l.task.executionId) ?? 0);
  const peers=siblings(l,before).flatMap(p=>p ? [state(p)] : []);
  return peers.filter(p=>p.windowLive || !p.done && !p.stop).length<(l.open.limit || 1) && siblings(l,l.open.deps || []).every(p=>p && state(p).side("合入"));
}
export function state(l:Ledger, evaluate=true) {
  const {rows,task:t,delivery}=l, commit=delivery?.commit, b=evaluate && commit ? maybe(()=>binding(l,commit)) : undefined;
  const proofs=b ? evidence(rows,b.sha,b.key,b.tree) : undefined, key=b?.key || "", sha=commit || t.baseCommit;
  const last=l.last("提交")?.n || 0;
  const complete=rows.findLast(r=>r.type==="完成" && r.n>last && (!r.sha || r.sha===sha));
  const wait=waiting(rows);
  const stop=projectedStop(l), ready=!!l.last("准备好"), window=rows.findLast(r=>r.type==="窗口" && r.status==="开"), windowEvent=l.last("窗口");
  const windowLive=windowEvent?.status!=="断" && alive(window?.owner), busy=windowLive && windowEvent?.status==="忙";
  const settled=lastSettled(rows), suspended=windowSuspended(rows,settled);
  const accepted=acceptanceOf(rows,commit), receipt=rows.findLast(r=>r.type==="收货" && r.sha===commit && r.result==="成功" && r.value?.reused);
  const todo=rows.filter(r=>r.todo && r.n>Math.max(last,accepted?.n || 0) && !(r.type==="答复" && r.n<(receipt?.n || 0))),
    sent=rows.filter(r=>r.type==="送达" && r.ref===window?.n), sentIds=new Set(sent.flatMap(r=>r.sent || []));
  const undelivered=todo.filter(r=>!sentIds.has(r.n)), starts=pendingStarts(l), running=starts.find(r=>r.step!=="收货" && alive(r.owner));
  const schedule=rows.findLast(r=>r.type==="调度" && r.owner),
    queued=schedule?.owner && !rows.some(r=>r.type==="开始" && r.source===schedule.n
      || r.type==="合入" && r.intent && r.ref===schedule.n) && alive(schedule.owner) ? schedule : undefined;
  const side=(step:string)=>rows.findLast(r=>r.type===step && r.sha===sha && success(r) && (r.key===key || step==="释放"));
  const returned=(step:Step)=>rows.filter(r=>r.type==="发回" && r.step===step && r.count===1);
  const levels={复测:t.limits.测试,评审:t.limits.开发评审,部署:t.limits.部署},
    allowance=(step:keyof typeof levels)=>levels[step].maxRepairs+rows.filter(r=>r.type==="加轮" && r.level===step).reduce((n,r)=>n+(r.count || 0),0);
  const done=Boolean(proofs?.verified || proofs?.accepted && side("合入")
    || !t.after.length && proofs?.test?.check?.result==="没验证" && proofs.review?.check?.result==="通过" && !proofs.review.blocker)
    && t.after.every(step=>side(step)) && (!t.after.length || !!side("释放"));
  return {t,rows,delivery,sha,key,b,proofs,ready,wait,stop,window,windowEvent,windowLive,busy,settled,suspended,
    todo,undelivered,sent,starts,running,queued,side,returned,allowance,done,last,complete};
}
export type CardState = ReturnType<typeof state>;
export const returnedMessage=(s:CardState,step:"复测"|"评审"|"部署",raw:string)=>{
  const rounds=s.returned(step), items=(r:Entry)=>r.value?.items as string[] || [];
  const buckets=rounds.flatMap(r=>items(r).map(text=>text.match(/([^\s:：`]+):\d+/)?.[1])).filter(Boolean);
  const repeated=[...new Set(buckets.filter((f,i)=>buckets.indexOf(f)!==i))];
  return `${step}已用 ${rounds.length+1}/${s.allowance(step)} 轮。\n${raw}\n收敛趋势：${
    rounds.map(r=>items(r).length).concat(step==="评审" ? s.proofs?.review?.value?.items?.length || 0 : 0).join(" → ")
  } 条必修；跨轮反复涉及：${repeated.join("、") || "未见同文件集中"}（同类问题见逐轮必修原文）。`;
};
