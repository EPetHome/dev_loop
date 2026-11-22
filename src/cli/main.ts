import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_ROOT, tasksRoot } from "../infra/paths.ts";
import { appendJson, jsonLines, withLock, readText, errorText } from "../infra/files.ts";
import { createTask, taskOf, statusOf, allTasks, locate, LoopError, type Task } from "../core/store.ts";
import { InputError, UnsupportedError } from "../core/card.ts";
import { confirmDelivery, deliver } from "../core/deliver.ts";
import { resume, stop } from "../core/lifecycle.ts";
import { merge } from "../steps/merge.ts";
import { push, type PushResult } from "../steps/push.ts";
import { deploy, rollback } from "../steps/deploy.ts";
import { validateStart } from "./start.ts";
import { finish } from "./finish.ts";
import { queued } from "./queue.ts";
import { background } from "./background.ts";
import { companion } from "./companion.ts";
import { comparison, publicStatus, releaseWorktree } from "./inspect.ts";
interface Options { command: string; target?: string; other?: string; all: boolean; task?: string; dispatch?: string; instruction?: string; note: string; words?: string; commit?: string; deliveryCommit?: string; acceptEnvironment?: string; acceptUnverified: boolean; push: boolean; automatic: boolean }
function options(args: string[]): Options {
  const command = args.shift() || "帮助", out: Options = {command,all:false,note:"",acceptUnverified:false,push:false,automatic:false};
  const flags = {"--all":"all",...(command === "合入" ? {"--接受未验证":"acceptUnverified","--推送":"push"} as const : {}),...(command === "收尾" ? {"--auto":"automatic"} as const : {})} as const;
  const fields = {"--交付提交":"deliveryCommit","--接受环境缺项":"acceptEnvironment","--task":"task","--派单编号":"dispatch",
    "--指令编号":"instruction","--说明":"note","--话":"words","--text-file":"file",...(["合入","部署"].includes(command) ? {"--commit":"commit"} as const : {})} as const;
  while (args.length) {
    const arg = args.shift()!, flag = Object.hasOwn(flags,arg) && flags[arg as keyof typeof flags];
    if (arg === "--brief" || arg === "--json") continue;
    if (flag) { out[flag] = true; continue; }
    const field = Object.hasOwn(fields,arg) ? fields[arg as keyof typeof fields] : undefined;
    if ((field === "deliveryCommit" || field === "acceptEnvironment") && (out.command !== "续跑" || out[field])) throw new InputError("仅可在续跑时指定一次 " + arg);
    if (field) {
      const value = args.shift(); if (value === undefined || (field !== "words" && (!value || value.startsWith("--")))) throw new InputError(arg + " 缺值");
      if (field === "file") out[["续跑","答复"].includes(command) ? "words" : "note"] = readText(resolve(value)); else out[field] = value;
    } else if (arg.startsWith("-")) throw new InputError("未知选项：" + arg);
    else if (out.target) { if(out.command==="对比" && !out.other)out.other=arg; else throw new InputError("只能指定一个卡或执行编号（对比最多两个）"); }
    else out.target = arg;
  }
  if ((out.deliveryCommit || out.acceptEnvironment) && (out.words !== undefined || out.note || out.deliveryCommit && out.acceptEnvironment)) throw new InputError("--交付提交 或 --接受环境缺项 不能与另一确认选项或附言同时使用");
  if (command !== "启动" && (out.instruction || out.dispatch)) throw new UnsupportedError("第 4 步才支持续跑/停止等 PA 指令编号；本步编号只用于启动回执"); return out;
}
function matching(target?: string): string[] {
  if (!target) { const dir = locate(process.cwd()); return dir ? [dir] : []; }
  const dirs = allTasks(), full = existsSync(target) ? realpathSync(target) : resolve(target);
  return dirs.filter((d)=>{const t=taskOf(d);return t.executionId===target || d===full || t.card===full;});
}
function select(o: Options): string {
  const dirs = matching(o.target).filter((d)=>!o.task || taskOf(d).name===o.task).sort((a,b)=>taskOf(b).createdAt.localeCompare(taskOf(a).createdAt));
  if (!dirs.length) throw new InputError("找不到执行，请指定卡路径或执行编号");
  const active=dirs.filter(d=>["working","input_required","failed"].includes(statusOf(d).state));
  if (active.length>1) throw new InputError("此卡有多个活动执行，请明确指定执行编号"); return active[0] || dirs[0];
}
// README 的命令表也是 CLI 帮助，避免参数和说明维护两份。
const help = () => readText(join(APP_ROOT,"README.md")).split(/^## 命令\s*$/m)[1].split(/^## /m)[0].trim();
export async function main(args = process.argv.slice(2)): Promise<unknown> {
  const o=options([...args]), root=tasksRoot();
  if (["帮助","help","--help","-h"].includes(o.command)) return help();
  if (o.command==="启动") {
    if (!o.target) throw new InputError("启动需要开发卡路径");
    let t: Task | undefined;
    const create = () => {
      const found = o.instruction && allTasks(root).flatMap(d=>jsonLines<any>(join(d,"instructions.jsonl"))).find(i=>i.id===o.instruction && i.type==="启动");
      if (found) return found.result;
      validateStart(resolve(o.target!)); t = createTask(resolve(o.target!),root,o.dispatch || null);
      const result = {executionId:t.executionId,taskDir:t.dir,status:join(t.dir,"status.json"),state:"working",warnings:statusOf(t.dir).warnings};
      if (o.instruction) appendJson(join(t.dir,"instructions.jsonl"),{id:o.instruction,type:"启动",result});
      return result;
    };
    if (o.instruction) mkdirSync(root,{recursive:true});
    const receipt = o.instruction ? withLock(join(root,"instructions.lock"),create) : create();
    if (t) await background(t); return receipt;
  }
  if(o.command==="查询") {
    if(o.all && o.target)throw new InputError("--all 与卡/执行编号不能同时使用");
    return {complete:true,executions:(o.all ? allTasks(root) : matching(o.target)).map(publicStatus)};
  }
  if(o.command==="交付") {
    const dir=locate(process.cwd()); if (!dir) throw new InputError("当前目录没有任务；请在登记的 worktree 内交付或设置 LOOP_TASK_DIR"); return deliver(dir,o.note);
  }
  if(o.command==="续跑" || o.command==="答复") {
    const dir = select(o), t = taskOf(dir), confirmFlag = o.deliveryCommit ? "--交付提交" : o.acceptEnvironment ? "--接受环境缺项" : "";
    if (confirmFlag && o.target !== t.executionId) throw new InputError(confirmFlag+" 须指定查询给出的执行编号");
    if (o.deliveryCommit) {
      const receipt=confirmDelivery(dir,o.deliveryCommit);
      if(receipt.status.loop.phase==="已交付")await background(t,{delivery:receipt.commit});
      return {executionId:t.executionId,...receipt};
    }
    const result = resume(dir,o.words,o.command === "答复",o.acceptEnvironment), {reviewRequest,phase} = result.status.loop;
    const mode = result.retest ? {retest:result.retest} : reviewRequest ? {review:reviewRequest} : phase === "收尾中" ? "finish"
      : !result.reused && !result.running ? "resume" : undefined;
    if (mode) await background(t,mode); return {executionId:t.executionId,...result};
  }
  if(o.command==="停止" || o.command==="放弃") return stop(select(o),o.command==="放弃");
  if(o.command==="对比") return comparison(select(o),o.other?select({...o,target:o.other}):undefined);
  if(o.command==="陪跑") { const dir=select(o); await companion(dir); return {executionId:taskOf(dir).executionId}; }
  if(o.command==="释放") return releaseWorktree(select(o));
  if(o.command==="收尾") return finish(select(o),o.automatic);
  if (["合入","退回","部署"].includes(o.command)) {
    const dir = select(o); return queued(dir,async () => {
      if (o.command === "部署") return deploy(dir,o);
      if (o.command === "退回") return rollback(dir);
      const r: ReturnType<typeof merge> & {push?: PushResult} = merge(dir,o);
      if (o.push) r.push = await push(dir); return r;
    });
  }
  if(["整合","验收","开发"].includes(o.command))throw new UnsupportedError("本步不支持此命令。\n"+help());
  throw new InputError("未知命令："+o.command+"\n"+help());
}
if(process.argv[1] && resolve(process.argv[1])===join(APP_ROOT,"src/cli/main.ts")) {
  main().then(result=>{console.log(typeof result==="string"?result:process.argv.includes("--json")?JSON.stringify(result):JSON.stringify(result,null,2));})
    .catch(e=>{console.error(JSON.stringify({error:{category:e instanceof InputError || e instanceof LoopError?e.category:/EACCES|EPERM|Permission denied/.test(String(e))?"权限不足":"工具内部错误",raw:errorText(e),...(e instanceof LoopError && e.result !== undefined ? {result:e.result} : {})}}));process.exitCode=1;});
}
