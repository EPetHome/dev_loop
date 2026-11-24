import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { piReviewArgs, piReviewer, projectReviewMaterial } from "../src/core/review-call.ts";
import { parseReview } from "../src/core/review-parse.ts";
import { loadConfig, type Config } from "../src/infra/config.ts";
import { childExec } from "../src/infra/exec.ts";
import { atomicWrite, jsonLines, readJson } from "../src/infra/files.ts";
import { commitOf, git, gitTry, historyEnv } from "../src/infra/git.ts";
import { APP_ROOT } from "../src/infra/paths.ts";

const f4 = {name:"F4", id:"promate-v2-web-V2--F4--F4-cc5b79", expected:["A8：列表页叠用详情组件，报出 U5。"]};
const plan = [
  {name:"W3-D", id:"personal-agent-W3-D---20261122-W3-D--04c8cf", expected:[
    "A1：授权记录来源、证据目录兼作授权消费记录、回答发出后才查询，均仍是必修。",
    ...Array<string>(5).fill("A1：样本外改措辞骗过规则的反例降为小问题，不再阻断。")],
  },
  {name:"W3-C", id:"personal-agent-W3-C---20261122-W3-C--e87126", expected:[
    "A3：都通过误记未列批次、到期覆盖已回复反馈、已做的授权重复计数仍是必修；半完成计划恢复、仅查显示禁读正文、收据目录不在写入范围三项不再是必修或改列需求疑问。"]},
  {name:"B1", id:"promate-v2-agent-V2--B1--B1-29febf", expected:[
    "A2：回查 #082–088 的 7 条真实后果仍是必修。", "A2：历史本轮无结论；代码与 R3 相同，另看 R3 所列问题的覆盖。",
    "A2：回查 #089–092 的 4 条真实后果仍是必修。", "A2：回查 #093–095 的 3 条真实后果仍是必修。", "A2：回查 #096–098 的 3 条真实后果仍是必修。",
    "A2 补充：第 18 条在 R6（#099），正常升级确认时的进程竞态仍是必修。"]},
  f4,
];
type HistoricalTask = {repo:string; baseCommit:string; executionId:string; limits?: {开发评审?: {timeoutMin:number}}};
type RecordedReview = {step:string; commit:string; evidence?: string[]};
type Source = {task:HistoricalTask; config:Config; rulesCommit:string; rules:string};
type Replay = {name:string; id:string; round:number; expected:string; control?: boolean};
type Report = {sample:Replay; commit?:string; rules?:string; model?:string; thinking?:string; stdout?:string; must?:string[]; error?:string};
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const historicalInput = (dir: string, round: number) => readFileSync(join(dir,`review-input-r${round}.md`),"utf8");
function diffOf(input: string) { return /^## 本轮改动\r?\n([\s\S]+?)^## 删除的文件\s*$/m.exec(input)?.[1]; }
function reviewedCommit(name: string, dir: string, round: number, input: string) {
  const checks = jsonLines<RecordedReview>(join(dir,"checks.jsonl"));
  const forRound = (r: number) => [...new Set(checks.flatMap(c => c.step === "评审" && sha.test(c.commit) &&
    c.evidence?.some(p => {
      const match = /^review-([0-9a-f]+)-r(\d+)-a\d+\.md$/.exec(basename(p));
      return match?.[1] === c.commit && Number(match[2]) === r;
    }) ? [c.commit] : []))];
  let commits = forRound(round);
  // B1 R2 在评审落账前中断；同一交付重试为 R3，当轮 diff 一致，不用最后一次交付猜版本。
  if (!commits.length && name === "B1" && round === 2 && diffOf(input) && diffOf(input) === diffOf(historicalInput(dir,3))) commits = forRound(3);
  if (commits.length !== 1) throw new Error(`第 ${round} 轮无法唯一确认被评提交`);
  return commits[0];
}

function archive(repo: string, commit: string, dir: string, cwd: string) {
  const env = historyEnv(), tar = join(dir,"source.tar");
  git(repo,["archive","--format=tar","--output="+tar,commit],env);
  mkdirSync(cwd);
  execFileSync("tar",["-xf",tar],{cwd,env:{...process.env,TAR_OPTIONS:undefined},stdio:["ignore","pipe","pipe"]});
  rmSync(tar);
}
function controlInput(cwd: string) {
  // 真正的对照 diff 只存在于 F4 起点的临时导出中，不在项目仓库里新增文件。
  const file = "web/src/views/R1ListControl.vue";
  writeFileSync(join(cwd,file),`<script setup lang="ts">
defineProps<{ filenames: string[] }>()
</script>

<template>
  <ul aria-label="已登记文件">
    <li v-for="(filename, index) in filenames" :key="index">{{ filename }}</li>
  </ul>
</template>
`,{flag:"wx"});
  const diff = gitTry(cwd,["diff","--no-index","--no-ext-diff","--no-textconv","--","/dev/null",file],historyEnv());
  if (diff.code !== 1 || !diff.stdout) throw new Error(diff.stderr || "未生成一行式列表对照 diff");
  return ["## 提示词原文", "静态对照：新增最小的已登记文件列表视图，只展示给定的文件名，不接路由或 API。",
    "## 验收标准", "每个文件名只占一个列表项，不叠用详情组件。",
    "## 本轮改动",diff.stdout,"## 删除的文件","无","## 新增文件",file,
    "## 本人答复","无","## 复测结果","未验证：本对照只做静态审查。"].join("\n\n");
}

function readSource(sample: Replay, taskDir: string): Source {
  const task = readJson<HistoricalTask>(join(taskDir,"task.json"));
  if (task.executionId !== sample.id || !sha.test(task.baseCommit)) throw new Error("历史执行编号或起点提交不符");
  const config = loadConfig(task.repo); // 当前项目配置与 dev-loop 默认值，不用历史 task.config。
  const rulesCommit = sample.name === "F4" ? commitOf(task.repo,"refs/heads/dev",historyEnv()) : task.baseCommit;
  return {task,config,rulesCommit,rules:projectReviewMaterial(task.repo,rulesCommit)};
}

async function replay(sample: Replay, tasks: string, scratch: string, signal: AbortSignal, sources: Map<string,Source>): Promise<Report> {
  const report: Report = {sample}, taskDir = join(tasks,sample.id);
  const dir = mkdtempSync(join(scratch,sample.name+"-")), cwd = join(dir,"source");
  try {
    // 同一执行的各轮用同一份当前配置；特别是 F4 实验和对照用同一个规则 SHA。
    const source = sources.get(sample.id) ?? readSource(sample,taskDir);
    sources.set(sample.id,source);
    const {task:t,config,rulesCommit,rules} = source;
    report.model = config.reviewerModel; report.thinking = config.reviewerThinking; report.rules = rulesCommit;
    const input = sample.control ? undefined : historicalInput(taskDir,sample.round);
    const commit = commitOf(t.repo,input === undefined ? t.baseCommit : reviewedCommit(sample.name,taskDir,sample.round,input),historyEnv());
    report.commit = commit; archive(t.repo,commit,dir,cwd);
    const inputPath = join(dir,`review-input-r${sample.round}.md`);
    writeFileSync(inputPath,(input ?? controlInput(cwd)).trimEnd()+"\n\n"+rules+"\n");
    const deadline = Date.now()+(t.limits?.开发评审?.timeoutMin ?? 60)*60_000, errors: string[] = [];
    for (let at = 1; at <= 2 && Date.now() < deadline && !signal.aborted; at++) {
      const session = randomUUID(), sessionDir = join(dir,session); mkdirSync(sessionDir);
      const run = await childExec(piReviewer(),piReviewArgs(config,session,sessionDir,inputPath,join(scratch,"review-prompt.md")),{
        cwd,timeoutMs:deadline-Date.now(),signal,env:{LOOP_TASK_DIR:dir,LOOP_REVIEW_SESSION_DIR:sessionDir},
      });
      const parsed = parseReview(run.stdout);
      if (!run.killed && run.code === 0 && parsed.ok) {
        report.stdout = run.stdout; report.must = parsed.review.mustFix; return report;
      }
      errors.push(`第 ${at} 次（退出码 ${run.code}${run.killed ? "，超时或取消" : ""}）：${(run.stderr || run.stdout).trim()}${parsed.ok ? "" : `\n${parsed.error}`}`);
    }
    report.error = errors.join("\n\n") || "未完成调用";
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally { rmSync(dir,{recursive:true,force:true}); }
  return report;
}

const section = (s: string, name: string) => new RegExp(`^## ${name}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,"m").exec(s)?.[1].trim();
function reportMarkdown(reports: Report[], started: string, prompt: string) {
  const md = ["# R1 评审回放", "", `运行时间：${started}。提示词 SHA-256：\`${prompt}\`。`, "",
    "用当轮原始输入（含当时的上轮必修、复测摘要）及当前评审提示词独立重评；没有把新结论写回历史执行，也没有运行产品。",
    "F4 和一行式对照用本次运行时的 Promate 网页 dev 的项目规则；其他用历史执行的起点版本。",
    "B1 R2 无历史评审结论；其当轮 diff 与 R3 一致，取检查流水中 R3 的被评提交。B1 R6 为 A2 的补充对照（回查第 18 条）。",
    "每轮的语义对照按原条目核实，不能仅用必修数量判为满足预期。"];
  for (const r of reports) {
    const {sample} = r;
    md.push("",`## ${sample.name} ${sample.control ? "一行式列表对照" : `R${sample.round}`}`,"",
      `- 执行：\`${sample.id}\`；${sample.control ? "对照起点" : "被评提交"}：\`${r.commit ?? "未确认"}\`。`,
      `- 模型：\`${r.model ?? "未确认"}\`（${r.thinking ?? "未确认"}）；项目规则版本：\`${r.rules ?? "未确认"}\`。`);
    if (!r.must || r.stdout === undefined) {
      md.push("- 新结论：未验证；必修条数：未知。",`- 对照：${sample.expected} 未验证（无可解析评审）。`,"",
        ...String(r.error).split("\n").map(line=>"> "+line));
      continue;
    }
    const conclusion = /^## 结论[:：]\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || "未写结论";
    md.push(`- 新结论：${conclusion}；必修 ${r.must.length} 条。`,`- 对照：${sample.expected} 待逐条比对。`,"");
    r.must.forEach((item,i) => {
      const issue = /问题\s*[:：]\s*(.+?)(?=\s+(?:依据|建议)\s*[:：]|$)/.exec(item)?.[1] || item;
      const loc = /位置\s*[:：]\s*(.+?)(?=\s+触发\s*[:：]|$)/.exec(item)?.[1];
      md.push(`${i+1}. ${loc ? loc+" — " : ""}${issue.replace(/[。！？]\s*(?=\S)/g,"；")}`);
    });
    for (const name of ["小问题","需求疑问","上轮必修复查"]) {
      const text = section(r.stdout,name);
      if (text && text !== "无") md.push("",`**${name}**`,"",text.replace(/[ \t]+$/gm,""));
    }
  }
  return md.join("\n").trimEnd()+"\n";
}

async function main() {
  const tasks = resolve(process.env.LOOP_TASKS_ROOT || join(homedir(),".dev-loop/tasks"));
  const out = join(APP_ROOT,"docs/评审/R1-回放.md");
  const jobs = Number(process.env.LOOP_REPLAY_JOBS ?? "3");
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 6) throw new Error("LOOP_REPLAY_JOBS 须为 1–6 的整数");
  const samples: Replay[] = plan.flatMap(g=>g.expected.map((expected,i)=>({name:g.name,id:g.id,round:i+1,expected})));
  samples.push({name:f4.name,id:f4.id,round:1,expected:"A8：一条一行，不叠用详情页组件，不报 U5。",control:true});
  const started = new Date().toISOString(), prompt = readFileSync(join(APP_ROOT,"src/core/review-prompt.md"));
  // 固定系统临时目录：不让项目的 TMPDIR 指到项目工作区。
  const scratch = mkdtempSync(join(realpathSync("/tmp"),"loop-replay-r1-")), controller = new AbortController();
  const stop = () => controller.abort(); process.once("SIGINT",stop); process.once("SIGTERM",stop);
  try {
    writeFileSync(join(scratch,"review-prompt.md"),prompt);
    let next = 0; const reports: Report[] = [], sources = new Map<string,Source>(), workers: Promise<void>[] = [];
    const work = async () => {
      while (next < samples.length && !controller.signal.aborted) {
        const i = next++, sample = samples[i], label = `${sample.name} ${sample.control ? "对照" : `R${sample.round}`}`;
        console.error(`${label}：开始`);
        const result = reports[i] = await replay(sample,tasks,scratch,controller.signal,sources);
        console.error(`${label}：${result.must ? `必修 ${result.must.length} 条` : result.error}`);
      }
    };
    for (let i = 0; i < jobs; i++) workers.push(work());
    const failed = (await Promise.allSettled(workers)).find(r=>r.status === "rejected");
    if (failed) throw failed.reason;
    if (controller.signal.aborted) throw new Error("回放已中断；保留原报告");
    atomicWrite(out,reportMarkdown(reports,started,createHash("sha256").update(prompt).digest("hex")));
    console.log(out);
    if (reports.some(r=>!r.must)) process.exitCode = 1;
  } finally { process.off("SIGINT",stop); process.off("SIGTERM",stop); rmSync(scratch,{recursive:true,force:true}); }
}

main().catch(error=>{ console.error(error); process.exitCode = 1; });
