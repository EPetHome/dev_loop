import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const optionsFor = (cwd: string, env?: NodeJS.ProcessEnv) => ({cwd, encoding:"utf8" as const, maxBuffer:32*1024*1024, env:{...process.env,GIT_LITERAL_PATHSPECS:"1",...env}});
export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => execFileSync("git",args,{...optionsFor(cwd,env),stdio:["ignore","pipe","pipe"]});
export function gitTry(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const {status,stdout,stderr,error} = spawnSync("git",args,optionsFor(cwd,env));
  return {code:status ?? 127,stdout:stdout || "",stderr:(stderr || "")+(error ? String(error) : "")};
}
export const worktreeOf = (repo: string, branch: string) => git(repo,["worktree","list","--porcelain","-z"]).split("\0\0")
  .find(entry=>entry.split("\0").includes("branch refs/heads/"+branch))?.split("\0")[0].slice(9);
export function isAncestor(repo: string, a: string, b: string): boolean {
  const {code,stderr,stdout} = gitTry(repo,["merge-base","--is-ancestor",a,b]);
  if (code > 1) throw new Error(stderr || stdout); return code === 0;
}
export const gitText = (cwd: string, args: string[]) => git(cwd, args).trim();
export const repoRoot = (cwd: string) => gitText(cwd, ["rev-parse", "--show-toplevel"]);
export const head = (cwd: string) => gitText(cwd, ["rev-parse", "HEAD"]);
export const tree = (cwd: string, ref = "HEAD") => gitText(cwd, ["rev-parse", ref + "^{tree}"]);
const paths = (s: string) => s.split("\0").filter(Boolean);
const status = (cwd: string, options: string[] = [], env?: NodeJS.ProcessEnv) => paths(git(cwd, ["--no-optional-locks", ...options, "status", "--porcelain=v1", "-z", "--no-renames", env ? "--untracked-files=no" : "--untracked-files=all"], env));
export const changes = (cwd: string, unstagedOnly = false) => [...new Set(status(cwd).filter(s => !unstagedOnly || s[1] !== " ").map(line => line.slice(3)))];
export const changedSince = (cwd: string, base: string, ref = "HEAD") => paths(git(cwd, ["diff", "--no-renames", "--name-only", "-z", base, ref, "--"]));
export function releaseChanges(cwd: string): string[] {
  const options = ["-c", "core.fsmonitor=false"], dirty = new Set(status(cwd, options).map(line => line.slice(3)));
  const marked = paths(git(cwd,[...options,"ls-files","-v","-z"])).filter(line=>/^[a-zS] /.test(line)); if (!marked.length) return [...dirty];
  options.push("-c","core.splitIndex=false","-c","core.ignoreStat=false");
  const full = [...options,"-c","core.sparseCheckout=false"], scratch = mkdtempSync(join(tmpdir(),"loop-release-index-")), env = {GIT_INDEX_FILE:join(scratch,"index")};
  try {
    git(cwd, [...full, "read-tree", "HEAD"], env);
    const lines = status(cwd, full, env), skipped = new Set(marked.filter(line=>/^[Ss] /.test(line)).map(line=>line.slice(2)));
    // 只操作临时索引：Git rm --cached 留下规则之外的条目，包括非 cone 规则。
    if (lines.some(line=>line.startsWith(" D ") && skipped.has(line.slice(3)))) git(cwd,[...options,"rm","--cached","-frq","--ignore-unmatch","--","."],env); else skipped.clear();
    const omitted = skipped.size ? new Set(paths(git(cwd,[...options,"ls-files","-z"],env))) : undefined;
    for (const line of lines) if (!(line.startsWith(" D ") && skipped.has(line.slice(3)) && omitted?.has(line.slice(3)))) dirty.add(line.slice(3));
  } finally { rmSync(scratch, {recursive:true,force:true}); } return [...dirty];
}
