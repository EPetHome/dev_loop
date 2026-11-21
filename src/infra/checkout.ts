import { constants, cpSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeRelative } from "./config.ts";
import { gitText, gitTry } from "./git.ts";
export function removeCheckout(repo: string, cwd: string, warning = console.error) {
  const r = existsSync(cwd) && gitTry(repo,["worktree","remove","--force",cwd]);
  if (r && r.code) warning("临时检出移除失败："+r.stdout+r.stderr);
}
function removeScratch(repo: string, root: string, warning = console.error) {
  removeCheckout(repo,join(root,"src"),warning);
  try { rmSync(root,{recursive:true,force:true}); } catch(e) { warning("临时目录删除失败："+String(e)); }
}
export async function checkout<T>(repo: string, commit: string, run: (cwd: string) => Promise<T>, warning?: (text: string) => void) {
  const root = mkdtempSync(join(tmpdir(),"dev-loop-check-")), cwd = join(root,"src");
  try { gitText(repo,["worktree","add","--detach",cwd,commit]); return await run(cwd); }
  finally { removeScratch(repo,root,warning); }
}
function copySnapshot(repo: string, dest: string, commit: string, source: string) {
  source = realpathSync(source);
  gitText(repo,["worktree","add","--detach","--no-checkout",dest,commit]); gitText(dest,["read-tree",commit]);
  cpSync(source,dest,{recursive:true,mode:constants.COPYFILE_FICLONE,filter(from,to) {
    if (basename(from).toLowerCase() === ".git") return false;
    if (!lstatSync(from).isSymbolicLink()) return true;
    const path = relative(source,realpathSync(from));
    if (!safeRelative(path.toLowerCase() || ".")) throw new Error("留痕链接越出副本范围：" + relative(source,from));
    symlinkSync(relative(dirname(to),join(dest,path)) || ".",to); return false;
  }});
}
export const checkoutWorker = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === checkoutWorker) {
  const [mode, repo, root, commit, source] = process.argv.slice(2);
  if (mode === "--snapshot-copy") copySnapshot(repo,join(root,"src"),commit,source); else if (mode === "--snapshot-clean") removeScratch(repo,root);
}
