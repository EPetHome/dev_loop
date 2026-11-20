import { execFileSync, spawnSync } from "node:child_process";
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
}
export function gitTry(cwd: string, args: string[], env?: NodeJS.ProcessEnv): {code: number; stdout: string; stderr: string} {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: {...process.env, GIT_LITERAL_PATHSPECS: "1", ...env}});
  return {code: r.status ?? 127, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? String(r.error) : "")};
}
export function worktreeOf(repo: string, branch: string): string | undefined {
  let path: string | undefined;
  for (const field of git(repo, ["worktree", "list", "--porcelain", "-z"]).split("\0")) {
    if (field.startsWith("worktree ")) path = field.slice(9);
    if (field === "branch refs/heads/" + branch) return path;
  }
}
export function isAncestor(repo: string, a: string, b: string): boolean {
  const r = gitTry(repo, ["merge-base", "--is-ancestor", a, b]);
  if (r.code > 1) throw new Error(r.stderr || r.stdout);
  return r.code === 0;
}
export const gitText = (cwd: string, args: string[]) => git(cwd, args).trim();
export const repoRoot = (cwd: string) => gitText(cwd, ["rev-parse", "--show-toplevel"]);
export const head = (cwd: string) => gitText(cwd, ["rev-parse", "HEAD"]);
export const tree = (cwd: string, ref = "HEAD") => gitText(cwd, ["rev-parse", ref + "^{tree}"]);
const paths = (s: string) => s.split("\0").filter(Boolean);
// 状态两列分别检查索引和工作区；不让工作区恢复原样掩盖已暂存的改动。
export const changes = (cwd: string) =>
  paths(git(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"])).map(line => line.slice(3));
export const changedSince = (cwd: string, base: string, ref = "HEAD") =>
  paths(git(cwd, ["diff", "--no-renames", "--name-only", "-z", base, ref, "--"]));
