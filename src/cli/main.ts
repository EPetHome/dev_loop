import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_ROOT, tasksRoot } from "../infra/paths.ts";
import { appendJson, jsonLines, withLock } from "../infra/files.ts";
import { createTask, taskOf, statusOf, allTasks, locate, fail, type Task } from "../core/store.ts";
import { InputError, UnsupportedError } from "../core/card.ts";
import { deliver } from "../core/deliver.ts";
import { resume, stop } from "../core/lifecycle.ts";
interface Options { command: string; target?: string; all: boolean; brief: boolean; json: boolean; task?: string; dispatch?: string; instruction?: string; note: string }
function options(args: string[]): Options {
  const out: Options = { command: args.shift() || "帮助", all: false, brief: false, json: false, note: "" };
  while (args.length) {
    const arg = args.shift()!;
    if (["--all","--brief","--json"].includes(arg)) { out[arg.slice(2) as "all" | "brief" | "json"] = true; continue; }
    const field = {"--task":"task","--派单编号":"dispatch","--指令编号":"instruction","--说明":"note","--text-file":"file"}[arg];
    if (field) {
      const value = args.shift(); if (!value || value.startsWith("--")) throw new InputError(arg + " 缺值");
      if (field === "file") out.note = readFileSync(resolve(value),"utf8"); else (out as any)[field] = value;
    } else if (arg.startsWith("-")) throw new InputError("未知选项：" + arg);
    else if (out.target) throw new InputError("只能指定一个卡或执行编号");
    else out.target = arg;
  }
  if (out.command !== "启动" && (out.instruction || out.dispatch)) throw new UnsupportedError("第 4 步才支持续跑/停止等 PA 指令编号；本步编号只用于启动回执");
  return out;
}
async function background(t: Task, resuming = false): Promise<void> {
  const fd = openSync(join(t.dir,"launcher.log"),"a");
  try {
    const child = spawn(process.execPath, [join(APP_ROOT,"src/hosts/launch.ts"),t.dir,...(resuming ? ["--resume"] : [])],
      {cwd:t.repo,env:{...process.env,LOOP_TASK_DIR:t.dir},detached:true,stdio:["ignore",fd,fd]});
    await new Promise<void>((accept,reject)=>{child.once("spawn",accept);child.once("error",reject);});
    // 启动器在自身入口登记身份；前台不在后台退出后倒写一个过期的 PID。
    child.unref();
  } catch(e) { fail(t.dir,e); throw e; }
  finally { closeSync(fd); }
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
bin/loop 续跑|停止|放弃 <卡或执行编号> [--task 名] [--json]
LOOP_TASKS_ROOT：执行根目录；开发方优先通过 LOOP_TASK_DIR 定位任务。
第 1 步不含合入（第2步）、多任务/验收（第3步）、答复（第4步）、部署（以后）。`;
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
    return {complete:true,executions:dirs.map(statusOf)};
  }
  if(o.command==="交付") {
    const dir=locate(process.cwd()); if(!dir)throw new InputError("当前目录没有任务；请在登记的 worktree 内交付或设置 LOOP_TASK_DIR");
    return deliver(dir,o.note);
  }
  if(o.command==="续跑") {
    const dir=select(o), result=resume(dir);
    if(!result.reused && !result.running)await background(taskOf(dir),true);
    return {executionId:taskOf(dir).executionId,...result};
  }
  if(o.command==="停止" || o.command==="放弃") return stop(select(o),o.command==="放弃");
  if(["合入","整合","验收","答复","开发","部署"].includes(o.command))throw new UnsupportedError("本步不支持此命令。\n"+help);
  throw new InputError("未知命令："+o.command+"\n"+help);
}
if(process.argv[1] && resolve(process.argv[1])===join(APP_ROOT,"src/cli/main.ts")) {
  main().then(result=>{console.log(typeof result==="string"?result:process.argv.includes("--json")?JSON.stringify(result):JSON.stringify(result,null,2));})
    .catch(e=>{console.error(JSON.stringify({error:{category:e instanceof InputError?e.category:/EACCES|EPERM|Permission denied/.test(String(e))?"权限不足":"工具内部错误",raw:e instanceof Error?e.message:String(e)}}));process.exitCode=1;});
}
