import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const optionsFor = (cwd: string, env?: NodeJS.ProcessEnv) => ({
  cwd, encoding:"utf8" as const, maxBuffer:32*1024*1024, env:{...process.env,GIT_LITERAL_PATHSPECS:"1",...env}
});
export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => execFileSync("git",args,{...optionsFor(cwd,env),stdio:["ignore","pipe","pipe"]});
export const gitBytes = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git",args,{...optionsFor(cwd,env),encoding:"buffer",stdio:["ignore","pipe","pipe"]});
// 固定读取本仓库对象，不让调用者的 index、替换引用或其他仓库环境改变历史。
export const historyEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith("GIT_")).map(k => [k,undefined])),
  GIT_LITERAL_PATHSPECS:"1", GIT_NO_REPLACE_OBJECTS:"1", GIT_NO_LAZY_FETCH:"1", GIT_TERMINAL_PROMPT:"0",
  GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:"/dev/null", GIT_ALLOW_PROTOCOL:"", // 旧 Git 也不从 promisor remote 拉取缺失对象。
});
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
export const gitText = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => git(cwd,args,env).trim();
export const repoRoot = (cwd: string) => gitText(cwd, ["rev-parse", "--show-toplevel"]);
export const head = (cwd: string, env?: NodeJS.ProcessEnv) => gitText(cwd,["rev-parse","HEAD"],env);
export const commitOf = (repo: string, ref: string, env?: NodeJS.ProcessEnv) => gitText(repo,["rev-parse","--verify","--end-of-options",ref+"^{commit}"],env);
export const tree = (cwd: string, ref = "HEAD") => gitText(cwd, ["rev-parse", ref + "^{tree}"]);
/** 只读历史树中的普通文件，不从工作区、符号链接或子模块取内容。 */
export function historicalFile(repo: string, commit: string, path: string, env = historyEnv()): string | undefined {
  const entry = git(repo,["ls-tree","--full-tree","-z",commit,"--",path],env);
  const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry);
  if (blob && entry.slice(blob[0].length) === path+"\0") return git(repo,["cat-file","blob",blob[1]],env);
}
const paths = (s: string) => s.split("\0").filter(Boolean);
const status = (cwd: string, options: string[] = [], env?: NodeJS.ProcessEnv, trackedOnly = Boolean(env)) => paths(git(cwd,
  ["--no-optional-locks",...options,"status","--porcelain=v1","-z","--no-renames",trackedOnly ? "--untracked-files=no" : "--untracked-files=all"],env));
export function checkPin(cwd: string, commit: string, allowed: string[] = [], env?: NodeJS.ProcessEnv) {
  if (realpathSync.native(cwd) !== cwd || head(cwd,env) !== commit) throw new Error("隔离检出偏离登记提交："+commit);
  const dirty = status(cwd,["-c","core.fsmonitor=false"],env,true).map(line => line.slice(3)).filter(p => !allowed.includes(p));
  if (dirty.length) throw new Error("隔离检出修改了未获准的跟踪文件："+dirty.join("、"));
}
export const changes = (cwd: string, unstagedOnly = false) => [...new Set(status(cwd).filter(s => !unstagedOnly || s[1] !== " ").map(line => line.slice(3)))];
export const changedSince = (cwd: string, base: string, ref = "HEAD") => paths(git(cwd, ["diff", "--no-renames", "--name-only", "-z", base, ref, "--"]));
export function releaseChanges(cwd: string): string[] {
  const options = ["-c", "core.fsmonitor=false"], dirty = new Set(status(cwd, options).map(line => line.slice(3)));
  const marked = paths(git(cwd,[...options,"ls-files","-v","-z"])).filter(line=>/^[a-zS] /.test(line)); if (!marked.length) return [...dirty];
  options.push("-c","core.splitIndex=false","-c","core.ignoreStat=false");
  const full = [...options,"-c","core.sparseCheckout=false"], scratch = mkdtempSync(join(tmpdir(),"loop-release-index-")),
    env = {GIT_INDEX_FILE:join(scratch,"index")};
  try {
    git(cwd, [...full, "read-tree", "HEAD"], env);
    const lines = status(cwd, full, env), skipped = new Set(marked.filter(line=>/^[Ss] /.test(line)).map(line=>line.slice(2)));
    // 只操作临时索引：Git rm --cached 留下规则之外的条目，包括非 cone 规则。
    if (lines.some(line=>line.startsWith(" D ") && skipped.has(line.slice(3))))
      git(cwd,[...options,"rm","--cached","-frq","--ignore-unmatch","--","."],env);
    else skipped.clear();
    const omitted = skipped.size ? new Set(paths(git(cwd,[...options,"ls-files","-z"],env))) : undefined;
    for (const line of lines) if (!(line.startsWith(" D ") && skipped.has(line.slice(3)) && omitted?.has(line.slice(3)))) dirty.add(line.slice(3));
  } finally { rmSync(scratch, {recursive:true,force:true}); } return [...dirty];
}
