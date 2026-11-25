import { hostname } from "node:os";
import { join } from "node:path";
import { atomicWrite, readJson, jsonLines, writeJson, maybe } from "../infra/files.ts";
import { idleSleep } from "../infra/idle-sleep.ts";
import { state, resets } from "./state.ts";
import { Ledger, hasLedger, batchResult, type Entry, type Phase } from "./store.ts";
import { binding, evidence } from "./inputs.ts";
export const waitName=(r:Entry)=>r.wait==="轮数用完"
  ? r.level==="评审" ? "评审必修到上限" : r.level==="复测" ? "复测退回到上限" : "收尾没走完"
  : r.wait==="环境修不好" ? ["合入","部署","推送","释放","退回"].includes(r.step || "") ? "收尾没走完" : "复测环境未就绪" : "停下没交付";
const choices={
  "轮数用完":["收窄：按新要求返修","加轮：继续检查新交付","接受未验证：显式合入当前版本","停：保留现场"],
  "需求疑问":["答复：按原话继续","停：保留现场"],"开发推不动":["答复：给开发新的方向","停：保留现场"],
  "环境修不好":["续跑：修好后在同一步重试","停：保留现场"]
};
const stage:Partial<Record<string,Phase>>={准备:"准备中",收货:"开发中",开窗口:"开发中",复测:"复测中",评审:"评审中",合入:"收尾中",部署:"部署中",推送:"推送中",释放:"收尾中"};
export function report(l:Ledger,verbose=false) {
  const s=state(l),{t,rows,wait,stop,proofs,delivery}=s, working=s.running || s.queued, unreviewed=delivery && !proofs?.review;
  const final=["退回","推送","部署","合入"].find(k=>k==="退回" ? l.last(k)?.result==="成功" && l.last(k)!.n>(s.side("部署")?.n || 0) : s.side(k));
  const phase:Phase=stop ? stop.result==="已放弃" && stop===l.last("停") ? "已放弃" : "已停止"
    : wait ? "等你"
    : s.suspended ? "开发中"
    : working ? stage[working.step!] || "开发中"
    : !s.ready ? "准备中"
    : s.done ? ({合入:"已合入",部署:"已部署",推送:"已推送",退回:"已退回"} as const)[final as "合入"] || "完成"
    : proofs?.verified && !s.todo.length ? "收尾中"
    : !s.todo.length && unreviewed ? "已交付" : "开发中";
  const options=wait?.wait ? choices[wait.wait] : [],
    message=stop ? "任务已停止；保留分支和证据"
      : wait ? `${wait.wait}：${wait.text}\n不回就保留现场。\n${options.join(" / ")}`
      : s.suspended ? "本人中止，等本人说话"
      : s.done && proofs?.accepted && !proofs.verified ? `${phase}（接受未验证）`
      : working ? `正在${working.step}` : (s.todo.at(-1)?.todo || phase);
  const test=rows.findLast(r=>r.type==="复测" && r.sha===delivery?.commit && r.check), c=test?.check;
  const durations={developmentMs:0,testMs:0,reviewMs:0,inputMs:0,selfMs:0}, stops=rows.filter(r=>r.wait || r.type==="停").slice(-50).map(r=>{
    const resolve=rows.find(e=>e.n>r.n && (resets.includes(e.type) || e.type==="停" || r.wait==="需求疑问" && e.type==="窗口原话"));
    durations.inputMs+=Math.max(0,(resolve ? Date.parse(resolve.at) : Date.now())-Date.parse(r.at));
    return {
      at:r.at, step:stage[r.step!] || "开发中",state:r.wait ? "input_required" : "cancelled",reason:r.wait ? waitName(r) : r.result,
      message:(r.text || "").slice(0,200),resumedAt:resolve?.at || null,
      resolvedBy:resolve ? resolve.type==="停" ? resolve.result==="已放弃" ? "放弃" : "停止"
        : resolve.type==="接受未验证" ? "合入（接受未验证）" : "续跑" : null
    };
  });
  for (const x of l.checks) durations[x.step==="复测" ? "testMs" : x.step==="评审" ? "reviewMs" : x.step==="开发" ? "developmentMs" : "selfMs"]+=x.durationMs;
  const {dir,executionId,dispatchId,createdAt,prompt,card}=t, at=rows.at(-1)?.at || createdAt,
    lastMust=rows.findLast(r=>r.type==="评审" && r.check?.result==="必修");
  const warnings=t.e2e && /^无\s*[:：]/.test(s.b?.test || t.test) ? ["声明了 E2E 场景，却没有执行命令"] : undefined;
  const status={protocol:"loop-status/1",source:{worker:"loop",instance:hostname()},executionId,dispatchId,batchId:null,
    state:stop ? "cancelled" : wait ? "input_required" : s.done && !working && !s.busy && !s.todo.some(r=>r.type==="答复") ? "completed" : "working",
    message,updatedAt:at,seq:rows.length,generation:1,
    heartbeatSec:t.config.tickIntervalSec,
    timeLimitSec:working?.step==="复测" ? t.limits.测试.timeoutMin*60 : working?.step==="评审" ? t.limits.开发评审.timeoutMin*60 : null,
    refs:{prompt,acceptance:t.acceptance || null,card},error:null,evidence:[join(dir,"summary.md"),join(dir,"checks.jsonl")],
    actions:["查询","续跑","答复","停止","放弃"],warnings,
    loop:{phase,wait:wait ? waitName(wait) : null,commit:delivery?.commit || null,
      delivery:delivery ? {commit:delivery.commit,tree:delivery.tree,note:delivery.note,at:delivery.at} : null,
      prepared:s.ready,ready:s.ready,released:s.side("释放")?.value?.released===true,abandoned:phase==="已放弃",reused:false,
      session:s.window?.owner ? {...s.window.owner,host:"pi",id:s.window.value?.id,file:s.window.file,
        ...(!s.windowLive ? {endedAt:s.windowEvent?.at} : {})} : null,
      launcher:null,startingSession:null,activeProcess:null,finisher:null,afterCommit:null,bucket:null,
      clockAt:Date.parse(at),stepStartedAt:Date.parse(working?.at || at),durations,
      testAllowance:s.allowance("复测"),reviewAllowance:s.allowance("评审"),
      testReturns:s.returned("复测").length,reviewReturns:s.returned("评审").length,deployReturns:s.returned("部署").length,
      reviewRounds:rows.filter(r=>r.type==="评审" && r.check).length,previousReviewCommit:lastMust?.sha || null,previousMustFix:lastMust?.value?.items || [],
      pendingReturn:s.undelivered.map(r=>r.todo).join("\n\n") || null,answerCount:rows.filter(r=>r.type==="答复").length,
      facts:{name:t.name,startedAt:createdAt,stops,resumes:rows.filter(r=>["续跑","答复","加轮"].includes(r.type)).length},
      ...(c && {retest:{commit:c.commit,result:c.result,attempt:c.attempt,missingScenarios:c.missingScenarios || [],canAccept:false,
        stale:test?.key!==s.key,detail:c.detail,evidence:c.evidence}})}};
  if (!verbose) return status;
  const audit=rows.filter(r=>r.type==="完成" || r.type==="合入" && (r.result==="成功" || !r.kind)).flatMap(r=>{
    const sha=r.sha || r.check?.commit || delivery?.commit, b=r.key ? {key:r.key,tree:r.boundTree || r.check?.tree || ""} : sha && maybe(()=>binding(l,sha));
    const p=sha && b && evidence(rows.slice(0,rows.indexOf(r)),sha,b.key,b.tree);
    return p && (p.verified || p.accepted) ? [] : [{record:r.n,step:r.type,sha,reason:"缺放行证据 A 或 B"}];
  });
  return {...status,ledger:{
    decisions:rows.filter(r=>r.rule!==undefined).map(r=>({at:r.at,rule:r.rule,step:r.step,text:r.text})),
    waiting:wait ? {reason:wait.wait,detail:wait.text,options} : null,audit,recovery:recovery(rows)
  }};
}
const recovery=(rows:Entry[])=>({retries:rows.filter(r=>r.retry && (r.type==="开始" || r.type==="发回")).length, receipts:rows.filter(r=>r.type==="提交").length,
  reformats:rows.flatMap(r=>r.check?.evidence || []).filter(f=>f.includes("重排原文")).length,
  unstable:rows.filter(r=>r.flaky).length,triage:rows.filter(r=>r.type==="分诊").map(r=>r.result)});
export function publish(l:Ledger) {
  const s=report(l),{dir}=l, lines=(name:string,rows:unknown[])=>atomicWrite(join(dir,name),rows.map(r=>JSON.stringify(r)+"\n").join(""));
  writeJson(join(dir,"task.json"),l.task);
  lines("checks.jsonl",l.checks);
  for (const [type,file] of [["答复","answers.jsonl"],["窗口原话","窗口原话.jsonl"]]) {
    const records=l.rows.filter(r=>r.type===type).map(({at,text})=>({at,text,...(type==="窗口原话" && {source:"pi-tui"})}));
    if (records.length) lines(file,records);
  }
  const summary=[`# ${s.executionId}`,`${s.loop.phase}：${s.message}`, ...l.checks.map(c=>`- ${c.step} / ${c.result} · ${(c.durationMs/1000).toFixed(2)}s`),
    ...(l.task.config.notifyAutoSummary ? ["自动处理："+JSON.stringify(recovery(l.rows))] : [])];
  if (s.state==="completed" && l.task.config.notifyAutoSummary) maybe(()=>batchResult(l.task,
    ["",`## ${l.task.executionId} · ${s.loop.commit}`,s.message,summary.at(-1)!],`<!-- dev-loop:${l.task.executionId}:${s.loop.commit}:${s.loop.phase} -->`));
  atomicWrite(join(dir,"summary.md"),summary.join("\n\n")+"\n");
  writeJson(join(dir,"status.json"),s);
  idleSleep(dir,s.state==="working" && s.message!=="本人中止，等本人说话",l.task.config.tickIntervalSec);
  return s;
}
export function publicStatus(dir:string) {
  if (hasLedger(dir)) return report(new Ledger(dir),true);
  const s=readJson<any>(join(dir,"status.json"));
  s.loop.answerCount=maybe(()=>jsonLines(join(dir,"answers.jsonl")).length) || 0;
  return s;
}
