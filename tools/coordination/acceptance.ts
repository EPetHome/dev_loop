import { days, ref, time } from "./files.ts";
import { batchDeployment, deployedOK, statusRef, taskRef, type Project } from "./history.ts";
import { authorizationFor, decisionsIn, issueFeedback, type Issue } from "./issues.ts";
import { plain, sections } from "./markdown.ts";

const unconfirmed = "未确认（无反馈）";
const header = /^(\uFEFF?[^\S\r\n]*(?:\*\*)?状态(?:\*\*)?[^\S\r\n]*[:：](?:\*\*)?[^\S\r\n]*)([^\r\n]+)/;
const settled = new Set(["通过", "不通过", "不验", unconfirmed]);
const pending = new Set(["待验", "待验收"]);
const renderTime = (t: number | undefined) => t === undefined ? null : new Date(t).toISOString();
const hasFeedback = (s: string) => !!s.trim() && !/^(?:无|暂无|待反馈|未反馈|未确认|待补充|[-—]+)[。.\s]*$/.test(plain(s));

function feedbackAt(path: string, text: string) {
  return [...sections(text).filter(b=>/^(?:本人|后续|验收)?反馈(?:$|[：:（(])/.test(b.title) && hasFeedback(b.body)).map(b=>ref(path,b.line)),
    ...text.split(/\r?\n/).flatMap((l,i) => {
      const note = /^(?:\s*[-*]\s+)?(?:(?:本人|后续|验收)?反馈|验收结果)\s*[:：]\s*(.*)$/.exec(plain(l));
      return note && hasFeedback(note[1]) ? [ref(path,i+1)] : [];
    })];
}
export function acceptances(project: Project, list: Issue[], now: number, opening: boolean, card: string, readerReady: boolean, originals?: ReadonlyMap<string,string>) {
  return project.batches.flatMap(batch => {
    const file = batch.acceptance, text = project.read.text(file) ?? originals?.get(file);
    if (text === undefined) return [];
    const status = plain(header.exec(text)?.[2] || ""), deployment = batchDeployment(project,batch), deployed = deployment?.latest;
    const success = deployment && deployedOK(deployed) ? deployment.success : undefined;
    const observed = success ? deployment?.run : batch.runs.findLast(r=>r.status.state === "completed");
    const contacts = [...feedbackAt(file,text),...issueFeedback(list,batch)];
    const actual = decisionsIn(text,file), permissions = observed ? authorizationFor(observed) : [];
    const original = text.split(/^## 协调记录：未确认（无反馈）\s*$/m,1)[0];
    const entries = original.split(/\r?\n/).flatMap((line,i) => {
      const raw = plain(line).replace(/^[-*+]\s+/, "");
      const auth = /\[授权\]/.test(raw), hand = /\[人工\]/.test(raw), numbered = /^(A\d+|\d+)\s*[.、)]\s*/.exec(raw);
      if (!auth && !hand && !numbered) return [];
      const id = numbered?.[1] || /\bA\d+\b/.exec(raw)?.[0] || `第 ${i+1} 行`;
      const decision = actual.findLast(d=>d.id === id) || permissions.findLast(d=>d.id === id);
      const done = actual.some(d=>d.id === id && d.decision.endsWith("已做")) || decision?.decision.endsWith("已做");
      return [{id, kind:auth ? "授权" : "人工", text:raw, source:ref(file,i+1), ...(auth && {authorization:done ? "本人已做" : "授权未做", decision})}];
    });
    // 下批必须是不同卡、同项目，且确实在上一批就绪后；没有部署时间时不造七日到期。
    const lastReview = observed?.checks.findLast(c=>c.step === "评审" && c.result === "通过");
    const readyAt = success?.at ?? (time(lastReview?.value.endedAt) ?? observed?.started);
    const next = readyAt === undefined ? undefined : project.runs.find(r=>r.batch && r.batch !== batch && r.started !== undefined && r.started > readyAt && r.started <= now);
    const prospective = opening && (!card || batch.card !== card) && readyAt !== undefined && readyAt < now;
    const nextAt = next?.started ?? (prospective ? now : undefined), sevenAt = success?.at === undefined ? undefined : success.at + days(7);
    const expires = Math.min(nextAt ?? Infinity,sevenAt ?? Infinity);
    const due = expires <= now, reason = due ? (nextAt === expires ? "同项目下次开工" : "部署满七天") : null;
    const deploymentSources = deployment ? [deployment.success.source, ...(deployed !== deployment.success ? [deployment.latest.source] : [])] : [];
    const sources = [ref(file,1), ...(observed ? [taskRef(observed), statusRef(observed)] : []), ...deploymentSources, ...(next ? [taskRef(next)] : [])];
    const state = contacts.length && !["通过","不通过","不验"].includes(status) ? "有反馈" : settled.has(status) || pending.has(status) ? status : "未知";
    const eligible = pending.has(status) && !contacts.length && due;
    const view = {batch:batch.key, file, storedStatus:status || null, state, entries, feedback:contacts, deploymentAt:renderTime(success?.at),
      deployment:deployed?.result ?? null, deploymentExecution:deployed?.execution ?? null, deploymentCommit:deployed?.commit ?? null,
      nextStartAt:renderTime(nextAt), sevenDaysAt:renderTime(sevenAt), due:eligible, reason:eligible ? reason : null, sources,
      reminder:state === "待验" || state === "待验收", writable:eligible && readerReady};
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const updated = !view.writable ? undefined : text.replace(header,(_,prefix:string)=>prefix + unconfirmed) + eol + eol + ["## 协调记录：未确认（无反馈）", "",
      `结束人工提醒：${reason}。不视同通过，不变更授权要求。`, ...entries.map(e=>`- ${e.id} [${e.kind}]：${e.authorization || unconfirmed}`), ""].join(eol);
    return [{text,view,updated}];
  });
}