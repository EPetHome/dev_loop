import { mkdtempSync, mkdirSync, existsSync, accessSync, constants, lstatSync, realpathSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { taskOf, annotate, recordStep, LoopError } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { loadDeploy, inside } from "../infra/config.ts";
import { gitText, gitTry, isAncestor } from "../infra/git.ts";
import { childExec } from "../infra/exec.ts";
export interface DeployResult {
  executionId: string; commit: string; onDev: boolean; result: string;
  steps: {name: string; path: string; code: number; seconds: number; killed: boolean}[];
  log: string; evidenceDir: string; seconds: number;
}
export async function deploy(dir: string, o: {commit?: string; timeoutMs?: number} = {}): Promise<DeployResult> {
  const t = taskOf(dir), start = Date.now(); let cfg;
  try { cfg = loadDeploy(t.repo); } catch (e) { throw new InputError(e instanceof Error ? e.message : String(e)); }
  if (!cfg) throw new InputError("项目没有登记部署脚本（.autoreview.json 的 deploy.cmd）");
  const parsed = gitTry(t.repo, ["rev-parse", "--verify", "--end-of-options", (o.commit || "refs/heads/dev") + "^{commit}"]);
  if (parsed.code) throw new InputError("无法确定部署 commit：" + parsed.stderr);
  const commit = parsed.stdout.trim(), short = commit.slice(0, 7), onDev = isAncestor(t.repo, commit, "refs/heads/dev");
  const tmp = mkdtempSync(join(tmpdir(), "dev-loop-deploy-")), cwd = join(tmp, "src");
  const steps: DeployResult["steps"] = []; let log = "", evidenceDir = "", failed = "", rollbackOK = false;
  try {
    gitText(t.repo, ["worktree", "add", "--detach", cwd, commit]);
    for (const path of [cfg.cmd, cfg.check, cfg.rollback].filter((s): s is string => s !== undefined)) {
      try {
        const file = resolve(cwd, path);
        if (!lstatSync(file).isFile() || !inside(realpathSync(cwd), realpathSync(file))) throw new Error("非仓库内普通文件");
        accessSync(file, constants.X_OK);
      } catch { throw new InputError("脚本不存在或不可执行：" + path); }
    }
    const now = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    const stamp = now.getFullYear() + [now.getMonth() + 1, now.getDate()].map(pad).join("") + "-" + [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join("");
    const base = join(dir, "deploy-" + short + "-" + stamp); let stem = base;
    for (let n = 1; existsSync(stem) || existsSync(stem + ".log"); n++) stem = base + "-" + n;
    evidenceDir = stem; log = stem + ".log"; mkdirSync(evidenceDir);
    annotate(dir, "部署中", short);
    const env = {LOOP_DEPLOY_COMMIT: commit, LOOP_REPO: t.repo, LOOP_EVIDENCE_DIR: evidenceDir};
    const run = async (name: string, path: string) => {
      const began = Date.now(); appendFileSync(log, "$ " + path + "\n");
      const r = await childExec(resolve(cwd, path), [], {cwd, timeoutMs: o.timeoutMs ?? cfg.timeoutMin * 60000,
        env: {...env, LOOP_DEPLOY_FAILED: failed || undefined}});
      steps.push({name, path, code: r.code, seconds: (Date.now() - began) / 1000, killed: r.killed});
      appendFileSync(log, r.output + "\n退出码 " + r.code + "，用时 " + steps.at(-1)!.seconds + " 秒" + (r.killed ? "，超时" : "") + "\n");
      return r.code === 0 && !r.killed;
    };
    if (!await run("cmd", cfg.cmd)) failed = "cmd";
    else if (cfg.check && !await run("check", cfg.check)) failed = "check";
    if (failed && cfg.rollback) rollbackOK = await run("rollback", cfg.rollback);
  } finally {
    const removed = gitTry(t.repo, ["worktree", "remove", "--force", cwd]);
    if (removed.code && log) appendFileSync(log, "临时检出移除失败：" + removed.stdout + removed.stderr + "\n");
    try { rmSync(tmp, {recursive: true, force: true}); }
    catch (e) { if (log) appendFileSync(log, "临时目录删除失败：" + String(e) + "\n"); }
  }
  const message = failed ? cfg.rollback ? rollbackOK ? "已回退" : "回退也失败" : "未回退" : short + (cfg.check ? "" : "，未检查");
  const result = failed ? "部署失败，" + message : cfg.check ? "已部署" : "已部署（未检查）", ended = Date.now();
  const r = {executionId: t.executionId, commit, onDev, result, steps, log, evidenceDir, seconds: (ended - start) / 1000};
  const detail = readFileSync(log, "utf8").trimEnd().split(/\r?\n/).slice(-40).join("\n");
  recordStep(dir, {step: "部署", result, commit, startedAt: new Date(start).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: ended - start,
    evidence: [log, evidenceDir], detail}, {phase: failed ? "部署失败" : "已部署", message});
  if (failed) throw new LoopError("未知", detail, r);
  return r;
}
