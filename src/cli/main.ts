import { mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_ROOT, tasksRoot } from "../infra/paths.ts";
import { appendJson, jsonLines, withLock } from "../infra/files.ts";
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
interface Options { command: string; target?: string; other?: string; all: boolean; brief: boolean; json: boolean; task?: string; dispatch?: string; instruction?: string; note: string; words?: string; commit?: string; deliveryCommit?: string; acceptUnverified: boolean; push: boolean; automatic: boolean }
function options(args: string[]): Options {
  const out: Options = { command: args.shift() || "帮助", all: false, brief: false, json: false, note: "", acceptUnverified: false, push: false, automatic: false };
  while (args.length) {
    const arg = args.shift()!;
    if (["--all","--brief","--json"].includes(arg)) { out[arg.slice(2) as "all" | "brief" | "json"] = true; continue; }
    if (arg === "--接受未验证" && out.command === "合入") { out.acceptUnverified = true; continue; }
    if (arg === "--推送" && out.command === "合入") { out.push = true; continue; }
    if (arg === "--auto" && out.command === "收尾") { out.automatic = true; continue; }
    if (arg === "--commit" && !["合入", "部署"].includes(out.command)) throw new InputError("未知选项：" + arg);
    if (arg === "--交付提交" && (out.command !== "续跑" || out.deliveryCommit)) throw new InputError("仅可在续跑时指定一次 --交付提交");
    const field = {"--commit":"commit","--交付提交":"deliveryCommit","--task":"task","--派单编号":"dispatch","--指令编号":"instruction","--说明":"note","--话":"words","--text-file":"file"}[arg];
    if (field) {
      const value = args.shift(); if (value === undefined || (field !== "words" && (!value || value.startsWith("--")))) throw new InputError(arg + " 缺值");
      if (field === "file") out[["续跑", "答复"].includes(out.command) ? "words" : "note"] = readFileSync(resolve(value),"utf8"); else (out as any)[field] = value;
    } else if (arg.startsWith("-")) throw new InputError("未知选项：" + arg);
    else if (out.target) { if(out.command==="对比" && !out.other)out.other=arg; else throw new InputError("只能指定一个卡或执行编号（对比最多两个）"); }
    else out.target = arg;
  }
  if (out.deliveryCommit && (out.words !== undefined || out.note)) throw new InputError("--交付提交 不能与 --话、--text-file 或 --说明 同时使用");
  if (out.command !== "启动" && (out.instruction || out.dispatch)) throw new UnsupportedError("第 4 步才支持续跑/停止等 PA 指令编号；本步编号只用于启动回执");
  return out;
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
  if (active.length>1) throw new InputError("此卡有多个活动执行，请明确指定执行编号");
  return active[0] || dirs[0];
}
const help = `bin/loop 启动 <version:1 单任务卡> [--派单编号 X] [--指令编号 Y] --json
bin/loop 交付 [--说明 文本 | --text-file 文件] [--json]
bin/loop 查询 [<卡或执行编号> | --all] [--brief] [--json]
bin/loop 续跑 <卡或执行编号> [--话 文本 | --text-file 文件] [--task 名] [--json]
bin/loop 续跑 <执行编号> --交付提交 <完整SHA> [--json]
bin/loop 答复 <卡或执行编号> (--话 文本 | --text-file 文件) [--task 名] [--json]
bin/loop 停止|放弃 <卡或执行编号> [--task 名] [--json]
bin/loop 合入 <执行编号或卡路径> [--commit <sha>] [--接受未验证] [--推送] [--json]
bin/loop 部署 <执行编号或卡路径> [--commit <sha>] [--json]
bin/loop 收尾|退回|陪跑|释放 <执行编号或卡路径> [--json]
bin/loop 对比 <执行编号或卡路径> [<另一个执行编号或卡路径>] [--json]
flow 按卡执行；next 相对卡目录，最后一批才合入、部署。手工合入默认仅本地；部署的 deploy.cmd、check/rollback、deploy.env 见 README。
LOOP_TASKS_ROOT 指向执行根目录，开发方优先用 LOOP_TASK_DIR 定位任务。
仅「等你」时可答复；Claude/Codex 未送达，需在窗口里说。「停下没交付」且查询给出 loop.deliveryConfirmation 时，可确认已有提交并在后台检查。完整用法见 README.md。`;
export async function main(args = process.argv.slice(2)): Promise<unknown> {
  const o=options([...args]), root=tasksRoot();
  if (["帮助","help","--help","-h"].includes(o.command)) return help;
  if (o.command==="启动") {
    if (!o.target) throw new InputError("启动需要开发卡路径");
    const previous = () => allTasks(root).flatMap(d=>jsonLines<any>(join(d,"instructions.jsonl"))).find(i=>i.id===o.instruction && i.type==="启动");
    if (o.instruction) { const found=previous(); if(found)return found.result; }
    // createTask 在所有卡/项目配置校验通过之前不创建任何执行目录。
    let t: Task | undefined, receipt: any;
    const create=()=>{
      if(o.instruction){const found=previous();if(found){receipt=found.result;return;}}
      validateStart(resolve(o.target!));
      t=createTask(resolve(o.target!),root,o.dispatch||null);
      receipt={executionId:t.executionId,taskDir:t.dir,status:join(t.dir,"status.json"),state:"working"};
      if(o.instruction)appendJson(join(t.dir,"instructions.jsonl"),{id:o.instruction,type:"启动",result:receipt});
    };
    if(o.instruction){mkdirSync(root,{recursive:true});withLock(join(root,"instructions.lock"),create);}else create();
    if(t)await background(t);
    return receipt;
  }
  if(o.command==="查询") {
    if(o.all && o.target)throw new InputError("--all 与卡/执行编号不能同时使用");
    const dirs=o.all?allTasks(root):matching(o.target);
    return {complete:true,executions:dirs.map(publicStatus)};
  }
  if(o.command==="交付") {
    const dir=locate(process.cwd()); if(!dir)throw new InputError("当前目录没有任务；请在登记的 worktree 内交付或设置 LOOP_TASK_DIR");
    return deliver(dir,o.note);
  }
  if(o.command==="续跑" || o.command==="答复") {
    const dir=select(o), t=taskOf(dir);
    if(o.deliveryCommit) {
      if(o.target!==t.executionId)throw new InputError("--交付提交 须指定查询给出的执行编号");
      const receipt=confirmDelivery(dir,o.deliveryCommit);
      if(receipt.status.loop.phase==="已交付")await background(t,{delivery:receipt.commit});
      return {executionId:t.executionId,...receipt};
    }
    const result=resume(dir,o.words,o.command==="答复");
    if(result.reviewOnly)await background(t,"review");
    else if(result.status.loop.phase==="收尾中")await background(t,"finish");
    else if(!result.reused && !result.running)await background(t,"resume");
    return {executionId:t.executionId,...result};
  }
  if(o.command==="停止" || o.command==="放弃") return stop(select(o),o.command==="放弃");
  if(o.command==="对比") return comparison(select(o),o.other?select({...o,target:o.other}):undefined);
  if(o.command==="陪跑") { const dir=select(o); await companion(dir); return {executionId:taskOf(dir).executionId}; }
  if(o.command==="释放") return releaseWorktree(select(o));
  if(o.command==="收尾") return finish(select(o),o.automatic);
  if(o.command==="合入") {
    const dir=select(o);
    return queued(dir, async () => {
      const r: ReturnType<typeof merge> & {push?: PushResult}=merge(dir, {commit:o.commit, acceptUnverified:o.acceptUnverified});
      if(o.push) r.push=await push(dir); return r;
    });
  }
  if(o.command==="退回") { const dir=select(o); return queued(dir,()=>rollback(dir)); }
  if(o.command==="部署") { const dir=select(o); return queued(dir,()=>deploy(dir, {commit:o.commit})); }
  if(["整合","验收","开发"].includes(o.command))throw new UnsupportedError("本步不支持此命令。\n"+help);
  throw new InputError("未知命令："+o.command+"\n"+help);
}
if(process.argv[1] && resolve(process.argv[1])===join(APP_ROOT,"src/cli/main.ts")) {
  main().then(result=>{console.log(typeof result==="string"?result:process.argv.includes("--json")?JSON.stringify(result):JSON.stringify(result,null,2));})
    .catch(e=>{console.error(JSON.stringify({error:{category:e instanceof InputError || e instanceof LoopError?e.category:/EACCES|EPERM|Permission denied/.test(String(e))?"权限不足":"工具内部错误",raw:e instanceof Error?e.message:String(e),...(e instanceof LoopError && e.result !== undefined ? {result:e.result} : {})}}));process.exitCode=1;});
}
