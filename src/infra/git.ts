import { execFileSync } from "node:child_process";
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
}
export const gitText = (cwd: string, args: string[]) => git(cwd, args).trim();
export const repoRoot = (cwd: string) => gitText(cwd, ["rev-parse", "--show-toplevel"]);
export const head = (cwd: string) => gitText(cwd, ["rev-parse", "HEAD"]);
export const tree = (cwd: string, ref = "HEAD") => gitText(cwd, ["rev-parse", ref + "^{tree}"]);
const paths = (s: string) => s.split("\0").filter(Boolean);
export function changes(cwd: string): string[] {
  return [...new Set([...paths(git(cwd, ["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD", "--"])),
    ...paths(git(cwd, ["diff", "--no-renames", "--name-only", "-z", "--"])),
    ...paths(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))])];
}
export const changedSince = (cwd: string, base: string, ref = "HEAD") =>
  paths(git(cwd, ["diff", "--no-renames", "--name-only", "-z", base, ref, "--"]));
