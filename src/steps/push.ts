import { basename } from "node:path";
import { taskOf, annotate, recordStep, LoopError, type Phase } from "../core/store.ts";
import { InputError } from "../core/card.ts";
import { git, gitText, gitTry } from "../infra/git.ts";
import { childExec } from "../infra/exec.ts";
import { shellQuote } from "../infra/paths.ts";
const RULES: [string, RegExp][] = [
  ["私钥", /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/],
  ["AWS 访问密钥", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub 令牌", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ["sk- 类 API 密钥", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["Slack 令牌", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Google API 密钥", /\bAIza[0-9A-Za-z_-]{35}\b/],
];
/** 只返回位置与规则名；即使 git 报错也绝不泄漏补丁内容。 */
export function scan(repo: string, commits: string[]): string[] {
  const hits: string[] = [];
  for (const sha of commits) {
    const patch = git(repo, ["-c", "core.quotePath=false", "diff-tree", "-p", "-U0", "--no-renames", "--no-ext-diff", "--no-textconv", "--root", sha]);
    const added = git(repo, ["-c", "core.quotePath=false", "diff-tree", "-r", "--name-only", "-z", "--diff-filter=A", "--no-commit-id", "--root", sha]);
    for (const file of added.split("\0").filter(Boolean)) {
      const name = basename(file);
      if (/^\.env(?:\.|$)/.test(name) && ![".env.example", ".env.sample", ".env.template"].includes(name)) hits.push(sha.slice(0, 7) + " " + file + ":1 .env 文件");
    }
    let file = "", line = 0, hunk = false;
    for (const text of patch.split("\n")) {
      if (text.startsWith("diff --git ")) { hunk = false; file = ""; }
      else if (!hunk && text.startsWith("+++ ")) {
        const raw = text.slice(4), path: string = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/\t$/, "");
        file = path.startsWith("b/") ? path.slice(2) : "";
      } else if (/^@@ /.test(text)) {
        const match = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!match) throw new Error("无法解析补丁行号");
        line = Number(match[1]); hunk = true;
      } else if (hunk && text.startsWith("+")) {
        for (const [name, pattern] of RULES) if (pattern.test(text.slice(1))) hits.push(sha.slice(0, 7) + " " + file + ":" + line + " " + name);
        line++;
      } else if (hunk && text.startsWith(" ")) line++;
    }
  }
  return hits;
}
export interface PushResult { executionId: string; commit: string; result: string; seconds: number; detail: string; verify?: string }
export async function push(dir: string, o: {timeoutMs?: number} = {}): Promise<PushResult> {
  const t = taskOf(dir), start = Date.now(), timeoutMs = o.timeoutMs ?? 120000;
  if (gitTry(t.repo, ["remote", "get-url", "origin"]).code) throw new InputError("没有 origin");
  const commit = gitText(t.repo, ["rev-parse", "refs/heads/dev"]), short = commit.slice(0, 7);
  annotate(dir, "推送中", short);
  const finish = (result: string, phase: Phase, message: string, detail = "", category?: string, verify?: string): PushResult => {
    const ended = Date.now(), r = {executionId: t.executionId, commit, result, seconds: (ended - start) / 1000, detail, ...(verify ? {verify} : {})};
    recordStep(dir, {step: "推送", result, commit, startedAt: new Date(start).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: ended - start, evidence: [], detail}, {phase, message});
    if (category) throw new LoopError(category, detail || message, r);
    return r;
  };
  const network = (args: string[], limit = timeoutMs) => childExec("git", args, {cwd: t.repo, timeoutMs: limit});
  const fetched = await network(["fetch", "--no-tags", "--prune", "origin"]);
  if (fetched.code || fetched.killed) return finish("推送失败", "推送失败", "网络失败", fetched.output || "fetch 超时", "临时故障");
  if (gitTry(t.repo, ["rev-parse", "--verify", "refs/remotes/origin/dev"]).stdout.trim() === commit) return finish("已推送", "已推送", short, "远端已是最新");
  let hits: string[];
  try { hits = scan(t.repo, gitText(t.repo, ["rev-list", "--reverse", commit, "--not", "--remotes=origin"]).split("\n").filter(Boolean)); }
  catch { return finish("扫描出错，未推送", "推送失败", "扫描出错", "密钥扫描出错，未推送（不输出补丁内容）", "工具内部错误"); }
  if (hits.length) return finish("扫描命中，未推送", "推送失败", "扫描命中 " + hits.length + " 处", hits.join("\n"), "输入问题");
  const sent = await network(["push", "--no-follow-tags", "origin", commit + ":refs/heads/dev"]);
  if (!sent.code && !sent.killed) return finish("已推送", "已推送", short, sent.output);
  const verified = await network(["ls-remote", "origin", "refs/heads/dev"], Math.min(timeoutMs, 30000));
  if (verified.code || verified.killed) return finish("推送结果不确定", "推送结果不确定", "用 git ls-remote origin refs/heads/dev 核对", sent.output + "\n" + verified.output, "未知", "git -C " + shellQuote(t.repo) + " ls-remote origin refs/heads/dev");
  if (verified.stdout.trim().split(/\s+/)[0] === commit) return finish("已推送", "已推送", short, sent.output + "\n已核对远端");
  const temporary = sent.killed || /could not resolve|unable to access|connection|could not read from remote|network|timed out|remote end hung up/i.test(sent.output);
  return finish("推送失败", "推送失败", temporary ? "网络失败" : "远端拒绝", sent.output || "push 超时", temporary ? "临时故障" : "权限不足");
}
