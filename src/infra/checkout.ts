import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText, gitTry } from "./git.ts";
export function removeCheckout(repo: string, cwd: string, warning = console.error) {
  if (!existsSync(cwd)) return;
  const r = gitTry(repo,["worktree","remove","--force",cwd]); if (r.code) warning("临时检出移除失败："+r.stdout+r.stderr);
}
export function detachedCheckout(repo: string, commit: string, warning = console.error) {
  const tmp = mkdtempSync(join(tmpdir(),"dev-loop-check-")), cwd = join(tmp,"src");
  const remove = () => {
    removeCheckout(repo,cwd,warning);
    try { rmSync(tmp,{recursive:true,force:true}); } catch(e) { warning("临时目录删除失败："+String(e)); }
  };
  try { gitText(repo,["worktree","add","--detach",cwd,commit]); return {cwd, remove}; } catch (e) { remove(); throw e; }
}
export async function checkout<T>(repo: string, commit: string, run: (cwd: string) => Promise<T>, warning?: (text: string) => void) {
  const {cwd, remove} = detachedCheckout(repo, commit, warning);
  try { return await run(cwd); } finally { remove(); }
}
