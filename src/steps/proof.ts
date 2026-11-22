import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { privateCheckout } from "../infra/checkout.ts";
import { inside, isObject, safeRelative } from "../infra/config.ts";
import { atomicWrite, BusyError, digest, errorText, ifPresent, readJson, span, underLock, withLock, writeJson } from "../infra/files.ts";
import { checkPin, git, gitBytes, historyEnv } from "../infra/git.ts";
import { InputError, observed, type Observation } from "../core/card.ts";
import { boundReport, e2eResult, evidenceFile, planIn, requireReport, type Measurement, type ReportExit } from "../core/e2e.ts";
import { batchResult, checksOf, recordStep, statusOf, type Check, type Hashes, type Task } from "../core/store.ts";
import { clip } from "../core/test-summary.ts";
import { projectCommand } from "../core/run.ts";
const step = "防复发证明";
type Proof = NonNullable<Task["proofs"]>[number];
type Binding = Hashes & {commit:string; tree:string};
type Target = Measurement & {expected:Observation};
const exact = (p: string) => safeRelative(p) && !/[\\*?\[\]]/.test(p) && p.split("/").every(n => n && n !== "." && n.toLowerCase() !== ".git");
const fullSHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const treeFiles = (repo: string, commit: string, env: NodeJS.ProcessEnv, paths: string[] = []) =>
  git(repo,["ls-tree","--full-tree","-rz",commit,"--",...paths],env).split("\0").slice(0,-1).map(line => {
    const [,mode,oid,path] = /^(\d+) \w+ (\w+)\t([\s\S]+)$/.exec(line)!;
    return {path,mode,oid};
  });
function isolatedGit() {
  const fixed = Object.entries({"core.hooksPath":"/dev/null","core.fsmonitor":"false","core.ignoreStat":"false",
    "core.sparseCheckout":"false","core.symlinks":"true","submodule.recurse":"false"});
  return Object.assign(historyEnv(),{GIT_CONFIG_COUNT:String(fixed.length)},...fixed.map(([k,v],i) => ({[`GIT_CONFIG_KEY_${i}`]:k,[`GIT_CONFIG_VALUE_${i}`]:v})));
}
function extract(t: Task, p: Proof, commit: string, env: NodeJS.ProcessEnv) {
  const dirs = t.config.proofTestDirs || [];
  requireReport(fullSHA.test(p.before) && fullSHA.test(commit),"证明须绑定已登记的完整提交 SHA");
  requireReport(dirs.length && dirs.every(exact),"项目未登记有效的 proofTestDirs 测试目录");
  const invalid = p.testFiles.find(path => !exact(path) || !dirs.some(d => path.startsWith(d+"/")));
  if (invalid) throw new Error((exact(invalid) ? "测试材料不在项目登记的测试目录内：" : "测试材料路径不合法或越界：")+invalid);
  const files = treeFiles(t.repo,commit,env,p.testFiles);
  return p.testFiles.map(path => {
    const obj = files.find(row => row.path === path);
    requireReport(obj && ["100644","100755"].includes(obj.mode),"交付中不存在此普通测试文件（不接受链接、目录或子模块）："+path);
    const bytes = gitBytes(t.repo,["cat-file","blob",obj.oid],env);
    return {path,mode:obj.mode,sha256:digest(bytes),bytes};
  });
}
interface Pair {t:Task; p:Proof; binding:Binding; attempt:string; files:ReturnType<typeof extract>; env:NodeJS.ProcessEnv; signal:AbortSignal}
function originalDir(path: string) {
  const stat = lstatSync(path,{throwIfNoEntry:false});
  if (!stat) return false;
  requireReport(stat.isDirectory() && realpathSync.native(path) === path,"测试材料目录非原名普通目录："+path);
  return true;
}
function mount(cwd: string, commit: string, {t,env,p,files}: Pair) {
  const dirs = t.config.proofTestDirs || [], roots = dirs.filter(d => !dirs.some(other => d.startsWith(other+"/")));
  const entries = treeFiles(cwd,commit,env), allowed = [...p.testFiles];
  for (const {path,mode} of entries) {
    if (roots.some(d => path === d || path.startsWith(d+"/"))) allowed.push(path);
    if (mode === "160000" && p.testFiles.some(name => name === path || name.startsWith(path+"/"))) throw new Error("测试材料不能覆盖子模块："+path);
    if (mode !== "120000") continue;
    const link = join(cwd,path), target = resolve(dirname(link),readlinkSync(link));
    requireReport(inside(cwd,target) && inside(cwd,ifPresent(() => realpathSync(link)) || target),"临时检出中的链接越出本版本："+path);
  }
  // 清空两端历史测试目录（含空子目录），只挂载交付版本明确列出的字节。
  for (const root of roots.map(d => join(cwd,d))) if (originalDir(root)) rmSync(root,{recursive:true});
  const selected = new Set(p.testFiles), parents = new Set<string>();
  for (const f of files) {
    const name = join(cwd,f.path), parent = dirname(name);
    let existing = parent;
    while (!originalDir(existing)) existing = dirname(existing);
    for (let dir = dirname(f.path); dir !== "."; dir = dirname(dir)) parents.add(dir);
    mkdirSync(parent,{recursive:true});
    requireReport(!lstatSync(name,{throwIfNoEntry:false}),"测试材料路径重名："+f.path);
    atomicWrite(name,f.bytes);
    chmodSync(name,f.mode === "100755" ? 0o755 : 0o644);
  }
  const verifyView = (path: string) => {
    const dir = join(cwd,path);
    if (!originalDir(dir)) return;
    requireReport(parents.has(path),"出现未登记的测试材料："+path);
    for (const item of readdirSync(dir,{withFileTypes:true})) {
      const file = path+"/"+item.name;
      if (item.isDirectory() && parents.has(file)) verifyView(file);
      else requireReport(item.isFile() && selected.has(file),"出现未登记的测试材料："+file);
    }
  };
  return () => {
    checkPin(cwd,commit,allowed,env);
    roots.forEach(verifyView);
    for (const f of files) {
      const name = evidenceFile(cwd,f.path), mode = lstatSync(name).mode & 0o111;
      requireReport(realpathSync.native(name) === join(cwd,f.path) && Boolean(mode) === (f.mode === "100755") && digest(readFileSync(name)) === f.sha256,"运行时测试材料偏离交付内容："+f.path);
    }
  };
}
function sandbox(cwd: string, {t,env}: Pair) {
  const HOME = join(dirname(cwd),"home"), TMPDIR = join(dirname(cwd),"tmp");
  for (const dir of [HOME,TMPDIR]) mkdirSync(dir);
  const PATH = (process.env.PATH || "").split(":").filter(p => isAbsolute(p) &&
    [p,ifPresent(() => realpathSync(p))].every(name => name && !inside(t.repo,name) && !inside(dirname(t.dir),name))).join(":");
  return {...env,PATH:PATH || "/usr/bin:/bin",HOME,TMPDIR,XDG_CONFIG_HOME:join(HOME,"config"),XDG_CACHE_HOME:join(HOME,"cache"),
    XDG_DATA_HOME:join(HOME,"data"),GIT_ALLOW_PROTOCOL:"file",GIT_LITERAL_PATHSPECS:undefined};
}
function attemptPlan(t: Task, p: Proof, binding: Binding, attempt: string) {
  return {executionId:t.executionId,attempt,proof:p,setup:t.config.setup,timeoutMin:t.limits.测试.timeoutMin,...binding};
}
function replayPlan({t,p,attempt,binding}: Pick<Pair,"t"|"p"|"attempt"|"binding">, commit: string) {
  const ids = {executionId:t.executionId,attempt,commit}, {expected} = p;
  return p.scenario === undefined ? {...ids,testName:p.testName,expected}
    : {...binding,...ids,scenarios:[{id:p.scenario,checks:[{id:p.checkpoint,expected}]}]};
}
function readObservation(dir: string, plan: ReturnType<typeof replayPlan>, p: Proof, run: ReportExit, evidence: Set<string>): Target {
  if ("scenarios" in plan) {
    let witness: Measurement | undefined;
    const result = e2eResult({dir,plan},p.test,run,o => { witness = o; });
    for (const file of result.evidence) evidence.add(file);
    requireReport(witness,result.detail);
    return {...witness,expected:p.expected};
  }
  const {actual,status,testName,expected} = boundReport<Target & {testName:string}>(dir,plan,evidence);
  requireReport(testName === plan.testName && observed(actual) && observed(expected),"未命中定向测试名或缺少有效预期/实得："+plan.testName);
  return {actual,status,expected};
}
async function replay(pair: Pair, commit: string, dir: string) {
  const {t,p,env,signal} = pair, {expected} = p, plan = replayPlan(pair,commit);
  planIn(dir,plan);
  const scene = "scenarios" in plan, evidence = new Set([join(dir,"plan.json")]), warnings: string[] = [];
  const deadline = Date.now()+t.limits.测试.timeoutMin*60000;
  let observation: Target | undefined, code: number | undefined, reason: string | undefined;
  try {
    requireReport(!signal.aborted,"证明已中断，未执行本端");
    await privateCheckout(t.repo,commit,[dirname(t.dir),t.worktree],env,async cwd => {
      const verify = mount(cwd,commit,pair);
      const work = {...t,worktree:cwd}, opts = {deadline,signal,isolated:sandbox(cwd,pair),sealed:true};
      verify();
      await projectCommand(work,"setup",join(dir,"setup.log"),opts);
      verify();
      const run = await projectCommand(work,"test",join(dir,"test.log"),{...opts,command:p.test,planEnv:{[scene ? "LOOP_E2E_DIR" : "LOOP_PROOF_DIR"]:dir}});
      requireReport(run,"证明命令没有执行");
      code = run.code;
      verify();
      observation = readObservation(dir,plan,p,run,evidence);
      const pass = observation.actual === expected, red = scene ? 1 : 76;
      requireReport(!run.killed && observation.expected === expected && observation.status === (pass ? "通过" : "失败") && run.code === (pass ? 0 : red),"目标断言的预期、实得、状态或命令退出码不一致");
    },warning => warnings.push(warning));
  } catch (e) { reason = errorText(e); }
  requireReport(realpathSync(dir) === dir,"证明证据目录已改变："+dir);
  const log = ["test.log","setup.log"].map(f => join(dir,f)).find(existsSync) || join(dir,"error.log");
  if (reason && !existsSync(log)) atomicWrite(log,reason+"\n");
  for (const name of ["setup.log",relative(dir,log)]) if (existsSync(join(dir,name))) evidence.add(evidenceFile(dir,name));
  if (reason && code !== undefined) reason += `（退出码 ${code}）\n${clip(readFileSync(log,"utf8").trimEnd(),2048,true)}`;
  return {commit,observation,code,log,reason,warnings,evidence:[...evidence]};
}
function hashEvidence(dir: string, evidence: string[]) {
  const report = join(dir,"result.json"), names = new Set(evidence);
  requireReport(names.size === evidence.length && names.has(report) && names.has(join(dir,"plan.json")),"证明证据清单不完整或有重复项");
  // 总结果本身不自哈希；其余文件均按首次归档的原始字节绑定。
  return Object.fromEntries(evidence.filter(file => file !== report).map(file => {
    const path = relative(dir,file);
    requireReport(evidenceFile(dir,path) === file,"证据不是本次尝试的原名文件："+path);
    return [path,digest(readFileSync(file))];
  }));
}
async function advance(t: Task, p: Proof, binding: Binding, root: string, signal: AbortSignal) {
  const attempt = randomUUID(), start = Date.now(), dir = join(root,attempt), report = join(dir,"result.json");
  const plan = attemptPlan(t,p,binding,attempt);
  planIn(dir,plan);
  const evidence = [report,join(dir,"plan.json")];
  let beforeRun: Awaited<ReturnType<typeof replay>> | undefined, afterRun: typeof beforeRun, reason: string | undefined;
  let materials: Omit<Pair["files"][number],"bytes">[] = [];
  try {
    const env = isolatedGit(), files = extract(t,p,binding.commit,env), pair = {t,p,binding,attempt,files,env,signal};
    materials = files.map(({bytes,...entry}) => entry);
    beforeRun = await replay(pair,p.before,join(dir,"before"));
    afterRun = await replay(pair,binding.commit,join(dir,"after"));
    evidence.push(...beforeRun.evidence,...afterRun.evidence);
    const actual = beforeRun.observation?.actual;
    const red = beforeRun.reason || (actual === p.beforeActual ? "" : actual === p.expected ? "旧版也通过，未抓住原问题" : `旧版实得不符合登记的原问题值 ${JSON.stringify(p.beforeActual)}`);
    const green = afterRun.reason || (afterRun.observation?.actual === p.expected ? "" : "修复版目标断言仍失败");
    reason = [red && "旧版："+red,green && "修复版："+green].filter(Boolean).join("\n");
  } catch (e) {
    requireReport(realpathSync(dir) === dir,"证明目录已改变："+dir);
    reason = "准备或执行证明："+errorText(e);
    const log = join(dir,"prepare.log");
    atomicWrite(log,reason+"\n");
    evidence.push(log);
  }
  const show = (v?: Observation) => v === undefined ? "未取得" : clip(JSON.stringify(v),240);
  const detail = [`问题单：${p.issue}；目标断言：${p.testName ?? `${p.scenario} / ${p.checkpoint}`}；预期：${show(p.expected)}`,
    `旧版 ${p.before} 实得：${show(beforeRun?.observation?.actual)}；修复版 ${binding.commit} 实得：${show(afterRun?.observation?.actual)}`,
    reason && "原因："+clip(reason.replaceAll("\n","；"),600)].filter(Boolean).join("\n");
  const result: Verdict = reason ? "未证明" : "已证明";
  const r = {...plan,...span(start),step,result,detail,evidence,report,materials,
    evidenceHashes:hashEvidence(dir,evidence),materialDigest:materials.length ? digest(JSON.stringify(materials)) : undefined,beforeRun,afterRun,reason} satisfies Check & Record<string,unknown>;
  writeJson(report,r);
  return r;
}
type Attempt = Awaited<ReturnType<typeof advance>>;
type Verdict = "已证明" | "未证明";
const proofVerdict = (value: unknown): value is Verdict => value === "已证明" || value === "未证明";
const objectRecord = (value: unknown): value is Record<string,unknown> => isObject(value);
function loadVerifiedAttempt(t: Task, dir: string, attempt: string): Attempt {
  requireReport(realpathSync.native(dir) === dir,"证明尝试目录已改变："+dir);
  const report = evidenceFile(dir,"result.json"), r = readJson<unknown>(report);
  requireReport(objectRecord(r) && r.executionId === t.executionId && r.attempt === attempt && r.report === report,"证明归档与执行或尝试不符");
  requireReport(r.step === step && proofVerdict(r.result),"证明归档的步骤或结论不合法");
  requireReport(typeof r.commit === "string" && fullSHA.test(r.commit) && typeof r.tree === "string" && fullSHA.test(r.tree),"证明归档缺少完整版本");
  requireReport(typeof r.promptHash === "string" && typeof r.acceptanceHash === "string" && (r.e2eHash === undefined || typeof r.e2eHash === "string") &&
    typeof r.detail === "string" && typeof r.startedAt === "string" && typeof r.endedAt === "string" &&
    typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0,"证明归档的检查字段不合法");
  const declaration = t.proofs?.find(p => JSON.stringify(p) === JSON.stringify(r.proof));
  requireReport(declaration && r.setup === t.config.setup && r.timeoutMin === t.limits.测试.timeoutMin,"证明归档与开工声明不符");
  requireReport(Array.isArray(r.evidence) && r.evidence.every(f => typeof f === "string") && objectRecord(r.evidenceHashes),"证明归档缺少证据摘要");
  const hashes = hashEvidence(dir,r.evidence);
  requireReport(Object.keys(hashes).length === Object.keys(r.evidenceHashes).length,"证明证据摘要清单不完整");
  for (const [path,sha256] of Object.entries(hashes)) requireReport(r.evidenceHashes[path] === sha256,"证明证据摘要不符："+path);
  const binding = {commit:r.commit,tree:r.tree,promptHash:r.promptHash,acceptanceHash:r.acceptanceHash,e2eHash:r.e2eHash};
  const recorded = readJson<unknown>(evidenceFile(dir,"plan.json"));
  requireReport(JSON.stringify(recorded) === JSON.stringify(attemptPlan(t,declaration,binding,attempt)),"总计划与证明归档的声明或版本不符");
  if (r.result === "已证明") {
    const red = declaration.scenario === undefined ? 76 : 1;
    for (const [side,run,commit,code,status,actual] of [
      ["before",r.beforeRun,declaration.before,red,"失败",declaration.beforeActual],
      ["after",r.afterRun,r.commit,0,"通过",declaration.expected],
    ] as const) {
      requireReport(objectRecord(run) && run.commit === commit && run.code === code && !run.reason,"已证明的尝试两端实得或结论不符："+side);
      for (const name of ["plan.json","result.json","test.log"]) {
        const path = side+"/"+name;
        requireReport(Object.hasOwn(hashes,path),"已证明的尝试缺少两端原始证据："+path);
      }
      const origEvidence = new Set<string>();
      const plan = replayPlan({t,p:declaration,attempt,binding},commit);
      const original = readObservation(join(dir,side),plan,declaration,{code,killed:false},origEvidence);
      requireReport(original.status === status && original.actual === actual && original.expected === declaration.expected &&
        isDeepStrictEqual(original,run.observation),"归档报告与本次目标断言或实得不符："+side);
      for (const file of origEvidence) requireReport(Object.hasOwn(hashes,relative(dir,file)),"归档报告引用了未绑定的证据："+relative(dir,file));
    }
  }
  return r as Attempt;
}
function publish(t: Task, r: Attempt) {
  const {attempt,result,commit,tree,promptHash,acceptanceHash,e2eHash,startedAt,endedAt,durationMs,detail,evidence,report} = r;
  requireReport(proofVerdict(result),"证明归档的结论不合法");
  withLock(join(t.dir,"status.lock"),() => {
    if (!checksOf(t.dir).some(c => c.step === step && c.attempt === attempt))
      recordStep(t.dir,{step,result,commit,tree,promptHash,acceptanceHash,e2eHash,startedAt,endedAt,durationMs,attempt,detail,evidence});
  });
  batchResult(t,["",`## ${endedAt} · ${step}`,`执行：${t.executionId}`,`结果：${result}`,detail,
    `证据：[本次记录](${report.split("/").map(encodeURIComponent).join("/")})`],`<!-- dev-loop-proof:${attempt} -->`);
}
export async function prove(t: Task) {
  const {dir,executionId} = t, proofs: (Attempt & {reused:boolean})[] = [];
  if (!t.proofs?.length) return {executionId,proofs};
  return underLock(join(dir,"proof.lock"),async () => {
    const binding = withLock(join(dir,"status.lock"),() => {
      const delivery = statusOf(dir).loop.delivery;
      if (!delivery) throw new InputError("尚未登记交付，不能运行证明");
      const {commit,tree} = delivery, c = checksOf(dir).findLast(row => row.step === "开发" && row.result === "已交付" && row.commit === commit && row.tree === tree);
      return {commit,tree,promptHash:c?.promptHash || "",acceptanceHash:c?.acceptanceHash || "",e2eHash:c?.e2eHash};
    });
    const root = join(dir,"proofs");
    mkdirSync(root,{recursive:true,mode:0o700});
    requireReport(realpathSync(root) === root,"证明目录越界："+root);
    const ignoredAttempts: {attempt:string; report:string; reason:string}[] = [];
    const readSaved = (attempt: string) => {
      const parent = join(root,attempt);
      try { return loadVerifiedAttempt(t,parent,attempt); }
      catch (error) { ignoredAttempts.push({attempt,report:join(parent,"result.json"),reason:errorText(error)}); }
    };
    const saved = readdirSync(root,{withFileTypes:true}).flatMap(e => {
      const r = e.isDirectory() ? readSaved(e.name) : undefined;
      if (!r) return [];
      publish(t,r);
      return [r];
    });
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once("SIGINT",cancel).once("SIGTERM",cancel);
    try {
      for (const p of t.proofs || []) {
        if (controller.signal.aborted) break;
        const matches = (r: Attempt) => r.result === "已证明" && r.commit === binding.commit && r.tree === binding.tree && JSON.stringify(r.proof) === JSON.stringify(p);
        const matching = saved.find(matches), current = matching && readSaved(matching.attempt);
        const old = current && matches(current) ? current : undefined;
        let r = old;
        if (!r) {
          const fresh = await advance(t,p,binding,root,controller.signal);
          r = loadVerifiedAttempt(t,dirname(fresh.report),fresh.attempt);
          publish(t,r);
        }
        proofs.push({...r,reused:Boolean(old)});
      }
      return {executionId,commit:binding.commit,proofs,...(ignoredAttempts.length ? {ignoredAttempts} : {})};
    } finally { process.off("SIGINT",cancel).off("SIGTERM",cancel); }
  }).catch(e => { throw e instanceof BusyError ? new InputError("本执行正在跑证明，请稍后重试") : e; });
}
