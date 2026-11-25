import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { alive, identity, signalProcess } from "../infra/exec.ts";
import { BusyError, errorText, maybe } from "../infra/files.ts";
import { entrypoint, tasksRoot, wake } from "../infra/paths.ts";
import { Ledger, allTasks, hasLedger, locked, type Entry, type Job, type Step } from "../core/store.ts";
import { state, success, returnedMessage, resets, batchReady, batchPresent, pendingDeploy, waiting, windowSuspended } from "../core/state.ts";
import { candidate } from "../core/receive.ts";
import { publish } from "../core/view.ts";
import { newContext } from "../hosts/launch.ts";
import { recoverWindowMerge } from "../steps/merge.ts";
const circle="⓪①②③④⑤⑥⑦⑧";
export function decide(l:Ledger,now=Date.now()) {
  const s=state(l), {rows,t,ready,wait,stop,settled,sha,key,proofs,complete}=s;
  type Decision=Omit<Entry,"n"|"at"> & {job?:Partial<Job> & {step:Step}};
  const say=(rule:number,text:string,data:Partial<Decision>={}):Decision=>({type:"调度",rule,text,...data});
  const tool=(rule:number,step:Step,options:Partial<Job>={})=>say(rule,"启动"+step,{step,job:{step,sha,key,auto:true,...options}});
  const hold=(rule:number,why:Entry["wait"],text:string,fields:Partial<Decision>={})=>say(rule,text,{type:"等本人",wait:why,...fields});
  const effect=pendingDeploy(l);
  if (effect && !s.running && !s.queued) {
    const failed=rows.findLast(r=>r.type==="部署" && r.kind==="环境" && (r.ref===effect.ref || r.repair===effect.ref));
    if (!failed || rows.some(r=>r.n>failed.n && (r.type==="续跑" || r.type==="答复"))) return tool(8,"部署",{sha:effect.sha,key:"",repair:effect.ref});
    if (!wait) return hold(8,"环境修不好",failed.text || "部署结果不明确，自动回退失败",{step:"部署"});
  }
  if (!batchPresent(l)) return;
  if (stop) return stop===l.last("停") && stop.result==="已放弃" && !rows.some(r=>r.type==="放弃" && success(r)) && !s.running && !s.queued
    ? tool(2,"放弃") : undefined;
  if (wait) return say(1,"等待："+wait.wait);
  if (complete && ready && s.delivery && !t.after.length && !s.todo.length && !s.running && !s.queued && !s.suspended) {
    // 已授权的自动收尾另走原规则。本分支只认完成之后的原话，不核放行证据。
    const intents=rows.filter(r=>r.type==="合入意图" && r.sha===sha && r.n>complete.n);
    const pending=intents.find(r=>!rows.some(e=>e.type==="合入" && e.intent===r.n));
    if (pending) return tool(8,"合入",{intent:pending.n,key:pending.key || ""});
    if (!s.side("合入")) {
      const quote=rows.find((r,i)=>{
        if (r.n<=complete.n || r.type!=="窗口原话" || r.text?.trim()!=="合入" || intents.some(e=>e.ref===r.n)) return false;
        const before=rows.slice(0,i); // 这一句本身可以解除疑问或 Esc 中止，但不能追认成放行意图。
        return !waiting(before) && !windowSuspended(before);
      });
      if (quote) return say(8,quote.text!,{type:"合入意图",step:"合入",ref:quote.n,sha,key:complete.key || ""});
    }
  }
  if (s.running || s.queued || s.busy || s.suspended) return say(2,s.suspended ? "本人中止，等本人说话" : s.busy ? "窗口忙" : "已有工具在跑");
  if ((!ready || !s.windowLive && s.todo.length) && !batchReady(l)) return say(0,"等待同批前置卡或窗口名额");
  const cutoff=rows.findLast(r=>resets.includes(r.type))?.n || 0;
  const retries=rows.filter(r=>r.retry && (r.type==="开始" || r.type==="发回")).length, cfg=t.config;
  const lastEnd=(step:Step,hash=key,target?:string)=>rows.findLast(r=>
    r.type===step && !r.repair && r.n>cutoff && (!hash || r.key===hash) && (target===undefined || r.target===target));
  const tri=(cause:Entry)=>rows.findLast(r=>r.type==="分诊" && Number(r.target)===cause.n && !r.kind);
  const retry=(rule:number,step:Step,fail:Entry,attempts:number,again:()=>Decision):Decision=>{
    if (attempts>=cfg.retry.times || retries>=cfg.cardRetryBudget) return hold(rule,"环境修不好",
      `${fail.text || step+"失败"}\n已自动重试 ${attempts} 次，本卡累计 ${retries} 次。`,{step});
    if (now<Date.parse(fail.at)+cfg.retry.delaysMin[attempts]*60000) return say(rule,"按退避等候重试："+step,{step});
    return again();
  };
  const attempt=(rule:number,step:Step,extra:Partial<Job>={},failure=lastEnd(step,extra.key ?? key,extra.target)):Decision=>{
    if (!failure?.kind) return tool(rule,step,extra);
    const how=tri(failure)?.result; if (failure.kind==="环境") return hold(rule,"环境修不好",failure.text || step+"失败",{step});
    if (failure.kind==="未知" && !how) return attempt(rule,"分诊",{target:String(failure.n),key:""});
    if (how==="等本人") return hold(rule,"需求疑问",failure.text || "分诊不能确认原因",{step});
    if (how==="发回") return say(rule,failure.text || "请修复",{type:"发回",step,todo:failure.text || "请修复后交付",ref:failure.n});
    if (failure.kind==="超时" && retries<cfg.cardRetryBudget) return tool(rule,step,{...extra,retry:true});
    const n=rows.filter(r=>r.type==="开始" && r.retry && r.step===step && r.n>cutoff && r.key===(extra.key ?? key)
      && (!extra.target || r.target===extra.target)).length;
    return retry(rule,step,failure,n,()=>tool(rule,step,{...extra,retry:true}));
  };
  if (!ready) return attempt(0,"准备",{key:""});
  const devFault=settled && settled.ending!=="stop" && !settled.aborted && settled.n>cutoff && settled.n>=(s.window?.n || 0);
  const pending=s.todo.length>0, workPending=s.todo.some(r=>r.step!=="开窗口"), returned=(r:Entry)=>rows.some(e=>e.type==="发回" && e.ref===r.n);
  const rotate=(settled?.n || 0)>(s.window?.n || 0) && (newContext(settled) || (settled?.context || 0)>=cfg.newSessionAtContext);
  if ((pending || devFault || !s.windowLive && (s.windowEvent?.status==="忙" || s.mergeNotices.length)) && (!s.windowLive || rotate))
    return attempt(3,"开窗口",{key:"",file:rotate && s.windowLive ? "新会话" : undefined});
  if (devFault && !returned(settled)) {
    if (settled.ending!=="error") return say(3,"非 stop："+settled.ending+"，不收货、不评审、不扣轮数",{type:"发回",ref:settled.n,todo:undefined});
    const base=rows.findLast(r=>r.status==="闲" && r.ending==="stop")?.n || 0;
    const n=rows.filter(r=>r.retry && r.step==="开窗口" && r.type==="发回" && r.n>Math.max(cutoff,base)).length;
    const raw=settled.error || settled.text || "无详情";
    return retry(3,"开窗口",{...settled,text:raw},n,()=>say(3,"开发出错，退避后继续",{
      type:"发回",ref:settled.n,step:"开窗口",retry:true,todo:"继续。上次出错："+raw
    }));
  }
  if (s.undelivered.length && s.windowLive) return say(2,"等窗口送达待办");
  const attemptRow=rows.findLast(r=>r.type==="收货" && r.n>s.last);
  if (attemptRow?.kind==="重试" && (!settled || settled.ending==="stop")) return attempt(5,"收货",{key:"",...receiptArgs(rows,attemptRow)},attemptRow);
  if (settled?.ending==="stop" && s.windowLive && (pending || settled.n>s.last) && (!s.done || pending)) {
    const c=maybe(()=>candidate(l));
    const noted=c && rows.findLast(r=>r.type==="提醒" && r.key===c.key), sent=s.sent.at(-1);
    const hadTurn=sent && sent.n<settled.n && (settled.ref===s.window?.n), actionable=!!c?.changed && (settled.n>s.last || hadTurn);
    if (actionable && !noted) return say(4,"提醒一次",{type:"提醒",key:c.key,todo:"做完了就调交付；没做完就接着做；要本人拍板就调 loop 提问。"});
    if (actionable && noted || workPending && hadTurn) {
      const d=tri(settled); if (!d) return attempt(5,"分诊",{target:String(settled.n),key:""});
      if (d.result==="收货" && c && (c.changed || proofs?.review?.blocker && s.todo.every(r=>r.type==="答复"))) return attempt(5,"收货",{key:"",note:settled.text});
      if (d.result==="重跑") return rows.some(r=>r.type==="发回" && r.step==="分诊" && r.n>s.last && r.key===c?.key)
        ? hold(5,"开发推不动",settled.text || "继续后仍无进展") : say(5,"分诊建议继续",{type:"发回",key:c?.key,step:"分诊",ref:settled.n,todo:"继续完成现有待办；做完交付，有疑问先提问。"});
      return hold(5,"需求疑问",d.text || "尚不能确认已经做完，需本人说明");
    }
  }
  if (!proofs?.accepted && (devFault || settled && !["stop","aborted"].includes(settled.ending || "") && settled.n>=(s.window?.n || 0))) return;
  if (!s.delivery || workPending) return;
  if (!s.b) return hold(6,"环境修不好","无法读取本次复测与评审的输入",{step:"复测"});
  const {test,review,verified,accepted}=proofs!, product=(r:Entry,step:"复测"|"评审"|"部署")=>{
    if (returned(r)) return;
    const items=r.value?.items || [], raw=r.text || (items.length ? "评审必修：\n"+items.join("\n") : "按检查原文修复后交付");
    return say(8,raw,{type:"发回",ref:r.n,step,count:1,value:{items},todo:raw,
      ...(s.returned(step).length+1>=s.allowance(step) && {wait:"轮数用完",level:step,text:returnedMessage(s,step,raw)})});
  };
  if (!accepted) {
    if (test?.kind==="产品") return product(test,"复测");
    if (!test?.check || !["通过","没验证"].includes(test.check.result)) return attempt(6,"复测");
    if (review?.blocker) return rows.some(r=>r.n>review.n && (r.type==="答复" || r.type==="窗口原话"))
      ? attempt(7,"评审") : hold(8,"需求疑问",review.blocker,{ref:review.n,step:"评审"});
    if (review?.check?.result==="必修") return product(review,"评审");
    if (!review?.check || review.check.result!=="通过") return attempt(7,"评审");
    if (!verified) return t.after.length ? hold(8,"需求疑问","复测未验证，不能自动收尾；须有真实复测通过或本人接受未验证") : undefined;
  }
  if (verified && !rows.some(r=>r.type==="完成" && r.sha===sha && r.key===key)) return say(8,"复测与评审通过",{type:"完成",sha,key,boundTree:s.b.tree});
  for (const step of [...t.after,...(t.after.length ? ["释放"] : [])] as Step[]) {
    if (s.side(step)) continue;
    const failure=lastEnd(step); if (failure?.kind==="产品" && step==="部署") return product(failure,"部署");
    if (failure?.kind==="冲突") {
      if (returned(failure)) return;
      if (rows.filter(r=>r.type==="发回" && r.step==="合入" && r.n>cutoff).length>=cfg.retry.times) return hold(8,"开发推不动",failure.text || "反复合入冲突",{step});
      return say(8,"合入冲突发回，不扣轮数",{type:"发回",step,ref:failure.n,todo:failure.text+"\n将 dev 合入任务分支，解决冲突后重新交付。"});
    }
    return attempt(8,step);
  }
}
function receiptArgs(rows:Entry[],result:Entry) {const s=rows.find(r=>r.n===result.ref);return {note:s?.note,images:s?.images};}
export function tick(target?:string,root=tasksRoot(),now=Date.now(),env=process.env) {
  const decisions:unknown[]=[], errors:unknown[]=[];
  for (const dir of (target ? [target] : allTasks(root)).filter(hasLedger)) try {
    const followUp=locked(dir,l=>{
      let advance=false;
      for (const dead of state(l,false).starts.filter(r=>!alive(r.owner))) {
        const opened=dead.step==="开窗口" && l.rows.some(r=>r.type==="窗口" && r.status==="开" && r.ref===dead.n);
        if (!opened) for (const e of l.rows.filter(r=>r.type==="子进程" && r.ref===dead.n)) signalProcess(e.owner,e.status!=="窗口");
        const fallback=opened ? {result:"成功"} : {result:"失败",kind:"重试" as const,text:"工具进程已退出，未留下结论"};
        const outcome=dead.step==="合入" && dead.intent ? recoverWindowMerge(l,dead) : fallback;
        l.add({type:dead.step!,step:dead.step,sha:dead.sha,key:dead.key,target:dead.target,repair:dead.repair,ref:dead.n,intent:dead.intent,...outcome},now);
      }
      const decision=decide(l,now); if (decision) {
        const {job,...row}=decision;
        const reply={executionId:l.task.executionId,rule:circle[row.rule!],action:row.text}; decisions.push(reply);
        if (job) {
          const log=openSync(join(dir,"worker.log"),"a");
          try {
            const id=(l.rows.at(-1)?.n || 0)+1, p=spawn(process.execPath,[entrypoint,"_worker",dir,String(id),job.step],{
              env:{...env,LOOP_ROLE:undefined,LOOP_TASK_DIR:undefined},detached:true,stdio:["ignore",log,log]
            });
            p.on("error",console.error); p.unref(); l.add({...row,...job,owner:p.pid ? identity(p.pid) : undefined},now);
          } finally {closeSync(log);}
        } else if (row.type!=="调度" || l.last("调度")?.text!==row.text || l.last("调度")?.owner) {
          l.add(row,now); advance=row.type==="完成" || row.type==="合入意图";
        }
      }
      if (l.task.after.length && (l.open.batch?.length || 0)>1) {
        const s=state(l); if (s.done) signalProcess(s.window?.owner);
      }
      publish(l);
      return advance;
    },0);
    if (followUp) wake(dir,env);
  } catch(e) {if(!(e instanceof BusyError)) errors.push({dir,error:errorText(e)});}
  return {decisions,errors};
}
