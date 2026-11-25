import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_ROOT, entrypoint, wake } from "../infra/paths.ts";
import { errorText, readText } from "../infra/files.ts";
import { allTasks, locate, locked, taskOf, hasLedger, LoopError, Ledger, type Step } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { online, state } from "../core/state.ts";
import { publicStatus, publish } from "../core/view.ts";
import { signalProcess } from "../infra/exec.ts";
import { startCards } from "./start.ts";
import { worker } from "./worker.ts";
import { tick } from "./tick.ts";
import { prove } from "../steps/proof.ts";
import { comparison, timer } from "./inspect.ts";
const help=()=>readText(join(APP_ROOT,"README.md")).split(/^## 命令\s*$/m)[1].split(/^## /m)[0].trim();
const tools:Record<string,Step>={准备:"准备",开窗口:"开窗口",复测:"复测",评审:"评审",合入:"合入",部署:"部署",推送:"推送",释放:"释放",陪跑:"陪跑",退回:"退回"};
function options(args:string[]) {
  const command=args.shift() || "帮助", files:string[]=[], images:string[]=[], edges:string[]=[], values:Record<string,string>={}, flags=new Set<string>();
  const specs:Record<string,string[]>={
    "--话":["启动","开工","答复","续跑","加轮","停止","放弃","合入","提问"],"--text-file":["答复","续跑","交付"],"--说明":["交付"],
    "--派单编号":["启动","开工"],"--指令编号":["启动","开工"],"--commit":Object.keys(tools),"--task":[command]
  };
  while (args.length) {
    const a=args.shift()!;
    if (["--json","--brief","--all"].includes(a) || command==="合入" && ["--接受未验证","--推送"].includes(a)) {flags.add(a);continue;}
    if (a==="--截图" && command==="交付") {
      while (args[0] && !args[0].startsWith("--")) images.push(resolve(args.shift()!));
      if(!images.length)throw new InputError(a+" 缺值");
      continue;
    }
    if (a==="--依赖" && ["启动","开工"].includes(command)) {
      if(!args[0] || args[0].startsWith("--"))throw new InputError(a+" 缺值");
      edges.push(args.shift()!);
      continue;
    }
    if (specs[a]?.includes(command)) {const v=args.shift();if(v===undefined || v.startsWith("--"))throw new InputError(a+" 缺值");values[a]=v;}
    else if (a.startsWith("-")) throw new InputError("未知选项："+a); else files.push(a);
  }
  const text=values["--text-file"]===undefined ? undefined : readText(resolve(values["--text-file"]));
  return {command,files,images,edges,values,flags,words:values["--话"] ?? text,
    note:values["--说明"] ?? text ?? "",target:files[0],all:flags.has("--all")};
}
function matching(target?:string) {
  if (!target) {const dir=locate(process.cwd());return dir ? [dir] : [];}
  const full=existsSync(target) ? realpathSync(target) : resolve(target);
  return allTasks().filter(d=>{const t=taskOf(d);return t.executionId===target || d===full || t.card===full;});
}
function select(target?:string,task?:string,newOnly=true) {
  const dirs=matching(target).filter(d=>!task || taskOf(d).name===task).sort((a,b)=>taskOf(b).createdAt.localeCompare(taskOf(a).createdAt));
  const active=dirs.filter(d=>["working","input_required","failed"].includes(publicStatus(d).state));
  if (active.length>1) throw new InputError("此卡有多个活动执行，请明确指定执行编号");
  const dir=active[0] || dirs[0]; if (!dir || newOnly && !hasLedger(dir)) throw new InputError("没有可推进的新版执行；旧执行只读查询"); return dir;
}
export async function main(args=process.argv.slice(2)):Promise<unknown> {
  if ([undefined,"帮助","help","--help","-h"].includes(args[0])) return help();
  if (process.env.LOOP_ROLE && !["查询","交付","提问"].includes(args[0])) throw new InputError("开发窗口只可提问、交付、查询");
  if (args[0]==="_worker") return worker(args[1],{step:args[3] as Step},Number(args[2]));
  const o=options([...args]), {command,files,words,target}=o;
  if (command==="启动" || command==="开工") return startCards(files,o.edges,words || "",o.values["--派单编号"],o.values["--指令编号"]);
  if (files.length>(["对比","加轮"].includes(command)?2:1) || o.all && target) throw new InputError("参数过多或 --all 与执行编号同时指定");
  if (command==="查询") return {complete:true,executions:(o.all ? allTasks() : matching(target)).map(publicStatus)};
  if (command==="tick") return tick(target ? select(target,undefined,false) : o.all ? undefined : locate(process.cwd()));
  if (command==="安装定时" || command==="卸载定时") return timer(command==="安装定时");
  if (command==="交付") {if(target)throw new InputError("请在登记的工作区交付");return worker(select(),{step:"收货",note:o.note,images:o.images});}
  const dir=select(command==="提问" ? undefined : target,o.values["--task"]);
  if (command==="证明") {
    if (target!==taskOf(dir).executionId)throw new InputError("证明须指定执行编号");
    const result=await prove(taskOf(dir));
    locked(dir,publish);
    return result;
  }
  if (command==="对比") return comparison(dir,files[1] && select(files[1]));
  if (Object.hasOwn(tools,command)) {
    const result=await worker(dir,{step:tools[command],target:o.values["--commit"]},undefined,o.flags.has("--接受未验证") ? words ?? "合入 --接受未验证" : undefined);
    if (command==="合入" && o.flags.has("--推送")) return {...result,push:await worker(dir,{step:"推送"})}; return result;
  }
  if (!["答复","续跑","加轮","停止","放弃","提问"].includes(command)) throw new InputError("未知命令："+command);
  if (command==="提问" && !(words || target)?.trim() || command==="答复" && !words?.trim() || words!==undefined && !words.trim()) throw new InputError("话不能为空");
  const abandon=command==="放弃", result=locked(dir,l=>{
    const s=state(l), {executionId}=l.task;
    if (command==="停止" || command==="放弃") {
      l.add({type:"停",result:abandon ? "已放弃" : "已停止",text:words});
      const halt=s.starts.filter(j=>!online(j.step));
      for (const p of l.rows.filter(r=>r.type==="子进程" && halt.some(j=>r.ref===j.n))) signalProcess(p.owner,p.status!=="窗口");
      halt.forEach(j=>signalProcess(j.owner)); if(!s.queued?.repair) signalProcess(s.queued?.owner);
      signalProcess(s.window?.owner); return publish(l);
    }
    if (s.stop?.result==="已放弃" || s.side("释放")?.value?.released) throw new InputError("工作区已释放或放弃");
    if (command==="提问") {l.add({type:"疑问",wait:"需求疑问",text:words || target});return {executionId,status:publish(l)};}
    if (command==="答复" && !s.wait && !s.suspended && !s.rows.some(r=>r.type==="答复" && r.n>s.last)) throw new InputError("答复只在等本人或本人中止时接收");
    const add=command==="加轮" ? Number(files[1]) : s.wait?.wait==="轮数用完" ? 1 : 0;
    if (command==="加轮" && (!Number.isSafeInteger(add) || add<1 || s.wait?.wait!=="轮数用完")) throw new InputError("仅在轮数用完时指定正整数加轮");
    if (add) l.add({type:"加轮",level:s.wait!.level,count:add,text:words || `${command} ${add}`});
    const resumeWindow=s.wait?.wait==="环境修不好" && s.wait.step==="开窗口" && s.settled?.ending==="error";
    const talk=resumeWindow || s.wait?.wait!=="环境修不好" && !!words || s.wait?.wait==="开发推不动" || s.wait?.wait==="需求疑问" || s.suspended;
    const intent={...(talk && {todo:words ? "本人答复："+words : "继续按当前待办；有疑问先提问。"}),...(resumeWindow && {step:"开窗口" as const})};
    if (words) l.add({type:"答复",text:words,...intent});
    if (!add && !words || command==="续跑" && s.stop) l.add({type:"续跑",text:words || "续跑",...(!words && intent)});
    return {executionId,reused:false,running:s.windowLive,status:publish(l)};
  });
  wake(dir); if(abandon) await worker(dir,{step:"放弃"}).catch(()=>{}); return result;
}
if (process.argv[1] && resolve(process.argv[1])===entrypoint) main().then(r=>{
  if (r!==undefined) console.log(typeof r==="string" ? r : JSON.stringify(r,null,process.argv.includes("--json")?0:2));
}).catch(e=>{
  const {category="工具内部错误",result}=e;console.error(JSON.stringify({error:{category,raw:errorText(e),result}}));process.exitCode=1;
});
