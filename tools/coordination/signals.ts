import { isAbsolute, join, relative } from "node:path";
import { array, entry, hash, object, ref, sha, str, strings, time, type Doc, type Ref } from "./files.ts";
import { delivered, official, roundOf, statusRef, taskFile, type Execution, type Project } from "./history.ts";
import { items, plain, sections } from "./markdown.ts";

const categories = ["必修", "小问题", "需求疑问", "复测失败", "停下原因", "运行差异", "收尾笔记", "窗口原话"] as const;
type Category = typeof categories[number];
const landing: Record<Category, string> = {
  必修: "REVIEW.md（常漏清单 / 不算必修）或定向测试", 小问题: "问题单或写法文档", 需求疑问: "需求或写法文档",
  复测失败: "项目测试", 停下原因: "dev-loop 固定说明或写法文档", 运行差异: "问题单或快照 / 场景脚本", 收尾笔记: "verify skill", 窗口原话: "需求或问题单",
};
export type Signal = { kind: Category; text: string; source: Ref; keys: string[]; evidence?: string[]; round?: number; item?: number; at?: string };
const fileKeys = (text: string) => [...new Set([
  ...[...text.matchAll(/`([^`\n]+\.[\w-]+):\d+[^`]*`/g)].map(m=>m[1]),
  ...[...text.replace(/`[^`\n]+`/g," ").matchAll(/(?:^|[\s（(：:])((?:[\w.\u3400-\u9fff-]+\/)*[\w.\u3400-\u9fff-]+\.[\w-]+):\d+/g)].map(m=>m[1]),
].filter(p=>!isAbsolute(p) && !p.split("/").includes("..")).map(p=>"file:"+p.replace(/^\.\//,"")))];
const sceneKey = (id: string) => "scene:" + id;
const located = (text: string) => [...fileKeys(text), ...[...text.matchAll(/\bS\d+\b/g)].map(m => sceneKey(m[0]))];
export const facts = (run: Execution) => object(run.loop.facts);
export const stops = (run: Execution) => array(facts(run).stops).map(object).filter(s => str(s.reason) && time(s.at) !== undefined);

function snapshotValues(record: Doc, live: boolean) {
  const all = new Map<string, {key: string; value: unknown}>();
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) {
        const row = object(item), name = str(row.id) || str(row.name), mode = str(row.answerMode);
        const key = name || mode || String(i), field = path + "/" + key;
        if (name && typeof row.status === "string") all.set(field, {key: sceneKey(name), value: [row.status, row.reason ?? row.error ?? null]});
        else walk(item, field);
      }
      return;
    }
    const entries = Object.entries(object(v));
    for (const [k,value] of entries) if (!/elapsed|duration|tokens?|estimated|modelRequests|timestamp|^at$|^commit$|^mode$/i.test(k)) walk(value, `${path}/${k}`);
    if (!entries.length && live) all.set(path, {key: "live:" + path, value: v});
  };
  walk(record, "");
  return all;
}

export function collect(run: Execution, project: Project) {
  const signals: Signal[] = [], readable = new Set<Category>(), gaps: {kind: Category; source: Ref; reason: string}[] = [];
  const sceneCoverage = new Set<string>(), coveredReviews = new Set<Category>();
  const add = (kind: Category, text: string, source: Ref, keys = located(text), extra: Partial<Signal> = {}) => {
    readable.add(kind); signals.push({kind, text, source, keys: [...new Set(keys)], ...extra});
  };
  const safe = (path: string) => run.read.get(path, () => taskFile(run,path));
  const originals = run.read.list(run.dir);
  const review = run.checks.filter(official);
  const names = ["必修", "小问题", "需求疑问"] as const;
  for (const [i, c] of review.entries()) {
    const round = roundOf(c) || i + 1;
    const output = c.evidence.filter(e => /(?:^|\/)review-(?!input|error).*\.md$/.test(e)).at(-1);
    const path = output ? safe(output) : undefined;
    const text = path ? run.read.text(path) : undefined, blocks = sections(text || "");
    for (const kind of names) {
      const block = blocks.find(b => b.level === 2 && b.title === kind);
      if (block && path && plain(block.body)) {
        readable.add(kind);
        for (const [n, item] of items(block.body,path,block.bodyLine).entries()) add(kind, item.text, item.source, located(item.text), {round, item: n + 1, evidence: [c.source.file]});
      } else if (kind === "必修" && (c.detail || c.result === "通过")) {
        readable.add(kind);
        if (c.result === "必修") for (const [n, detail] of c.detail.split(/\r?\n/).filter(Boolean).entries()) {
          add(kind, detail, c.source, located(detail), {round, item: n + 1, evidence: c.evidence});
        }
      } else gaps.push({kind, source: path ? ref(path) : c.source, reason: `第 ${round} 轮缺可读的「${kind}」原文`});
    }
  }
  if (review.length && run.ledgerOK) for (const kind of names) if (readable.has(kind) && !gaps.some(g => g.kind === kind)) coveredReviews.add(kind);
  if (run.ledgerOK && run.checks.some(c => c.step === "复测")) readable.add("复测失败");
  for (const c of run.checks.filter(c => c.step === "复测" && ["失败", "环境未验证"].includes(c.result))) {
    const logs = c.evidence.map(safe).filter((p): p is string => !!p);
    const original = !c.detail && logs[0] ? run.read.text(logs[0]) : undefined;
    const text = c.detail || original?.split(/\r?\n/).slice(-60).join("\n") || c.result;
    add("复测失败", text, c.detail || !original ? c.source : ref(logs[0]), [...located(text), ...array(c.value.missingScenarios).filter(v => typeof v === "string").map(sceneKey)], {evidence: logs});
  }
  if (Array.isArray(facts(run).stops)) readable.add("停下原因");
  for (const [i, stop] of array(facts(run).stops).map(object).entries()) {
    const reason = str(stop.reason);
    if (reason) add("停下原因", [reason, str(stop.message)].filter(Boolean).join("："), statusRef(run, `loop.facts.stops[${i}]`), ["stop:" + reason], {at: str(stop.at)});
  }
  const legacyReason = str(run.loop.wait) || str(object(run.status.error).category);
  if (!Array.isArray(facts(run).stops) && legacyReason && ["input_required","failed"].includes(str(run.status.state))) {
    add("停下原因", legacyReason + "：" + str(run.status.message), statusRef(run, run.loop.wait ? "loop.wait" : "error"), ["stop:" + legacyReason]);
    gaps.push({kind:"停下原因", source: statusRef(run,"loop.facts.stops"), reason:"旧状态只知道当前停下，不补造历史"});
  }
  const diff = (before: string, after: string, live = false) => {
    const a = run.read.doc(before), b = run.read.doc(after);
    if (!a || !b) { gaps.push({kind: "运行差异", source: ref(!a ? before : after), reason: "缺失或不可读，无法比较"}); return false; }
    readable.add("运行差异");
    const left = snapshotValues(a,live), right = snapshotValues(b,live);
    for (const path of new Set([...left.keys(), ...right.keys()])) {
      const l = left.get(path), r = right.get(path), key = (r || l)!.key;
      if (l && r && (!key.startsWith("scene:") || Array.isArray(r.value) && ["完成","通过"].includes(r.value[0]))) sceneCoverage.add(key);
      if (JSON.stringify(l?.value) !== JSON.stringify(r?.value)) add("运行差异", `${path}：${JSON.stringify(l?.value) ?? "未记录"} → ${JSON.stringify(r?.value) ?? "未记录"}`,
        ref(after, undefined, path), [key], {evidence: [before, after]});
    }
    return true;
  };
  const recorded = new Set(run.checks.filter(c => c.step === "留痕" && c.result === "已存").flatMap(c => c.evidence.map(safe)));
  const deliveredSnapshots = [...new Set([...review.map(c => c.commit), delivered(run)])].filter(sha).map(commit => join(run.dir, `snapshot-${commit}.json`));
  const missingSnapshots = new Set<string>();
  for (const after of deliveredSnapshots) {
    if (recorded.has(after) || originals.some(e => join(run.dir,e.name) === after)) {
      if (!diff(join(run.dir,"snapshot-base.json"), after)) missingSnapshots.add(after);
    } else {
      missingSnapshots.add(after);
      gaps.push({kind:"运行差异", source:ref(after), reason:"未记录交付快照"});
    }
  }
  for (const c of review) {
    const round = roundOf(c);
    if (!round || !missingSnapshots.has(join(run.dir,`snapshot-${c.commit}.json`))) continue;
    const file = join(run.dir,`review-input-r${round}.md`), raw = run.read.text(file) || "";
    const start = /^## 运行差异[^\S\r\n]*\r?$/m.exec(raw);
    if (!start) continue;
    const body = raw.slice(start.index + start[0].length).split(/^##\s/m,1)[0];
    const line = raw.slice(0,start.index).split("\n").length;
    for (const [i,text] of body.split(/\r?\n/).entries()) {
      // 只有归档的状态差异可读；没有场景身份时不把相同数组下标算同一场景。
      if (/^(新增|减少|变化) \/.*\/status：/.test(text)) add("运行差异",text,ref(file,line+i),[]);
    }
  }
  for (const c of run.checks.filter(c => c.step === "部署" && /^已部署/.test(c.result))) {
    const dir = c.evidence[1] && safe(c.evidence[1]);
    if (dir) diff(join(dir,"snapshot-before.json"), join(dir,"snapshot-after.json"), true);
  }
  for (const c of run.checks.filter(c => c.step === "留痕" && c.result === "失败")) gaps.push({kind:"运行差异", source:c.source, reason:c.detail || "留痕失败"});
  for (const c of run.checks.filter(c => c.step === "开发" && c.result === "已交付")) {
    const note = /收尾笔记\s*[:：]?\s*([\s\S]+)/.exec(c.detail)?.[1];
    if (note) add("收尾笔记",note,c.source);
  }
  const note = str(object(run.loop.delivery).note);
  if (note) add("收尾笔记", note, statusRef(run,"loop.delivery.note"));
  const noteFile = join(run.dir,"收尾笔记.md"), fromFile = run.read.text(noteFile);
  if (fromFile?.trim()) add("收尾笔记", fromFile, ref(noteFile));
  if (run.batch?.runs.length === 1) {
    const result = run.batch.results;
    for (const b of sections(project.read.text(result) || "").filter(b=>b.title === "收尾笔记" && b.body.trim())) add("收尾笔记",b.body,ref(result,b.bodyLine));
  }
  const attempts = join(run.dir, "e2e");
  for (const dir of run.read.list(attempts).filter(e=>e.isDirectory())) {
    const path = join(attempts,dir.name,"result.json"), report = run.read.doc(path);
    const plan = run.read.doc(join(attempts,dir.name,"plan.json"));
    if (!report || report.executionId !== run.id || !sha(report.commit) || !run.checks.some(c=>c.step === "复测" && c.commit === report.commit && c.evidence.some(e=>safe(e) === path))) continue;
    if (plan && (plan.executionId !== run.id || plan.commit !== report.commit || plan.attempt !== report.attempt)) continue;
    for (const [i, row] of array(report.scenarios).map(object).entries()) {
      const id = str(row.id), status = str(row.status), text = str(row.notes) || str(row["收尾笔记"]);
      if (text) add("收尾笔记", text, ref(path,undefined,`scenarios[${i}]`), id ? [sceneKey(id)] : located(text));
      if (id && status === "通过") sceneCoverage.add(sceneKey(id));
      if (id && ["失败", "未验证"].includes(status)) add("复测失败", `${id} ${status}：${JSON.stringify(row.steps ?? [])}`, ref(path,undefined,`scenarios[${i}]`), [sceneKey(id)]);
    }
  }
  const window = join(run.dir,"窗口原话.jsonl");
  for (const {value,source} of run.read.lines(window)) {
    if (typeof value.text === "string") add("窗口原话", value.text, source, located(value.text), {at:str(value.at)});
    else gaps.push({kind:"窗口原话", source, reason:"未找到已登记的 text 原文"});
  }
  const hints: Partial<Record<Category,Ref>> = {窗口原话:ref(window), 收尾笔记:statusRef(run,"loop.delivery.note"), 停下原因:statusRef(run,"loop.facts.stops"), 运行差异:ref(join(run.dir,"snapshot-base.json"))};
  for (const kind of categories) if (!readable.has(kind) && !gaps.some(g => g.kind === kind)) {
    gaps.push({kind, source:hints[kind] || ref(join(run.dir,"checks.jsonl")), reason:"没有可读记录"});
  }
  return {run, signals, gaps, coveredReviews, sceneCoverage};
}
export type Collected = ReturnType<typeof collect>;
export type Decision = { candidate: string; key: string; decision: "接受不处理" | "已批准"; at: string; reason: string; landing?: string; batches: string[]; original: Ref; originalHash: string };
export const confirmationPath = (project: Project, d: Decision) => /^[a-f0-9]{64}$/.test(d.originalHash) ? join(project.state,"confirmations",`${d.candidate}-${d.originalHash}.json`) : undefined;
export function candidates(project: Project, history: Collected[]) {
  const dir = join(project.state,"decisions"), decisions = new Map<string, Decision & {source: Ref}>();
  for (const e of project.read.list(dir).filter(e => e.isFile() && e.name.endsWith(".json"))) {
    const file = join(dir,e.name), value = project.read.doc(file);
    const key = str(value?.key), id = str(value?.candidate), at = time(value?.at), decision = value?.decision;
    const original = str(object(value?.original).file), originalHash = str(value?.originalHash);
    if (!value || !original || !key || hash(key) !== id || at === undefined || decision !== "接受不处理" && decision !== "已批准") continue;
    const old = decisions.get(id), oldAt = time(old?.at) ?? -Infinity;
    if (at > oldAt) decisions.set(id,{key, candidate:id, decision, at:new Date(at).toISOString(), reason:str(value.reason),
      landing:str(value.landing) || undefined, batches:strings(value.batches), original:ref(original), originalHash, source:ref(file)});
  }
  type Group = {kinds: Set<Category>; batches: Map<string,{run: Execution; source: Ref}[]>};
  const groups = new Map<string, Group>();
  for (const h of history) if (h.run.batch) for (const s of h.signals) for (const key of s.keys) {
    const group: Group = groups.get(key) || {kinds:new Set(), batches:new Map()}; groups.set(key,group);
    group.kinds.add(s.kind);
    const batch = h.run.batch.key, entries = group.batches.get(batch) || [];
    if (!entries.some(e => e.run.id === h.run.id)) entries.push({run:h.run, source:s.source});
    group.batches.set(batch,entries);
  }
  for (const d of decisions.values()) if (!groups.has(d.key)) groups.set(d.key,{kinds:new Set(),batches:new Map()});
  return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,{kinds,batches}]) => {
    const id = hash(key), decision = decisions.get(id), newBatch = (run: Execution) => run.batch && decision && Array.isArray(decision.batches) &&
      !decision.batches.includes(run.batch.key) && (run.started ?? -Infinity) > time(decision.at)!;
    const appeared = [...batches.entries()].map(([batch, entries])=>({batch, executions:entries.map(e=>e.run.id), sources:entries.map(e=>e.source)}));
    const recurrence = [...batches.values()].flat().filter(e => newBatch(e.run));
    const observed = new Map<string,Execution>();
    if (decision?.decision === "已批准" && project.catalogOK && kinds.size) for (const h of history) {
      if (!newBatch(h.run) || h.run.status.state !== "completed" || batches.has(h.run.batch!.key)) continue;
      const historyOfStops = facts(h.run).stops;
      const covered = [...kinds].every(kind => kind === "停下原因" ? Array.isArray(historyOfStops) && historyOfStops.length < 50 :
        kind === "运行差异" || key.startsWith("scene:") && kind === "复测失败" ? h.sceneCoverage.has(key) : h.coveredReviews.has(kind));
      if (covered) observed.set(h.run.batch!.key,h.run);
    }
    const status = decision?.decision === "接受不处理" ? "接受不处理" : decision ? recurrence.length ? "批准后再现" : observed.size ? "已确认" : "已批准" : batches.size >= 2 ? "候选" : "信号";
    const path = decision && confirmationPath(project,decision);
    const existing = path && project.read.get(path,()=>entry(project.root,path)?.isFile());
    return {id, key, status, needsDecision:status === "候选" || status === "批准后再现", occurrences:appeared,
      suggestedLanding:[...new Set([...kinds].map(k=>landing[k]))], decision, confirmation:existing && path ? ref(path) : null,
      recurrences:recurrence.map(e=>({execution:e.run.id, source:e.source})), observed:[...observed.entries()].map(([batch,run])=>({batch, execution:run.id, startedAt:new Date(run.started!).toISOString(), source:statusRef(run)}))};
  });
}
export const reportSignals = (history: Collected[], root: string) => {
  const last = history.at(-1)?.run.batch;
  return last ? {batch:last.key, card:relative(root,last.card), executions:history.filter(h=>h.run.batch === last).map(h=>({
    execution:h.run.id, state:h.run.status.state ?? null, signals:h.signals, gaps:h.gaps}))} : null;
};
