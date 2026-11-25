import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { locked, Ledger, LoopError, type Step, type Job, type Entry, type Outcome } from "../core/store.ts";
import { state, success, batchReady, batchPresent } from "../core/state.ts";
import { publish } from "../core/view.ts";
import { binding, devRef, requireGate } from "../core/inputs.ts";
import { candidate, onBranch, receive } from "../core/receive.ts";
import { check, prepare, triage } from "../core/checks.ts";
import { snapshot } from "../core/snapshot.ts";
import { InputError } from "../core/card.ts";
import { openWindow } from "../hosts/launch.ts";
import { merge } from "../steps/merge.ts";
import { deploy } from "../steps/deploy.ts";
import { push } from "../steps/push.ts";
import { gitText, commitOf, tree, worktreeOf, isAncestor, releaseChanges } from "../infra/git.ts";
import { identity, signalProcess } from "../infra/exec.ts";
import { errorText, maybe, span, underLock } from "../infra/files.ts";
import { APP_ROOT, wake } from "../infra/paths.ts";
import { projectFile } from "../infra/project.ts";
import { clearCheck } from "../core/run.ts";
const finishes=["合入","部署","推送","释放","退回"], checkedSteps=["复测","评审",...finishes];
export async function worker(dir:string,job:Partial<Job> & {step:Step},request?:number,accept?:string) {
  let start:Entry|undefined, b:ReturnType<typeof binding>|undefined;
  const finish=(l:Ledger,j:Entry,o:Outcome) => {
    const check=o.check && {...b?.hashes,promptHash:b?.hashes.promptHash || "",acceptanceHash:b?.hashes.acceptanceHash || "",...o.check,tree:o.check.tree || tree(l.task.repo,o.check.commit)};
    const row=l.add({type:j.step==="准备" && !o.kind ? "准备好" : j.step!, step:j.step,ref:j.n,sha:j.sha,key:j.key,target:j.target,...o,check}); publish(new Ledger(dir)); return row;
  };
  try {
    const claim=locked(dir,l=>{
      const s=state(l), {t}=s, scheduled=request && s.queued?.n===request && s.queued.owner?.pid===process.pid ? s.queued : undefined;
      if (request && !scheduled) return {skipped:true};
      const j=scheduled || job, step=job.step;
      if (step!=="放弃" && (s.stop || s.suspended || s.wait && !accept && step!=="退回")) throw new InputError("任务当前暂停，请查询等待原因");
      if (accept && !accept.trim()) throw new InputError("接受未验证须有本人原话");
      if (s.running && (step!=="收货" || !["复测","评审"].includes(s.running.step!)) || s.queued && !scheduled && step!=="收货") throw new InputError("已有工具在运行");
      if (["开窗口","准备"].includes(step) && (!batchPresent(l) || !batchReady(l))) throw new InputError("等待同批前置卡或窗口名额");
      if (step!=="准备" && step!=="放弃" && !s.ready) throw new InputError("工作区尚未准备好");
      if (s.side("释放")?.value?.released && ["收货","开窗口"].includes(step)) throw new InputError("工作区已释放");
      const old=step==="退回" ? l.rows.findLast(r=>r.type==="部署" && r.result==="成功")?.sha : undefined;
      const sha=step==="准备" ? l.last("准备好")?.sha || t.baseCommit || commitOf(t.repo,"refs/heads/"+t.base) : step==="收货" ? candidate(l).sha : j.sha || old || s.sha;
      if (j.sha && !["准备","收货"].includes(step) && sha!==s.sha && step!=="退回") throw new InputError("目标已变化：当前收货为 "+s.sha);
      if (job.target && checkedSteps.includes(step) && commitOf(t.repo,job.target)!==sha) throw new InputError("目标已变化：当前收货为 "+sha);
      if (checkedSteps.includes(step) && (s.busy || s.settled?.ending && s.settled.ending!=="stop" && s.settled.n>s.last && !accept)) throw new InputError("等待开发窗口正常停下");
      if (step==="收货" && (request && s.busy || !s.busy && s.settled && s.settled.ending!=="stop")) throw new InputError("本轮未正常结束，不收货");
      if (checkedSteps.includes(step)) {
        if (!s.delivery) throw new InputError("没有交付记录"); b=binding(l,sha);
        if (j.key && j.key!==b.key) throw new InputError("检查输入已变化，重新调度");
        if (accept && !s.proofs?.verified && !s.proofs?.accepted) l.add({type:"接受未验证",sha,key:b.key,text:accept});
        if (finishes.includes(step) && step!=="退回") requireGate(l,sha);
      }
      const key=b?.key || j.key || "";
      const cached=l.rows.findLast(r=>r.type===step && r.sha===sha && r.key===key && success(r));
      if (step==="准备" && s.ready || step==="开窗口" && s.windowLive && !j.file || cached && !["开窗口","退回","分诊","收货"].includes(step)) return {cached:cached?.value || cached?.check || {executionId:t.executionId,result:"已就绪"}};
      if (step==="评审" && s.returned("评审").length>=s.allowance("评审") || step==="复测" && s.returned("复测").length>=s.allowance("复测")) throw new InputError("轮数用完，须本人加轮");
      if (step==="释放" && t.after.some(k=>!s.side(k))) throw new InputError("尚未完成卡上约定的收尾");
      const {note,images,retry,file,auto,target}=j, devBefore=step==="合入" && !isAncestor(t.repo,sha,devRef) ? commitOf(t.repo,devRef) : undefined;
      start=l.add({type:"开始",step,sha,key,source:request,retry,note,images,file,auto,target,owner:identity(),devBefore});
      if (step==="收货") {
        let row:Entry;
        try {row=l.add(receive(l,start));}
        catch (e) {
          const text=errorText(e), expected=e instanceof InputError;
          row=l.add({type:"收货",ref:start.n,sha,key,result:"失败",text,kind:expected ? "产品" : "重试",...(expected && {todo:text})});
          publish(l); throw new LoopError(expected ? "输入问题" : "工具内部错误",text,row.value);
        }
        publish(l); return {cached:{commit:row.sha,tree:row.value.tree,reused:row.type!=="提交"}};
      }
      if (step==="开窗口" && j.file) signalProcess(s.window?.owner);
      publish(l); return {ledger:l};
    }); if (!claim.ledger) return claim.cached;
    const l=claim.ledger,j=start!,t=l.task; process.env.LOOP_JOB=String(j.n);
    const run=async ():Promise<Outcome>=>{
      switch (j.step) {
        case "准备":return prepare(l,j); case "开窗口":return openWindow(l,j); case "复测":case "评审":return check(l,j,b!);
        case "分诊":return triage(l,j); case "合入":return merge(l,j); case "部署":case "退回":return deploy(l,j); case "推送":return push(l,j);
        case "陪跑": await snapshot(t,t.worktree,j.sha!,join(dir,"snapshot-base.json"),"scenario",{deadline:Date.now()+t.config.snapshotTimeoutMin*60000}); return {result:"成功"};
        case "释放":case "放弃":return locked(dir,current=>{
          if (state(current,false).busy) throw new Error("窗口尚未停下");
          const abandon=j.step==="放弃", present=existsSync(t.worktree);
          if (present) onBranch(t); else if (worktreeOf(t.repo,t.branch)) throw new Error("登记的工作区已移动，保留现场");
          const dirty=present && !abandon && releaseChanges(t.worktree), value={executionId:t.executionId,released:!dirty || !dirty.length};
          if (value.released) {signalProcess(state(current,false).window?.owner);clearCheck(t);if(present)gitText(t.repo,["worktree","remove",...(abandon?["--force"]:[]),t.worktree]);}
          return {result:"成功",value,check:b && {...b.hashes,...span(Date.parse(j.at)),step:j.step!,commit:j.sha!,tree:b.tree,result:value.released ? "已释放" : "保留",evidence:[],detail:dirty ? dirty.join("\n") : undefined}};
        });
        default:throw new Error("未知工具");
      }
    };
    let out:Outcome;
    try {out=finishes.includes(j.step!) ? await underLock(projectFile(dirname(dir),t.repo,"operations"),run,2000) : await run();}
    catch(e) {const text=errorText(e); out={result:"失败",kind:["准备","开窗口"].includes(j.step!) || /fetch failed|超时|setup 失败|timed out|正在处理|connection/i.test(text) ? "重试" : "未知",text};}
    const row=locked(dir,current=>{
      if (state(current,false).stop && j.step!=="放弃") out={result:"已停止"};
      // P2 照记旧提交；正式输入漂移不能成为当前输入的通过结论。
      if (b && ["复测","评审"].includes(j.step!) && maybe(()=>binding(current,j.sha!).key)!==b.key) out={...out,result:"失败",kind:"重试",text:"检查期间输入变化",check:out.check && {...out.check,result:"失败"}};
      return finish(current,j,out);
    });
    if (row.kind) throw new LoopError(row.kind==="重试" ? "临时故障" : "输入问题",row.text || row.kind,row.value);
    return row.value || row.check || {executionId:t.executionId,result:row.result};
  } finally {if (start) {delete process.env.LOOP_JOB; wake(dir);}}
}
