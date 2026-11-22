import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Reader, canonical, entry, hash, object, ref, repoPath, sha, str, strings, time, type Doc, type Ref } from "./files.ts";

export interface Check { source: Ref; step: string; result: string; commit: string; detail: string; evidence: string[]; value: Doc }
export interface Execution {
  id: string; dir: string; task: Doc; status: Doc; loop: Doc; started?: number; batch?: Batch; card: string;
  checks: Check[]; ledgerOK: boolean; read: Reader;
}
export interface Batch { key: string; card: string; name: string; dir: string; results: string; acceptance: string; runs: Execution[] }
export type Deployment = { at?: number; source: Ref; result: string; commit: string; execution: string };
export const deployedOK = (d?: Deployment) => !!d && ["已部署","已部署（未检查）"].includes(d.result);
export const delivered = (run: Execution) => str(object(run.loop.delivery).commit) || str(run.loop.commit);
export const official = (check: Check) => check.step === "评审" && ["通过", "必修"].includes(check.result);
export const roundOf = (check: Check) => Number(check.evidence.map(f => /-r(\d+)(?:-a\d+)?\.md$/.exec(f)?.[1]).find(Boolean)) || undefined;
export const statusRef = (run: Execution, field?: string) => ref(join(run.dir, "status.json"), undefined, field);
export const taskRef = (run: Execution, field?: string) => ref(join(run.dir, "task.json"), undefined, field);
export const taskFile = (run: Execution, path: string) => repoPath(run.dir, path);

export class Project {
  root: string;
  tasks: string;
  read: Reader;
  config: Doc;
  state: string;
  runs: Execution[] = [];
  batches: Batch[] = [];
  catalogOK = true;
  query: { source: string; available: boolean; matched: number; execution?: string; error?: string };
  constructor(root: string, tasks: string, loop: string) {
    this.root = root; this.state = join(root, ".dev-loop-coord"); this.tasks = tasks;
    this.read = new Reader(root); this.config = this.read.doc(join(root, ".dev-loop-coord.json")) || {};
    this.query = {source: `${loop} 查询 --brief --json`, available: false, matched: 0};
    const index = new Reader(tasks);
    const catalogue = index.list(tasks);
    if (index.warnings.length) this.catalogOK = false;
    for (const e of catalogue.filter(e => e.isDirectory() && !e.name.startsWith("."))) {
      const dir = join(tasks, e.name), path = join(dir, "task.json");
      const task = index.doc(path), repo = str(task?.repo);
      if (!task || !isAbsolute(repo)) { this.catalogOK = false; continue; }
      if (index.get(path, () => canonical(repo)) !== root) continue;
      if (task.executionId !== e.name) { this.read.warn(path, "登记执行编号与目录不一致"); this.catalogOK = false; continue; }
      const read = new Reader(dir, this.read.warnings), statusPath = join(dir, "status.json");
      const status = read.doc(statusPath);
      if (!status || status.executionId !== e.name) read.warn(statusPath, "状态缺失或执行编号不符");
      const checksPath = join(dir, "checks.jsonl"), count = this.read.warnings.length;
      const checks = read.lines(checksPath).flatMap(({value, source}): Check[] => {
        if (typeof value.step !== "string" || typeof value.result !== "string") { read.warn(checksPath, "没有检查步骤或结论", source.line); return []; }
        return [{source, value, step: value.step, result: value.result, commit: str(value.commit), detail: str(value.detail), evidence: strings(value.evidence)}];
      });
      const ledgerOK = count === this.read.warnings.length && !!read.get(checksPath, () => entry(dir,checksPath)?.isFile());
      if (!ledgerOK) read.warn(checksPath, "检查流水缺失或不完整");
      const card = str(task.card), safeCard = card && this.read.get(path, () => {
        // 历史卡可能已删除，但其登记路径仍可引用；不把另一仓库的卡算进来。
        const p = repoPath(root, card);
        if (canonical(p) !== p) throw new Error("开发卡路径含符号链接：" + p);
        return p;
      });
      const ownStatus = status?.executionId === e.name ? status : {};
      const state = object(ownStatus.loop);
      this.runs.push({id: e.name, dir, task, status: ownStatus, loop: state, card: safeCard || "", checks, ledgerOK, read});
    }
    if (!this.catalogOK) this.read.warn(tasks, "执行索引部分不可读；未猜测归属，缺失不能视为没有");
    for (const run of this.runs) run.started = time(run.task.createdAt) ?? time(object(run.loop.facts).startedAt);
    this.runs.sort((a,b) => (a.started ?? -Infinity) - (b.started ?? -Infinity) || a.id.localeCompare(b.id));
    const latest = this.runs.at(-1);
    if (latest) this.publicStatus(loop,latest);
    this.loadBatches();
  }
  path(name: string) { return repoPath(this.root, name); }
  setting(key: string, fallback: string) {
    const path = str(this.config[key]);
    if (path) {
      const configured = this.read.get(join(this.root,".dev-loop-coord.json"),()=>this.path(path));
      if (configured) return configured;
    }
    return this.path(fallback);
  }
  private publicStatus(loop: string, run: Execution) {
    this.query.execution = run.id;
    try {
      // 只查询本项目最新执行。--all 还会读取其他项目的答复/活动工作区，不作为项目复盘入口。
      const text = execFileSync(loop, ["查询", "--brief", "--json"], {cwd: this.root, encoding: "utf8", timeout: 12000, maxBuffer: 8 * 1024 * 1024,
        env: {...process.env, LOOP_NODE:process.execPath, LOOP_TASKS_ROOT: this.tasks, LOOP_TASK_DIR: run.dir}, stdio:["ignore","pipe","pipe"]});
      const result = object(JSON.parse(text)), s = object(Array.isArray(result.executions) && result.executions[0]);
      if (result.complete !== true || s.executionId !== run.id || object(s.refs).card !== run.task.card) throw new Error("公开查询未返回登记的执行");
      this.query.available = true;
      this.query.matched = 1;
      // 查询只补齐同一次读取的公开字段；不用旧/新版本的状态拼接不同现场。
      if (s.seq === run.status.seq && s.updatedAt === run.status.updatedAt) { run.status = s; run.loop = object(s.loop); }
    } catch (e) {
      this.query.error = "公开查询不可用；本次仅使用已核对归属的原始状态";
      run.read.warn(join(run.dir,"status.json"),this.query.error);
    }
  }
  private loadBatches() {
    const byCard = new Map<string, Batch>();
    const add = (card: string) => {
      let batch = byCard.get(card);
      if (!batch) {
        const dir = dirname(card), nested = basename(card) === "开发卡.json";
        const name = nested ? basename(dir) : basename(card, ".json");
        // 旧 loop-cards/ 的平铺卡按文件区分，不共用一个验收.md。
        const results = join(dir, nested ? "结果.md" : `${name}-结果.md`), acceptance = join(dir, nested ? "验收.md" : `${name}-验收.md`);
        batch = {key: relative(this.root, nested ? dir : card), card, dir, name, results, acceptance, runs: []};
        byCard.set(card, batch);
      }
      return batch;
    };
    const roots = new Set([this.setting("batches", "docs/batches"), this.path("loop-cards")]);
    for (const dir of roots) for (const child of this.read.list(dir)) {
      const path = join(dir, child.name);
      if (child.isDirectory() && this.read.list(path).some(e => ["开发卡.json", "验收.md", "结果.md"].includes(e.name) && e.isFile())) add(join(path, "开发卡.json"));
      if (child.isFile() && /\.json$/.test(child.name) && this.read.doc(path)?.version === 1) add(path);
    }
    for (const run of this.runs) if (run.card) { run.batch = add(run.card); run.batch.runs.push(run); }
    this.batches = [...byCard.values()].sort((a,b) => a.key.localeCompare(b.key));
  }
}

export function checked(project: Project, run: Execution) {
  const commit = delivered(run), prompt = str(run.task.prompt), acceptance = str(run.task.acceptance);
  const read = (path: string) => project.read.get(path, () => project.read.text(project.path(path)));
  // 关单只认同一交付 + 当前提示词和验收哈希；缺材料不猜，不拿「没验证」当通过。
  const p = prompt ? read(prompt) : undefined, a = acceptance ? read(acceptance) : "";
  const hashes = p !== undefined && a !== undefined ? {promptHash: hash(p), acceptanceHash: hash(a)} : undefined;
  const selected = run.checks.filter(c => hashes && c.commit === commit && c.value.promptHash === hashes.promptHash && c.value.acceptanceHash === hashes.acceptanceHash);
  const test = selected.findLast(c => c.step === "复测"), review = selected.findLast(c => c.step === "评审");
  return {commit, hashes, test, review, passed: run.ledgerOK && sha(commit) && test?.result === "通过" && review?.result === "通过"};
}
export function mergeFacts(run: Execution, commit = delivered(run)) {
  const merges = run.checks.filter(c => c.step === "合入" && c.commit === commit && /^(已合入(?:（未验证）)?|已在 dev)$/.test(c.result));
  const versions = new Set([commit]);
  for (const c of merges) {
    try { const after = object(JSON.parse(c.detail)).devAfter; if (sha(after)) versions.add(after); } catch { /* 无 devAfter，不能把其他部署版本归到本批。 */ }
  }
  return {versions, merges};
}
export function deployments(project: Project, batch: Batch, run: Execution, history = false): Deployment[] {
  const registered = new Set([delivered(run)]);
  if (history) for (const c of run.checks) if (c.step === "开发" && c.result === "已交付") registered.add(c.commit);
  const versions = new Set([...registered].flatMap(commit=>[...mergeFacts(run,commit).versions]));
  const result = run.checks.flatMap((c): Deployment[] => ["部署", "退回"].includes(c.step) && versions.has(c.commit) && sha(c.commit) ?
    [{at:time(c.value.endedAt), source:c.source, result:c.result, commit:c.commit, execution:run.id}] : []);
  // 缺时只用唯一、同执行同版的旧批次结果段补齐；已记录的退回和多次部署不由旧摘要覆盖。
  const last = result.at(-1);
  if (result.length > 1 || last && (last.at !== undefined || !deployedOK(last))) return result;
  const paths = basename(batch.card) === "开发卡.json" ? [batch.results] : [batch.results, join(batch.dir,"结果.md")];
  const notes: Deployment[] = [];
  for (const file of paths) {
    let execution = "", commit = "";
    for (const [i,line] of (project.read.text(file) || "").split(/\r?\n/).entries()) {
      if (/^##\s/.test(line)) { execution = ""; commit = ""; }
      const field = /^(执行|版本|部署时间)\s*[:：]\s*(.*?)\s*$/.exec(line);
      if (!field) continue;
      const [, key, value] = field;
      if (key === "执行") execution = value;
      if (key === "版本") commit = value;
      if (key !== "部署时间" || execution !== run.id || !registered.has(commit) || !sha(commit)) continue;
      if (last && !mergeFacts(run,commit).versions.has(last.commit)) continue;
      const at = time(value);
      if (at !== undefined) notes.push({at, source:ref(file,i+1), result:last?.result || "已部署", commit:last?.commit || commit, execution});
    }
  }
  return notes.length === 1 ? notes : result;
}

/** 批次视图按实际部署时间选版本，不按最后一次重试。退回只影响对应版本，不当成新部署。 */
export function batchDeployment(project: Project, batch: Batch) {
  const candidates = batch.runs.flatMap(run => {
    const records = deployments(project,batch,run,true), i = records.findLastIndex(deployedOK);
    if (i < 0) return [];
    const success = records[i];
    const latest = records.slice(i+1).findLast(d=>d.commit === success.commit && ["已退回","退回失败"].includes(d.result));
    return [{run,success,latest:latest || success}];
  });
  // 若某执行最后的成功部署没有时间，无法证明它早于其他部署，不能拿其他版本的时间结束提醒。
  return candidates.findLast(d=>d.success.at === undefined) ?? candidates.reduce<typeof candidates[number] | undefined>((latest,d)=>
    !latest || (d.success.at ?? 0) >= (latest.success.at ?? 0) ? d : latest,undefined);
}