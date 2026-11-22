import { join, resolve } from "node:path";
import { array, day, days, object, ref, str, time } from "./files.ts";
import { official, roundOf, statusRef, taskRef, type Execution, type Project } from "./history.ts";
import { introducedRun, readDevTip, type Issue } from "./issues.ts";
import { links } from "./markdown.ts";
import { facts, stops, type candidates, type Collected } from "./signals.ts";
import type { health } from "./health.ts";

function ratio(numerator:number, denominator:number, unknown:number, basis:string) {
  return {numerator,denominator,unknown,value:denominator ? numerator / denominator : null,basis};
}
function median(values: number[], denominator: number) {
  values.sort((a,b)=>a-b);
  const mid = Math.floor(values.length/2);
  return {value:!values.length ? null : values.length%2 ? values[mid] : (values[mid-1]+values[mid])/2,denominator:values.length,unknown:denominator-values.length};
}
const duration = (x:unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const stages = ["developmentMs","testMs","reviewMs","inputMs","selfMs"];
const finishTimes = (r:Execution) => object(r.loop.durations);
function flowType(reason:string, step:string, message:string) {
  if (/停下没交付|已提交没交付/.test(reason)) return "停下没交付";
  if (reason === "模型出错") return reason;
  if (/环境未就绪|环境故障|环境未验证/.test(reason)) return "外部环境故障";
  if (/评审上下文超限|评审调用|评审临时故障/.test(reason) || reason === "临时故障" && (step === "评审中" || /评审/.test(message))) return "评审调用故障";
}
function audits(project: Project, history: Collected[]) {
  const path = project.setting("reviewAudit","docs/分析-评审误报回查.md");
  const given = new Map<string,{verdict:string; source:ReturnType<typeof ref>}>();
  const reports = new Map(history.map(h=>[join(h.run.dir,"checks.jsonl"),h]));
  for (const [i,line] of (project.read.text(path)||"").split(/\r?\n/).entries()) {
    if (!line.startsWith("|")) continue;
    const values = line.trimEnd().replace(/^\||\|$/g, "").split("|").map(s=>s.trim());
    const verdict = values.at(-1) || "";
    if (!["成立","报过头","判断不了"].includes(verdict)) continue;
    const checkLink = links(values[0] || "").map(x=>/^(.*\/checks\.jsonl):(\d+)$/.exec(x)).find(Boolean), item = /\bR(\d+)\s*[/／]\s*(\d+)\b/.exec(values[1] || "");
    if (!checkLink || !item) continue;
    const h = reports.get(resolve(project.root,checkLink[1]));
    if (!h?.run.checks.some(c=>c.source.line === Number(checkLink[2]) && c.step === "评审" && c.result === "必修" && (roundOf(c) ?? Number(item[1])) === Number(item[1]))) continue;
    const key = `${h.run.id}/${Number(item[1])}/${Number(item[2])}`, source = ref(path,i+1);
    const previous = given.get(key);
    given.set(key,{verdict:previous && previous.verdict !== verdict ? "判断不了" : verdict, source});
  }
  return given;
}

export function monthly(project: Project, month: string, today: number, history: Collected[], list: Issue[], cs: ReturnType<typeof candidates>, inspection: ReturnType<typeof health>) {
  const entries = history.filter(h => h.run.started !== undefined && day(h.run.started).startsWith(month));
  const runs = entries.map(h=>h.run), ids = new Set(runs.map(r=>r.id));
  const stopped = runs.filter(r=>stops(r).length), knownStops = runs.filter(r=>Array.isArray(facts(r).stops)), resumed = stopped.filter(r=>stops(r).some(s=>s.resolvedBy === "续跑"));
  const flow = runs.flatMap(r=>array(facts(r).stops).map(object).flatMap((s,i)=>{
    const kind = time(s.at) === undefined ? undefined : flowType(str(s.reason),str(s.step),str(s.message));
    return kind ? [{kind,execution:r.id,reason:s.reason,source:statusRef(r,`loop.facts.stops[${i}]`)}] : [];
  }));
  const reviewed = runs.filter(r=>r.checks.some(official));
  const first = reviewed.flatMap(r=>{
    const c = r.checks.find(c=>c.step === "评审");
    return r.ledgerOK && c && official(c) && (roundOf(c) ?? 1) === 1 ? [{execution:r.id, result:c.result, source:c.source}] : [];
  });
  const rounds = reviewed.filter(r=>r.ledgerOK).map(r=>({execution:r.id, count:r.checks.filter(official).length, source:ref(join(r.dir,"checks.jsonl"))}));
  const bugs = list.filter(issue=>issue.bug), devTip = bugs.length ? readDevTip(project) : undefined;
  const attribution = bugs.map(issue=>({issue,binding:introducedRun(project,issue,devTip)}));
  const escaped = attribution.flatMap(({issue,binding})=>binding && ids.has(binding.run.id) ? [{source:ref(issue.file), execution:binding.run.id,
    introduced:issue.introduced, introducedCommit:binding.introducedCommit, deliveryCommit:binding.deliveryCommit, enteredDev:binding.entry, sources:binding.sources}] : []);
  const completed = runs.filter(r=>r.status.state === "completed");
  const development = completed.map(r=>finishTimes(r).developmentMs).filter(duration);
  const total = completed.map(r=>stages.map(key=>finishTimes(r)[key])).filter(xs=>xs.every(duration)).map(xs=>xs.reduce<number>((a,b)=>a+(b as number),0));
  const must = new Map(entries.flatMap(h=>h.signals.filter(s=>s.kind === "必修" && s.round && s.item).map(s=>[`${h.run.id}/${s.round}/${s.item}`,{h,s}])));
  const audit = audits(project,entries), scored = [...must].flatMap(([key,value])=>audit.has(key) ? [{...value,...audit.get(key)!}] : []);
  const falsePositives = scored.filter(s=>s.verdict === "报过头"), classified = scored.filter(s=>s.verdict !== "判断不了");
  const pruning: {kind:string; key:string; message:string; sources:ReturnType<typeof ref>[]}[] = inspection.advice.filter(a=>a.prune).map(a=>({kind:"地图剪枝",key:a.scenario || a.code,message:a.message,sources:[a.source]}));
  for (const c of cs) {
    if (c.status === "已确认" && c.decision?.landing && today - time(c.decision.at)! >= days(30) && c.observed.length >= 3) {
      pruning.push({kind:"长期未触发",key:c.key,message:`${c.decision.landing}：批准满 30 天、至少三批有同类观测且未再出现。请本人决定是否删减。`,sources:[c.decision.source,...c.observed.map(x=>x.source)]});
    }
    const falseMatches = falsePositives.filter(x=>x.s.keys.includes(c.key) && x.h.run.batch);
    if (new Set(falseMatches.map(x=>x.h.run.batch!.key)).size >= 2) pruning.push({kind:"反复误报",key:c.key,
      message:`独立回查在不同批次认定报过头；${c.decision?.landing || "尚未绑定规则"}，请本人核对去留。`,sources:falseMatches.map(x=>x.source)});
  }
  return {protocol:"coordinate-month/1",project:project.root,month,generatedOn:day(today), scope:"本机日历月内启动的登记执行；以生成时能读到的事实为准",
    executions:runs.map(r=>({id:r.id,source:taskRef(r)})), unknownStart:history.length - history.filter(h=>h.run.started !== undefined).length,
    intervention:{...ratio(resumed.length,stopped.length,runs.length-knownStops.length,"分母：有 facts.stops 的执行；分子：至少一条 resolvedBy=续跑，包含本人确认交付"), evidence:stopped.map(r=>statusRef(r,"loop.facts.stops"))},
    flowFailures:{events:flow, byReason:Object.fromEntries(["停下没交付","模型出错","评审调用故障","外部环境故障"].map(k=>[k,flow.filter(f=>f.kind===k).length])),
      denominator:knownStops.length,unknown:runs.length-knownStops.length,basis:"按停下事件计，分母是有停下历史字段的执行；不计产品失败、仅重试未停下或主动停止"},
    firstMustFix:{...ratio(first.filter(f=>f.result === "必修").length,first.length,runs.length-first.length,"分母：首轮明确通过或有必修；首轮未结束不补造结论"),evidence:first},
    repairRounds:{...ratio(rounds.reduce((a,r)=>a+r.count,0),rounds.length,runs.length-rounds.length,"累计有正式结论的评审轮次 / 有完整流水且产出评审结论的执行，不计一次调用内重试"),evidence:rounds},
    escapes:{count:escaped.length,denominator:reviewed.length,unknownAttribution:attribution.filter(({issue,binding})=>!binding && !/^非\s*dev-loop/.test(issue.introduced)).length,
      basis:"按有引入记录且随本月执行最终通过版本进入 dev 的 bug 单计；分母只说明有评审的执行样本，不是漏网率，未建单不可见",evidence:escaped},
    durationMs:{development:median(development,completed.length),total:median(total,completed.length),denominator:completed.length,
      basis:"已完成执行；各段合计含等待与 dev-loop 自身，不拿不完整记录补零。",evidence:completed.map(r=>statusRef(r,"loop.durations"))},
    falsePositives:{...ratio(falsePositives.length,classified.length,Math.max(0,must.size-classified.length),"分母：已独立回查且能判定的必修条目；未回查和判断不了均为未知，不算没有误报"),
      observedMustFix:must.size,evidence:scored.map(({verdict,source})=>({verdict,source})),partialReviewSource:entries.some(h=>h.gaps.some(g=>g.kind === "必修"))},
    acceptanceBacklog:project.batches.filter(b=>/^\uFEFF?状态\s*[:：]\s*待验(?:收)?[\r\n]|^\uFEFF?状态\s*[:：]\s*待验(?:收)?$/.test(project.read.text(b.acceptance)||"")).length,
    pruning, pruningNote:"仅提候选；没有明确观测、规则关联或回查的部分未知，不推断规则无效。未安排独立定时服务或月度压测。"};
}
