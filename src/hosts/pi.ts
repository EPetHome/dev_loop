import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { identity } from "../infra/exec.ts";
import { ifPresent, readText } from "../infra/files.ts";
import { wake } from "../infra/paths.ts";
import { Ledger, hasLedger, locked, type Entry } from "../core/store.ts";
import { projectedStop, pendingStarts, state } from "../core/state.ts";
import { phaseView } from "../core/view.ts";
interface Context {
  cwd:string; mode?:string; hasUI?:boolean; isIdle?():boolean; shutdown?():void; getContextUsage?():{percent:number|null}|undefined;
  ui?:{setStatus(k:string,s?:string):void; setTitle(s:string):void; setWidget?(k:string,text?:string[]):void};
  sessionManager:{getSessionId():string;getSessionFile():string|undefined;getBranch():any[]};
}
interface Pi {
  on(event:string,handler:(e:any,c:Context)=>any):void;
  sendMessage(message:{customType:string;content:string;display:boolean;details?:number},opts:{triggerTurn:boolean}):void
}
const mergeMessage="dev-loop-merge";
function savedNotice(raw:string,n:number) {
  const lines=raw.split("\n"); lines.pop(); // 不把未写完的行当送达，包括只缺 LF 的 JSON。
  return lines.some(line=>{
    if (!line.includes(mergeMessage)) return false;
    try {
      const e=JSON.parse(line);
      return e?.type==="custom_message" && e.customType===mergeMessage && e.details===n && e.display===true;
    } catch {return false;}
  });
}
export function registerPi(pi:Pi, {env=process.env,every=setInterval,clear=clearInterval}={}) {
  const dir=env.LOOP_TASK_DIR, ref=Number(env.LOOP_WINDOW_JOB); if (!dir || !hasLedger(dir) || !ref || env.LOOP_PI_WINDOW_OWNER!==String(process.ppid)) return;
  let window=0, widget=0, timer:ReturnType<typeof setInterval>|undefined, sending=false, title="";
  const content=(msg:any)=>Array.isArray(msg?.content)
    ? msg.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n") : String(msg?.content || "");
  const event=(data:Partial<Entry>)=>{
    if (!window) return;
    locked(dir,l=>{
      if (l.rows.findLast(r=>r.type==="窗口" && r.status==="开")?.n===window && !projectedStop(l)) l.add({type:"窗口",ref:window,...data});
    });
    wake(dir,env);
  };
  pi.on("session_start",(_e,ctx)=>{
    const id=ctx.sessionManager.getSessionId();
    const opened=locked(dir,l=>{
      if (projectedStop(l) || ctx.cwd!==l.task.worktree || id!==env.LOOP_EXPECT_SESSION
        || !pendingStarts(l).some(r=>r.step==="开窗口" && r.n===ref) || state(l,false).windowLive) return;
      return l.add({type:"窗口",status:"开",ref,owner:identity(),file:ctx.sessionManager.getSessionFile(),value:{id}});
    });
    if (!opened) {ctx.shutdown?.(); return;} window=opened.n; wake(dir,env);
    timer=every(()=>{
      try {
        const ui=ctx.hasUI && ctx.ui, l=new Ledger(dir), s=state(l,!!ui);
        if (s.stop) {ctx.shutdown?.(); return;}
        if (s.window?.n!==window) return;
        const {mergeNotices}=s, entries=s.undelivered;
        const receiptWindow=s.complete && !s.t.after.length && !s.todo.length;
        const opening=!s.sent.length && !receiptWindow && env.LOOP_OPENING;
        if (!sending && !s.busy && !s.wait && !s.suspended && (!s.running || s.running.step==="开窗口") && ctx.isIdle?.()!==false && (opening || entries.length)) {
          sending=true;
          try {
            const text=[opening ? readText(opening) : "",...entries.map(r=>r.todo)].filter(Boolean).join("\n\n");
            pi.sendMessage({customType:"dev-loop-todo",content:text,display:true},{triggerTurn:true});
            locked(dir,current=>current.add({type:"送达",ref:window,sent:entries.map(r=>r.n)})); wake(dir,env);
          } finally {sending=false;}
        }
        if (ui) {
          const {phase,detail}=phaseView(l,s);
          const visible=phase==="完成" && s.proofs?.verified && !s.complete ? "收尾中" : phase;
          const next=`【${visible}】${s.t.name}${detail ? " · "+detail : ""} · 已用 ${s.returned("评审").length} 评审轮`;
          if (next!==title) {ui.setStatus("dev-loop","dev-loop "+next);ui.setTitle(next);title=next;}
          if (ctx.isIdle?.()!==false) for (const r of mergeNotices) {
            const text=r.result==="成功" ? `本地 dev ${r.value.result}：${r.value.devAfter}（未推送、未部署）`
              : `合入失败：${r.text || r.result}`;
            const file=ctx.sessionManager.getSessionFile(), raw=file && ifPresent(()=>readText(file));
            if (!file || !raw) {
              // 新会话还没有磁盘记录时也能看回执；不把临时显示当作会话已保存。
              if (widget!==r.n) { ui.setWidget?.(mergeMessage,[text]); widget=r.n; }
              continue;
            }
            if (!savedNotice(raw,r.n)) {
              // ENOSPC 可能只留下半行；隔开失效尾帧，使重发能独立落盘，不改已有字节。
              if (!raw.endsWith("\n")) {
                const session=realpathSync(file);
                if (!session.startsWith(join(dir,"sessions")+"/")) continue;
                appendFileSync(session,"\0\n");
              }
              pi.sendMessage({customType:mergeMessage,content:text,display:true,details:r.n},{triggerTurn:false});
              if (!savedNotice(readText(file),r.n)) continue;
            }
            locked(dir,current=>current.add({type:"合入送达",ref:r.n,source:window}));
            if (widget===r.n) { ui.setWidget?.(mergeMessage); widget=0; }
          }
        }
      } catch(e) {console.error("dev-loop 待办：",e);}
    },opened && new Ledger(dir).task.config.inboxIntervalMs); timer?.unref?.();
  });
  pi.on("agent_start",()=>event({status:"忙"}));
  pi.on("input",(e,ctx)=>{ if (ctx.mode==="tui" && e.source==="interactive" && e.text) event({type:"窗口原话",text:e.text}); });
  pi.on("agent_settled",(e,ctx)=>{
    const last=ctx.sessionManager.getBranch().findLast(x=>x.message?.role==="assistant")?.message;
    const usage=ctx.getContextUsage?.()?.percent;
    event({status:"闲",text:content(last),ending:e.aborted ? "aborted" : last?.stopReason || "pending",
      error:last?.errorMessage,aborted:!!e.aborted,context:usage==null ? undefined : usage/100,file:ctx.sessionManager.getSessionFile()});
  });
  pi.on("session_shutdown",(_e,ctx)=>{ if (timer) clear(timer); event({status:"断"}); window=0; if (ctx.hasUI) ctx.ui?.setStatus("dev-loop"); });
}
export default (pi:Pi)=>registerPi(pi);
