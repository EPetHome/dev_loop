import { basename, dirname, join, relative, resolve } from "node:path";
import { array, inside, object, ref, sha, str, time, type Doc, type Ref } from "./files.ts";
import { checked, deployments, mergeFacts, statusRef, taskRef, type Batch, type Execution, type Project } from "./history.ts";
import { field, links, plain, sections } from "./markdown.ts";

const issueStatus = /^([^\S\r\n]*(?:[-*]\s+)?(?:\*\*)?状态(?:\*\*)?[^\S\r\n]*[:：](?:\*\*)?[^\S\r\n]*)([^\r\n]+)/m;
const closed = /^(?:已解决|不做|重复)(?:$|[（(·：:\s])/;
const unspecified = /^(?:待|未知|未填|暂无|无$|[-—]+$|<)/;
const meaningful = (s: string) => !!s && !unspecified.test(plain(s));
export type Issue = { file: string; text: string; name: string; ids: string[]; bug: boolean; history: boolean; header: string; status: string; related: string; introduced: string; attribution: string };
export function issues(project: Project) {
  const dir = project.setting("issues", "issues"), history = join(dir,"【history】");
  return [dir, history].flatMap(folder => project.read.list(folder).flatMap((e): Issue[] => {
    if (!e.isFile() || !/^【(?:bug|req)】.+\.md$/.test(e.name)) return [];
    const file = join(folder,e.name), text = project.read.text(file);
    if (text === undefined) return [];
    const header = text.split(/^##\s/m,1)[0], name = basename(file,".md");
    const ids = [...new Set([name, e.name, ...[field(header,"编号"),field(header,"问题单"),header.split(/\r?\n/,1)[0].match(/\b[A-Z]{2,}[0-9]{2,}\b/)?.[0] || ""].map(plain).filter(Boolean)])];
    return [{file, text, name, ids, bug:e.name.startsWith("【bug】"), history:folder === history, header, status:plain(field(header,"状态")),
      related:field(header,"关联批次"), introduced:field(header,"引入批次"), attribution:plain(field(header,"本该拦住"))}];
  }));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const unquote = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
export const mentions = (text: string, value: string) => !!value && new RegExp(`(?:^|[\\s\\x60<(/（〔【、，；,：:])${escape(value)}(?=$|[\\s\\x60>./)）〕】、，；,。·：:])`).test(text);
const batchMatches = (issue: Issue, batch: Batch, text: string) => mentions(text,batch.name) || links(text).some(name => {
  const target = resolve(dirname(issue.file), unquote(name.split("#")[0]));
  return [batch.card, batch.dir, batch.results, batch.acceptance].includes(target) && (target !== batch.dir || basename(batch.card) === "开发卡.json");
});
function fixRun(project: Project, issue: Issue) {
  // 旧格式可同时提到原修复批、后续补回归批；以明确的「修复」项为准，否则不猜。
  const described = issue.related.split(/[；;，,]/), fixing = described.filter(part => /(?:修复|修这张)(?:[。.]|\s)*$/.test(part));
  const link = fixing.length ? fixing.join("；") : issue.related;
  const byId = project.runs.filter(r=>r.batch && mentions(link,r.id));
  if (byId.length) return byId.length === 1 ? byId[0] : undefined;
  const batches = project.batches.filter(b => batchMatches(issue,b,link));
  return batches.length === 1 ? batches[0].runs.at(-1) : undefined;
}
export function introducedRun(project: Project, issue: Issue) {
  const commit = /\b[0-9a-f]{7,64}\b/.exec(issue.introduced)?.[0];
  if (!commit) return;
  const matching = project.runs.filter(r => (mentions(issue.introduced,r.id) || r.batch && batchMatches(issue,r.batch,issue.introduced)) &&
    r.checks.some(c => c.step === "评审" && c.result === "通过" && sha(c.commit) && c.commit.startsWith(commit)));
  return matching.length === 1 ? matching[0] : undefined;
}

export type Authorization = { id: string; decision: string; source: Ref };
const authLine = /^(同意授权|不授权|本人已做)[^\S\r\n]*[:：][^\S\r\n]*(A\d+)$/;
export function decisionsIn(text: string, path: string): Authorization[] {
  let fence = "";
  return text.split(/\r?\n/).flatMap((line,i) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker.startsWith(fence)) fence = ""; return []; }
    const m = !fence && authLine.exec(plain(line).replace(/^[-*]\s+/,""));
    return m ? [{id:m[2], decision:m[1],source:ref(path,i+1)}] : [];
  });
}
export function authorizationFor(run: Execution) {
  const recorded = run.read.lines(join(run.dir,"answers.jsonl")).flatMap(({value,source}) => {
    // 正式答复须是本人明确操作，不从讨论、引用、窗口补充或举例中抽一行当成授权。
    const at = time(value.at), m = authLine.exec(str(value.text).trim());
    return at !== undefined && m ? [{at,id:m[2],decision:m[1],source}] : [];
  });
  return recorded.sort((a,b)=>a.at-b.at);
}
const authorizationIds = (text: string) => {
  const rows = text.split(/\r?\n/).filter(l => !l.startsWith(">") && /\[授权\]|^授权项[：:]/.test(l));
  const ids = [...new Set(rows.flatMap(l => [...l.matchAll(/\bA\d+\b/g)].map(m=>m[0])))];
  return {ids, unknown: rows.some(r => !/\bA\d+\b/.test(r))};
};

function localLink(root: string, file: string, link: string) {
  if (/^[a-z]+:/i.test(link)) return;
  const path = resolve(dirname(file),unquote(link.split("#")[0]));
  if (inside(root,path)) return path;
}
const targetName = (d: Doc) => str(d.target) || str(d.testName) || (d.scenario && d.checkpoint ? `${d.scenario} / ${d.checkpoint}` : "");
const observation = (d: Doc) => Object.hasOwn(d,"expected") && Object.hasOwn(d,"actual") && d.actual !== undefined && d.expected !== undefined;
const sameObservation = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a), x = a as Doc, y = b as Doc;
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(y,k) && sameObservation(x[k],y[k]));
};
/** 跨批历史手工对照由单上指向对照文件，并注明唯一目标；不从文字「已证明」推导。 */
function legacyProof(report: Doc, target: string, versions: Set<string>, logOK: (p: string) => boolean) {
  const separator = target.indexOf(" / ");
  if (separator < 0 || !sha(report["测试来源"]) || !Object.keys(object(report["测试文件SHA256"])).length || !Object.values(object(report["测试文件SHA256"])).every(v => /^[a-f0-9]{64}$/.test(str(v)))) return;
  const scenario = target.slice(0, separator), checkpoint = target.slice(separator+3);
  const rows = array(report["运行"]).map(object).filter(r => r["场景"] === scenario && sha(r["版本"]) && logOK(str(r["日志"])));
  const observed = (r: Doc) => array(r["检查点"]).map(object).find(d => d.scenario === scenario && d.checkpoint === checkpoint && observation(d));
  for (const after of rows.filter(r => r["退出"] === 0 && versions.has(str(r["版本"])))) {
    const yes = observed(after);
    if (yes?.status !== "通过" || !sameObservation(yes.actual,yes.expected)) continue;
    const before = rows.find(r => {
      const no = observed(r);
      return r["版本"] !== after["版本"] && r["退出"] === 1 && Array.isArray(r["命令"]) && sameObservation(r["命令"],after["命令"]) &&
        no?.status === "失败" && sameObservation(no.expected,yes.expected) && !sameObservation(no.actual,no.expected);
    });
    if (before) return {before: str(before["版本"]), after: str(after["版本"]), logs:[str(before["日志"]),str(after["日志"])]};
  }
}
function proofFor(project: Project, issue: Issue, run: Execution, current: ReturnType<typeof checked>) {
  const declared = array(run.task.proofs).map(object).filter(row => issue.ids.includes(str(row.issue)));
  const targets = new Set([plain(field(issue.header,"防复发检查")), ...declared.map(targetName)].filter(Boolean));
  if (targets.size !== 1) return;
  const target = [...targets][0];
  const files = new Map<string,{root:string; source?:Ref}>();
  const matched = run.checks.filter(c => c.step === "防复发证明" && c.commit === current.commit &&
    c.value.promptHash === current.hashes?.promptHash && c.value.acceptanceHash === current.hashes?.acceptanceHash);
  for (const c of matched.filter(c=>c.result === "已证明")) for (const e of c.evidence.filter(p=>p.endsWith(".json"))) {
    const path = resolve(run.dir,e);
    if (inside(run.dir,path)) files.set(path,{root:run.dir,source:c.source});
  }
  const legacyLinks = links(field(issue.header,"防复发证明") + "\n" + sections(issue.text).filter(b=>b.title.startsWith("关单依据")).map(b=>b.body).join("\n"));
  for (const url of legacyLinks) {
    const link = localLink(project.root,issue.file,url);
    if (link?.endsWith(".json") && !files.has(link)) files.set(link,{root:project.root});
  }
  for (const [file,{root,source}] of files) {
    const read = root === run.dir ? run.read : project.read, report = read.doc(file);
    if (!report) continue;
    const logOK = (path:string) => {
      const log = path && resolve(dirname(file),path);
      return !!log && inside(root,log) && !!read.text(log)?.trim();
    };
    const before = object(report.before), after = object(report.after);
    const isReview = /^REVIEW\.md\b/.test(issue.attribution);
    if (issue.ids.includes(str(report.issue)) && targetName(report) === target && report.result === "已证明" &&
        report.executionId === run.id && sha(before.commit) && sha(after.commit) && after.commit === current.commit && before.commit !== after.commit &&
        /^[0-9a-f]{64}$/.test(str(report.materialsHash)) && observation(before) && observation(after) &&
        (isReview || sameObservation(before.expected,after.expected) && !sameObservation(before.expected,before.actual) && sameObservation(after.expected,after.actual)) &&
        before.result === (isReview ? "命中目标" : "目标断言失败") && after.result === (isReview ? "正常对照未误报" : "通过") && logOK(str(before.log)) && logOK(str(after.log)) &&
        (!source || !matched.some(c => c.result === "未证明" && c.value.issue === report.issue && c.source.line! > source.line!))) {
      return {target, before:before.commit, after:after.commit, source:ref(file), check:source, logs:[str(before.log),str(after.log)].map(p=>resolve(dirname(file),p)), auth:str(report.authorization)};
    }
    const legacy = !source && !isReview && legacyProof(report,target,mergeFacts(run,current.commit).versions,logOK);
    if (legacy) return {...legacy, target, source:ref(file), logs:legacy.logs.map(p=>resolve(dirname(file),p)), auth:str(report.authorization)};
  }
}
const qualifiedAttribution = /^(测试用例|功能地图(?:（E2E）)?|REVIEW\.md|拦不住)\s*([，、：:；;—·(（\s]+)(.+)$/;
export function issueViews(project: Project, list: Issue[]) {
  return list.map(issue => {
    const source = ref(issue.file), reasons: string[] = [], evidence: Ref[] = [], run = fixRun(project,issue);
    const view = {file:issue.file, name:issue.name, storedStatus:issue.status || null, state:issue.status || "待修复", history:issue.history,
      execution:run?.id ?? null, batch:run?.batch?.key ?? null, reasons, evidence, source, ready:false};
    if (issue.history || closed.test(issue.status) || !issue.bug) {
      if (issue.history && !closed.test(issue.status)) reasons.push("历史未关单；存量分拣交协调方，不搬动");
      return view;
    }
    if (!issueStatus.test(issue.header) || !/^(待修复|修复中|已合入待验|已部署|待验)(?:$|[（(·：:\s])/.test(issue.status)) reasons.push("未识别或缺少问题单状态");
    if (!meaningful(issue.related) || !run) reasons.push("关联批次没有唯一可读的修复执行");
    const intro = plain(issue.introduced);
    if (!/^(定位不到|非\s*dev-loop)(?:$|[（(，、：:\s])/.test(intro) && (!meaningful(intro) || !/\b[0-9a-f]{7,64}\b/.test(intro) || !intro.replace(/\b[0-9a-f]{7,64}\b/g,"").replace(/[\p{P}\s]/gu,""))) reasons.push("引入批次缺执行/批次及提交，或未明确定位不到 / 非 dev-loop");
    const attribution = qualifiedAttribution.exec(issue.attribution);
    if (!attribution || !meaningful(attribution[3].replace(/[）)]$/,""))) reasons.push("本该拦住缺层级或原因");
    if (!run?.batch) return {...view, state:"待修复"};
    const current = checked(project,run), merge = mergeFacts(run,current.commit).merges.at(-1), deployed = deployments(project,run.batch,run).at(-1);
    view.state = deployed?.result || (merge ? "已合入待验" : current.passed ? "复测评审已通过" : "修复中");
    evidence.push(taskRef(run),statusRef(run));
    for (const fact of [current.test,current.review,merge,deployed]) if (fact) evidence.push(fact.source);
    if (!current.passed) reasons.push("缺当前交付（同提示词和验收哈希）的复测、评审均通过事实");
    const proof = attribution?.[1] !== "拦不住" && current.passed ? proofFor(project,issue,run,current) : undefined;
    if (attribution?.[1] !== "拦不住" && !proof) reasons.push("缺此单目标检查的两版防复发证明");
    if (proof) evidence.push(proof.source,...(proof.check ? [proof.check] : []),...proof.logs.map(p=>ref(p)));
    const auths = authorizationFor(run), acceptance = project.read.text(run.batch.acceptance) || "";
    // 批次整体「通过」不等于本人做过这一项。精确到本执行、条目编号及正式答复/本人实做。
    const actual = decisionsIn(acceptance,run.batch.acceptance).filter(d=>d.decision.endsWith("已做"));
    const required = authorizationIds(issue.text + (proof?.auth ? "\n授权项：" + proof.auth : ""));
    if (required.unknown) reasons.push("授权要求没有可核对的验收条目编号");
    for (const id of required.ids) {
      const positive = actual.find(d=>d.id === id) || auths.findLast(d=>d.id === id);
      if (!positive || positive.decision === "不授权") reasons.push(`${id} 缺本人授权或实做事实`);
      else evidence.push(positive.source);
    }
    view.ready = !reasons.length;
    return {...view, commit:current.commit, proof};
  });
}

export function issueFeedback(issues: Issue[], batch: Batch) {
  return issues.flatMap(issue => {
    const environment = sections(issue.text).find(b=>b.title === "环境与证据");
    for (const [text,line] of [[issue.header,1],[environment?.body || "",environment?.bodyLine || 1]] as const) {
      for (const [i, raw] of text.split(/\r?\n/).entries()) if (/^(?:\s*[-*]\s*)?(?:发现批次|反馈批次|验收批次|验收反馈)\s*[:：]/.test(raw) &&
        batchMatches(issue,batch,raw)) return [ref(issue.file,line+i)];
    }
    return [];
  });
}
export function archiveText(issue: Issue, into: string, stamp: string, view: ReturnType<typeof issueViews>[number]) {
  // 只移单、保留原字节备份。档案中的仓库相对链接移到新位置后仍指向老出处。
  const text = issue.text.replace(issueStatus,"$1已解决（关闭原因：完成）");
  const rebased = text.replace(/(\]\(\s*)(<([^>]+)>|([^\s)]+))(\s*\))/g,(full,a: string, token: string, bracket: string, bare: string,b: string) => {
    const link = bracket || bare;
    if (/^(?:[a-z][a-z\d+.-]*:|[/#])/i.test(link) || !link) return full;
    const [path,...fragment] = link.split("#"), newPath = relative(dirname(into),resolve(dirname(issue.file),path));
    const next = (newPath.startsWith(".") ? newPath : "./" + newPath) + (fragment.length ? "#" + fragment.join("#") : "");
    return a + (token.startsWith("<") ? `<${next}>` : next) + b;
  });
  const eol = issue.text.includes("\r\n") ? "\r\n" : "\n";
  return rebased + eol + eol + [ `## 关单依据（${stamp}）`, "",
    `修复执行：${view.execution} · ${"commit" in view ? view.commit : ""}`,
    `防复发：${"proof" in view && view.proof ? `${view.proof.target}（${view.proof.before} → ${view.proof.after}）` : issue.attribution}`,
    ...view.evidence.map(s=>`- [证据](<${s.file}>)${s.line ? ` · 第 ${s.line} 行` : ""}`), ""].join(eol);
}