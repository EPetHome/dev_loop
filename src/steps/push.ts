import { basename } from "node:path";
import type { Entry, Ledger, Outcome } from "../core/store.ts";
import { requireGate } from "../core/inputs.ts";
import { run } from "../core/run.ts";
import { InputError } from "../core/card.ts";
import { git, gitText, gitTry, isAncestor } from "../infra/git.ts";
import { span } from "../infra/files.ts";
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
    const diff = (...args: string[]) => git(repo,["-c","core.quotePath=false","diff-tree","--root",...args,sha]), short = sha.slice(0,7);
    const patch = diff("-p","-U0","--no-renames","--no-ext-diff","--no-textconv"), added = diff("-r","--name-only","-z","--diff-filter=A","--no-commit-id");
    for (const file of added.split("\0")) {
      const name = basename(file); if (/^\.env(?:\.|$)/.test(name) && ![".env.example",".env.sample",".env.template"].includes(name)) hits.push(`${short} ${file}:1 .env 文件`);
    }
    let file = "", line = 0, hunk = false;
    for (const text of patch.split("\n")) {
      if (text.startsWith("diff --git ")) { hunk = false; file = ""; }
      else if (!hunk && text.startsWith("+++ ")) {
        const raw = text.slice(4), path: string = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/\t$/, "");
        file = path.startsWith("b/") ? path.slice(2) : "";
      } else if (/^@@ /.test(text)) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text); if (!match) throw new Error("无法解析补丁行号");
        line = Number(match[1]); hunk = true;
      } else if (hunk && text.startsWith("+")) {
        for (const [name, pattern] of RULES) if (pattern.test(text.slice(1))) hits.push(`${short} ${file}:${line} ${name}`);
        line++;
      } else if (hunk && text.startsWith(" ")) line++;
    }
  }
  return hits;
}
export interface PushResult { executionId: string; commit: string; result: string; seconds: number; detail: string; verify?: string }
export async function push(l:Ledger,j:Entry):Promise<Outcome> {
  const t=l.task, start=Date.now(), timeoutMs=t.config.pushTimeoutSec*1000;
  requireGate(l,j.sha!);
  if (gitTry(t.repo, ["remote", "get-url", "origin"]).code) throw new InputError("没有 origin");
  const commit = gitText(t.repo, ["rev-parse", "refs/heads/dev"]), short = commit.slice(0, 7);
  if (!isAncestor(t.repo,j.sha!,commit)) throw new InputError("交付提交未在本地 dev 上");
  const finish=(result:string,detail="",kind?:Outcome["kind"],verify?:string):Outcome=>{
    const timing=span(start), value={executionId:t.executionId,commit,result,seconds:timing.durationMs/1000,detail,...(verify ? {verify} : {})};
    return {result:kind ? "失败" : "成功",kind,text:detail,value,check:{step:"推送",result,commit,...timing,evidence:[],detail}} as Outcome;
  };
  const network=(args:string[],limit=timeoutMs)=>run({...t,worktree:t.repo},"git",args,limit);
  const auth=(s:string)=>/authentication failed|permission denied|access denied|403|401/i.test(s);
  const fetched = await network(["fetch", "--no-tags", "--prune", "--no-prune-tags", "--refmap=", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  if (fetched.code || fetched.killed) return finish("推送失败",fetched.output || "fetch 超时",auth(fetched.output) ? "环境" : "重试");
  if (gitTry(t.repo,["rev-parse","--verify","refs/remotes/origin/dev"]).stdout.trim()===commit) return finish("已推送","远端已是最新");
  let hits: string[];
  try { hits = scan(t.repo, gitText(t.repo, ["rev-list", "--reverse", commit, "--not", "--remotes=origin"]).split("\n").filter(Boolean)); }
  catch {return finish("扫描出错，未推送","密钥扫描出错（不输出补丁内容）","环境");}
  if (hits.length) return finish("扫描命中，未推送",hits.join("\n"),"环境");
  const sent = await network(["push", "--no-follow-tags", "origin", commit + ":refs/heads/dev"]);
  if (!sent.code && !sent.killed) return finish("已推送",sent.output);
  const verified=await network(["ls-remote","origin","refs/heads/dev"],Math.min(timeoutMs,t.config.pushVerifyTimeoutSec*1000));
  if (verified.code || verified.killed) return finish("推送结果不确定",sent.output+"\n"+verified.output,auth(sent.output) ? "环境" : "重试","git -C "+shellQuote(t.repo)+" ls-remote origin refs/heads/dev");
  if (verified.stdout.trim().split(/\s+/)[0]===commit) return finish("已推送",sent.output+"\n已核对远端");
  const temporary=sent.killed || /could not resolve|unable to access|connection|could not read from remote|network|timed out|remote end hung up/i.test(sent.output);
  return finish("推送失败",sent.output || "push 超时",temporary && !auth(sent.output) ? "重试" : "环境");
}
