import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText, gitTry } from "./git.ts";
export async function checkout<T>(repo: string, commit: string, action: (cwd: string) => Promise<T>, warning: (text: string) => void = () => {}): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(),"dev-loop-deploy-")), cwd = join(tmp,"src");
  try { gitText(repo,["worktree","add","--detach",cwd,commit]); return await action(cwd); }
  finally {
    const removed = gitTry(repo,["worktree","remove","--force",cwd]);
    if (removed.code) warning("临时检出移除失败："+removed.stdout+removed.stderr);
    try { rmSync(tmp,{recursive:true,force:true}); } catch(e) { warning("临时目录删除失败："+String(e)); }
  }
}
