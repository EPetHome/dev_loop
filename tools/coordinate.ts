import { realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { acceptances } from "./coordination/acceptance.ts";
import { canonical, day, entry, hash, json, ref, str, time, type Ref } from "./coordination/files.ts";
import { health } from "./coordination/health.ts";
import { Project } from "./coordination/history.ts";
import { archiveText, issues, issueViews } from "./coordination/issues.ts";
import { monthly } from "./coordination/monthly.ts";
import { candidates, collect, confirmationPath, reportSignals, type Decision } from "./coordination/signals.ts";
import { applyPlan, capturedOriginals, locked, pendingPlans, planId, previewAttempt, savedPlan, type Change, type Plan, type WriteResult } from "./coordination/write-plan.ts";

const loop = resolve(import.meta.dirname,"../bin/loop");
const commands = ["开工","查询","体检","月报","候选决定"];
const help = `node tools/coordinate.ts 开工|查询|体检|月报|候选决定 --project <项目目录>
  --tasks-root <执行根目录>   默认 LOOP_TASKS_ROOT 或 ~/.dev-loop/tasks
  --card <开发卡>             开工时指定新卡，也可用于体检；相对路径以项目根为准
  --changed <仓库内改动路径>  可重复；含删除和重命名的旧路径
  --month YYYY-MM            月报的月份；默认本机当前月
  --decision <本人决定.json> 候选决定：从项目内有出处的决定文件登记
  --acceptance-ready         已核对项目的读取器支持未确认状态，或无此读取器
  --apply <planId>           只执行此前预览的计划（体检不可写入）
默认只读 JSON 预览，不投递、不运行项目检查。格式和 PA 接入见 README。`;

function options(argv: string[]) {
  const {positionals, values} = parseArgs({args:argv,allowPositionals:true,options:{
    project:{type:"string"}, "tasks-root":{type:"string"}, card:{type:"string"}, changed:{type:"string",multiple:true}, month:{type:"string"},
    decision:{type:"string"}, "acceptance-ready":{type:"boolean"}, apply:{type:"string"}, help:{type:"boolean"}, json:{type:"boolean"},
  }});
  if (values.help || !argv.length || positionals[0] === "帮助") return;
  const [command] = positionals;
  if (positionals.length !== 1 || !commands.includes(command) || !values.project) throw new Error("须指定命令和 --project；用 --help 查看用法");
  const root = realpathSync(values.project), tasks = canonical(values["tasks-root"] || process.env.LOOP_TASKS_ROOT || join(homedir(),".dev-loop/tasks"));
  if (!statSync(root).isDirectory()) throw new Error("--project 须为项目目录");
  if (values.month && (command !== "月报" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(values.month))) throw new Error("--month 仅用于月报，格式 YYYY-MM");
  if ((command === "候选决定") !== Boolean(values.decision)) throw new Error("候选决定须指定 --decision <本人决定.json>");
  if (values.apply && (!/^[0-9a-f]{64}$/.test(values.apply) || command === "体检")) throw new Error("--apply 需要预览的完整 planId，体检不能写入");
  return {command, root, tasks, card:values.card || "", changed:values.changed || [], month:values.month,
    decision:values.decision || "", readerReady:!!values["acceptance-ready"], apply:values.apply};
}
type Options = NonNullable<ReturnType<typeof options>>;

function preview(o: Options, now: number, recovery?: Plan) {
  const project = new Project(o.root,o.tasks,loop), card = o.card ? project.path(o.card) : "", today = day(now);
  const originals = recovery && capturedOriginals(recovery);
  if (card && !entry(project.root,card)?.isFile()) throw new Error("找不到普通开发卡文件：" + card);
  const inspection = health(project,card,o.changed), changes: Change[] = [], blocked: {source:Ref; reason:string}[] = [];
  const reviewHistory = o.command === "体检" ? [] : project.runs.map(r=>collect(r,project));
  const forOpening = o.command === "开工" ? reviewHistory.filter(h=>h.run.card !== card && h.run.batch && h.run.started !== undefined && h.run.started <= now) : reviewHistory;
  const cs = candidates(project,forOpening), list = o.command === "体检" ? [] : issues(project,originals);
  const month = o.month || today.slice(0,7), monthDir = join(project.state,"monthly");
  let report: ReturnType<typeof monthly> | undefined, monthlyFile: string | undefined;
  if (["开工","月报"].includes(o.command)) {
    monthlyFile = join(monthDir,`${month}.json`);
    if (o.command === "月报" || !entry(project.root,monthlyFile)) {
      report = monthly(project,month,now,reviewHistory,list,cs,inspection);
      const content = json(report);
      if (o.command === "月报") monthlyFile = join(monthDir,`${month}-${today}-${hash(content).slice(0,16)}.json`);
      if (!entry(project.root,monthlyFile)) changes.push({kind:"月报",to:monthlyFile,content,summary:`保存 ${month} 月度汇总及剪枝候选`,sources:report.executions.map(r=>r.source)});
    }
  }
  const collectIssues = o.command === "开工" || o.command === "查询";
  if (collectIssues) for (const c of cs) {
    if (c.status !== "已确认" || c.confirmation || !c.decision || !c.observed.length) continue;
    const to = confirmationPath(project,c.decision), observed = c.observed[0], sources = [c.decision.source,observed.source];
    if (to && !entry(project.root,to)) changes.push({kind:"候选确认",to,content:json({candidate:c.id,decision:c.decision.source,observed}),
      summary:`${c.key}：批准后的 ${observed.batch} 有同类观测且未再出现`,sources});
  }
  const iv = collectIssues ? issueViews(project,list,originals) : [];
  for (const [i,v] of iv.entries()) if (v.ready) {
    const issue = list[i], path = join(project.setting("issues","issues"),"【history】",basename(issue.file));
    const result = project.read.get(path,()=>({existing:entry(project.root,path)}));
    if (!result || result.existing) blocked.push({source:v.source,reason:`历史目标已存在或不可用，不覆盖：${path}`});
    else changes.push({kind:"关单",from:issue.file,to:path,before:hash(issue.text),content:archiveText(issue,path,recovery?.date || today,v),summary:`证据齐全，归档 ${issue.name}`,sources:[v.source,...v.evidence]});
  }
  const av = collectIssues ? acceptances(project,list,now,o.command === "开工",card,o.readerReady || project.config.acceptanceReaderReady === true,originals) : [];
  for (const row of av) {
    const {file,reason,sources,batch} = row.view;
    if (row.updated) changes.push({kind:"结束提醒",from:file,to:file,before:hash(row.text),content:row.updated,summary:`${batch}：${reason} → 未确认（无反馈）`,sources});
    else if (row.view.due) blocked.push({source:ref(file,1),reason:"已到结束提醒时间；尚未确认读取器认识「未确认（无反馈）」"});
  }
  if (o.command === "候选决定") {
    const file = project.path(o.decision), text = project.read.text(file), d = project.read.doc(file);
    const candidate = cs.find(c=>c.id === d?.candidate && (c.occurrences.length >= 2 || c.decision));
    const at = time(d?.at), reason = str(d?.reason).trim(), landing = str(d?.landing).trim();
    const decision = d?.decision;
    if (!d || !text || !candidate || !["接受不处理","已批准"].includes(str(decision)) || at === undefined || at > now || !reason || decision === "已批准" && !landing) {
      throw new Error("本人决定须指向报告里的候选，记录有效 at、决定和原因；批准须有落位。未写入");
    }
    const originalHash = hash(text);
    if (candidate.decision?.originalHash !== originalHash) {
      if (candidate.decision && at <= time(candidate.decision.at)!) throw new Error("决定不晚于已登记的决定；保留原记录");
      const record: Decision = {candidate:candidate.id,key:candidate.key,decision:decision as Decision["decision"], at:new Date(at).toISOString(),reason,
        ...(landing && {landing}),batches:[...new Set(project.runs.filter(r=>r.batch && (r.started ?? -Infinity) <= at).map(r=>r.batch!.key))],original:ref(file),originalHash};
      const to = join(project.state,"decisions",`${candidate.id}-${originalHash}.json`);
      changes.push({kind:"候选决定",to,content:json(record),summary:`登记本人决定：${candidate.key} → ${record.decision}`,sources:[ref(file),...candidate.occurrences.flatMap(x=>x.sources)]});
    }
  }
  const dirs = project.read.list(join(project.state,"plans")).filter(e=>e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name)).map(e=>e.name);
  const incomplete = pendingPlans(project.root,dirs);
  const plan = previewAttempt({project:project.root,command:o.command,changes,date:today});
  return {plan, report:{protocol:"coordinate-report/1",project:project.root,command:o.command,mode:"preview",generatedAt:new Date(now).toISOString(),
    readyToLaunch:"工具不判定开工资格、不代投递",planId:planId(plan),changes:describe(changes),blocked,incomplete,
    previous:reportSignals(forOpening,project.root),candidates:cs,issues:iv,acceptances:av.map(r=>r.view),health:inspection,
    month:monthlyFile ? {file:monthlyFile, snapshot:report ?? null} : null,
    history:{tasksRoot:project.tasks,executions:project.runs.length,catalogComplete:project.catalogOK,query:project.query}, warnings:project.read.warnings}};
}
const describe = (changes:Change[]) => changes.map(({kind,from,to,before,content,summary,sources})=>({kind,from,to,before,after:hash(content),summary,sources}));

export function coordinate(argv: string[], now = Date.now()) {
  const o = options(argv);
  if (!o) return help;
  const id = o.apply;
  if (!id) return preview(o,now).report;
  const previous = savedPlan(o.root,id);
  if (!previous) {
    const initial = preview(o,now);
    if (planId(initial.plan) !== id) throw new Error("预览已变化，请重新预览；未修改项目文件");
    if (!initial.plan.changes.length) return {...initial.report,mode:"applied",applied:{plan:null,complete:true,results:[] as WriteResult[]}};
  }
  return locked(o.root,()=>{
    const saved = savedPlan(o.root,id);
    if (saved && saved.command !== o.command) throw new Error("请用原命令恢复计划");
    const current = preview(o,now,saved);
    if (!saved && planId(current.plan) !== id) throw new Error("预览已变化，请重新预览；未修改项目文件");
    if (current.report.incomplete.some(p=>p!==id)) throw new Error("存在中断的计划，请先用原命令 --apply 恢复：" + current.report.incomplete.join("、"));
    const plan = saved || current.plan, applied = applyPlan(plan,current.plan);
    return {...current.report,mode:"applied",planId:id,changes:describe(plan.changes),applied};
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  try {
    const result = coordinate(process.argv.slice(2));
    process.stdout.write(typeof result === "string" ? result + "\n" : json(result));
  } catch (e) {
    process.stderr.write(JSON.stringify({error:{category:"协调工具未执行完",raw:e instanceof Error ? e.message : String(e)}}) + "\n");
    process.exitCode = 1;
  }
}
