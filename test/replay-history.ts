// Read-only comparison of legacy report evidence with the new gate. No runtime import of legacy reports.
import { join, resolve } from "node:path";
import { evidence } from "../src/core/inputs.ts";
import { allTasks, hasLedger, type Check, type Entry } from "../src/core/store.ts";
import { tasksRoot } from "../src/infra/paths.ts";
import { jsonLines, readJson, maybe } from "../src/infra/files.ts";
export function replay(root=tasksRoot()) {
  const mismatches:unknown[]=[], stops:Record<string,string>[]=[], unreadable:unknown[]=[], executions:string[]=[]; let records=0, oldAllowed=0, newAllowed=0;
  for (const dir of allTasks(resolve(root)).filter(d=>!hasLedger(d))) try {
    const checks=jsonLines<Check>(join(dir,"checks.jsonl")), id=readJson<{executionId:string}>(join(dir,"task.json")).executionId;
    executions.push(id); records+=checks.length;
    const key=(c:Check)=>JSON.stringify([c.promptHash,c.acceptanceHash,c.e2eHash]), rows=checks.map((c,n):Entry=>({type:c.step,n,at:c.endedAt,sha:c.commit,key:key(c),check:c}));
    const tests=checks.filter(c=>c.step==="复测" && c.result!=="已停止"), versions=new Map(tests.map(t=>[JSON.stringify([t.commit,key(t)]),t]));
    for (const t of versions.values()) {
      const matches=(c:Check)=>c.commit===t.commit && key(c)===key(t), legacy=t.e2eHash ? tests.findLast(c=>matches(c) && c.attempt) : tests.findLast(c=>matches(c) && ["通过","没验证"].includes(c.result));
      const reviews=checks.filter(c=>c.step==="评审" && c.result!=="已停止" && matches(c));
      const old=!!legacy && (t.e2eHash ? ["通过","本人接受环境缺项"].includes(legacy.result) && reviews.findLast(c=>c.tree===legacy.tree && c.attempt===legacy.attempt)?.result==="通过" : reviews.some(c=>c.result==="通过"));
      const fresh=evidence(rows,t.commit,key(t),t.tree).verified; oldAllowed+=Number(old);newAllowed+=Number(fresh);
      if (old!==fresh) mismatches.push({executionId:id,commit:t.commit,attempt:legacy?.attempt,old,new:fresh,test:legacy?.result,lastReview:reviews.at(-1)?.result});
    }
    for (const c of checks.filter(c=>c.step==="合入" && c.result==="已合入（未验证）")) mismatches.push({executionId:id,commit:c.commit,old:true,new:false,reason:"旧记录未保留接受未验证的本人原话，不自动移植 B"});
    for (const s of maybe(()=>readJson<any>(join(dir,"status.json")))?.loop?.facts?.stops || []) {
      const source=checks.findLast(c=>["复测","评审"].includes(c.step) && c.endedAt<=s.at), raw=[s.message,source?.detail].join("\n");
      const mechanical=s.reason==="临时故障" && /网络|fetch|ECONN|format|格式|触发|timeout|timed out/i.test(raw) || ["停下没交付","模型出错"].includes(s.reason) && /fetch failed|网络|断线|localFiles|候选仍未交付/.test(raw);
      stops.push({executionId:id,at:s.at,old:s.reason,resumedAt:s.resumedAt,route:mechanical ? "自动补步骤" : s.reason==="停下没交付" ? "提醒后分诊；历史证据不足" : "保留"});
    }
  } catch (e) {unreadable.push({dir,error:String(e)});}
  return {executions,records,oldAllowed,newAllowed,mismatches,stops,unreadable};
}
if (process.argv[1] && resolve(process.argv[1])===resolve(import.meta.filename)) console.log(JSON.stringify(replay(process.argv[2]),null,2));
