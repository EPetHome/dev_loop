import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { checkout } from "../infra/checkout.ts";
import { inside, safeRelative } from "../infra/config.ts";
import { atomicWrite, BusyError, digest, errorText, ifPresent, maybe, readJson, span, underLock, withLock, writeJson } from "../infra/files.ts";
import { checkPin, git, gitBytes, gitTry, historyEnv } from "../infra/git.ts";
import { InputError, observed, type Observation } from "../core/card.ts";
import { boundReport, e2eResult, evidenceFile, planIn, requireReport, type Measurement } from "../core/e2e.ts";
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
function isolatedGit(repo: string) {
  const env = historyEnv(), fixed = new Map(Object.entries({"core.hooksPath":"/dev/null","core.fsmonitor":"false","core.ignoreStat":"false",
    "core.sparseCheckout":"false","core.symlinks":"true","submodule.recurse":"false"}));
  const keys = gitTry(repo,["config","--null","--name-only","--get-regexp","^filter\\..*\\.(clean|smudge|process|required)$"],env);
  requireReport(keys.code <= 1,keys.stderr || keys.stdout);
  for (const key of keys.stdout.split("\0").filter(Boolean)) fixed.set(key,key.endsWith(".required") ? "false" : "");
  return Object.assign(env,{GIT_CONFIG_COUNT:String(fixed.size)},...[...fixed].map(([k,v],i) => ({[`GIT_CONFIG_KEY_${i}`]:k,[`GIT_CONFIG_VALUE_${i}`]:v})));
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
function mount(cwd: string, commit: string, {env,p,files}: Pair) {
  for (const {path,mode} of treeFiles(cwd,commit,env)) {
    if (mode === "160000" && p.testFiles.some(name => name === path || name.startsWith(path+"/"))) throw new Error("测试材料不能覆盖子模块："+path);
    if (mode !== "120000") continue;
    const link = join(cwd,path), target = resolve(dirname(link),readlinkSync(link));
    requireReport(inside(cwd,target) && inside(cwd,ifPresent(() => realpathSync(link)) || target),"临时检出中的链接越出本版本："+path);
  }
  for (const f of files) {
    const name = join(cwd,f.path), parent = dirname(name), stat = lstatSync(name,{throwIfNoEntry:false});
    mkdirSync(parent,{recursive:true});
    requireReport(realpathSync.native(parent) === parent && (!stat || evidenceFile(cwd,f.path) === name && realpathSync.native(name) === name),"测试材料路径非原名普通文件："+f.path);
    atomicWrite(name,f.bytes);
    chmodSync(name,f.mode === "100755" ? 0o755 : 0o644);
  }
  return () => {
    checkPin(cwd,commit,p.testFiles,env);
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
async function replay(pair: Pair, commit: string, dir: string) {
  const {t,p,attempt,binding,env,signal} = pair, ids = {executionId:t.executionId,attempt,commit}, {expected} = p;
  const plan = p.scenario === undefined ? {...ids,testName:p.testName,expected}
    : {...binding,...ids,scenarios:[{id:p.scenario,checks:[{id:p.checkpoint,expected}]}]};
  planIn(dir,plan);
  const scene = "scenarios" in plan, evidence = new Set([join(dir,"plan.json")]), warnings: string[] = [];
  const deadline = Date.now()+t.limits.测试.timeoutMin*60000;
  let observation: Target | undefined, code: number | undefined, reason: string | undefined;
  try {
    requireReport(!signal.aborted,"证明已中断，未执行本端");
    await checkout(t.repo,commit,async path => {
      const cwd = realpathSync(path), verify = mount(cwd,commit,pair);
      const work = {...t,worktree:cwd}, opts = {deadline,signal,isolated:sandbox(cwd,pair),sealed:true};
      verify();
      await projectCommand(work,"setup",join(dir,"setup.log"),opts);
      verify();
      const run = await projectCommand(work,"test",join(dir,"test.log"),{...opts,command:p.test,planEnv:{[scene ? "LOOP_E2E_DIR" : "LOOP_PROOF_DIR"]:dir}});
      requireReport(run,"证明命令没有执行");
      code = run.code;
      verify();
      if (scene) {
        const result = e2eResult({dir,plan},p.test,run,o => { observation = {...o,expected}; });
        for (const f of result.evidence) evidence.add(f);
        requireReport(observation,result.detail);
      } else {
        const {actual,status,testName,expected:want} = boundReport<Target & {testName:string}>(dir,plan,evidence);
        requireReport(testName === p.testName && observed(actual) && observed(want),"未命中定向测试名或缺少有效预期/实得："+p.testName);
        observation = {actual,status,expected:want};
      }
      const pass = observation.actual === expected, red = scene ? 1 : 76;
      requireReport(!run.killed && observation.expected === expected && observation.status === (pass ? "通过" : "失败") && run.code === (pass ? 0 : red),"目标断言的预期、实得、状态或命令退出码不一致");
    },warning => warnings.push(warning),env);
  } catch (e) { reason = errorText(e); }
  requireReport(realpathSync(dir) === dir,"证明证据目录已改变："+dir);
  const log = ["test.log","setup.log"].map(f => join(dir,f)).find(existsSync) || join(dir,"error.log");
  if (reason && !existsSync(log)) atomicWrite(log,reason+"\n");
  for (const name of ["setup.log",relative(dir,log)]) if (existsSync(join(dir,name))) evidence.add(evidenceFile(dir,name));
  if (reason && code !== undefined) reason += `（退出码 ${code}）\n${clip(readFileSync(log,"utf8").trimEnd(),2048,true)}`;
  return {commit,observation,code,log,reason,warnings,evidence:[...evidence]};
}
async function advance(t: Task, p: Proof, binding: Binding, root: string, signal: AbortSignal) {
  const attempt = randomUUID(), start = Date.now(), dir = join(root,attempt), report = join(dir,"result.json");
  const plan = {executionId:t.executionId,attempt,proof:p,setup:t.config.setup,timeoutMin:t.limits.测试.timeoutMin,...binding};
  planIn(dir,plan);
  const evidence = [report,join(dir,"plan.json")];
  let beforeRun: Awaited<ReturnType<typeof replay>> | undefined, afterRun: typeof beforeRun, reason: string | undefined;
  let materials: Omit<Pair["files"][number],"bytes">[] = [];
  try {
    const env = isolatedGit(t.repo), files = extract(t,p,binding.commit,env), pair = {t,p,binding,attempt,files,env,signal};
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
  const r = {...plan,...span(start),step,result:reason ? "未证明" : "已证明",detail,evidence,report,materials,
    materialDigest:materials.length ? digest(JSON.stringify(materials)) : undefined,beforeRun,afterRun,reason} satisfies Check & Record<string,unknown>;
  writeJson(report,r);
  return r;
}
type Attempt = Awaited<ReturnType<typeof advance>>;
function publish(t: Task, r: Attempt) {
  const {proof,executionId,setup,timeoutMin,materialDigest,materials,beforeRun,afterRun,reason,report,...fact} = r;
  withLock(join(t.dir,"status.lock"),() => {
    if (!checksOf(t.dir).some(c => c.step === step && c.attempt === r.attempt)) recordStep(t.dir,fact);
  });
  batchResult(t,["",`## ${r.endedAt} · ${step}`,`执行：${executionId}`,`结果：${r.result}`,r.detail,
    `证据：[本次记录](${report.split("/").map(encodeURIComponent).join("/")})`],`<!-- dev-loop-proof:${r.attempt} -->`);
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
    const saved = readdirSync(root,{withFileTypes:true}).flatMap(e => {
      if (!e.isDirectory()) return [];
      const parent = join(root,e.name), file = join(parent,"result.json");
      if (!lstatSync(file,{throwIfNoEntry:false})?.isFile()) return [];
      const r = readJson<Attempt>(evidenceFile(parent,"result.json"));
      if (r.executionId !== executionId || r.attempt !== e.name || r.report !== file) return [];
      publish(t,r);
      return [r];
    });
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once("SIGINT",cancel).once("SIGTERM",cancel);
    try {
      for (const p of t.proofs || []) {
        if (controller.signal.aborted) break;
        const old = saved.find(r => r.result === "已证明" && r.commit === binding.commit && r.tree === binding.tree && JSON.stringify(r.proof) === JSON.stringify(p) &&
          r.setup === t.config.setup && r.timeoutMin === t.limits.测试.timeoutMin && maybe(() => r.evidence.every(f => evidenceFile(dirname(r.report),relative(dirname(r.report),f)) === f)));
        const r = old || await advance(t,p,binding,root,controller.signal);
        if (!old) publish(t,r);
        proofs.push({...r,reused:Boolean(old)});
      }
      return {executionId,commit:binding.commit,proofs};
    } finally { process.off("SIGINT",cancel).off("SIGTERM",cancel); }
  }).catch(e => { throw e instanceof BusyError ? new InputError("本执行正在跑证明，请稍后重试") : e; });
}
