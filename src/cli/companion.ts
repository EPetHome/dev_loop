import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkout } from "../infra/checkout.ts";
import { loadSnapshot } from "../infra/config.ts";
import { lock, BusyError, span } from "../infra/files.ts";
import { taskOf, recordStep } from "../core/store.ts";
import { copyLocalFiles } from "../core/lifecycle.ts";
import { projectCommand } from "../core/run.ts";
import { snapshot, staticSnapshot } from "../core/snapshot.ts";
export async function companion(dir: string) {
  const t=taskOf(dir); if (t.e2e) return; // 接入卡只在复测采场景，线上留痕不变。
  const start=Date.now(), out=join(dir,"snapshot-base.json"); let release: (()=>void) | undefined;
  const record=(result: string, detail="")=>recordStep(dir,{step:"陪跑",result,commit:t.baseCommit,...span(start),evidence:result==="基线已存"?[out]:[],detail});
  try {
    try { release=lock(join(dir,"companion.lock")); } catch(e) { if(e instanceof BusyError)return; throw e; }
    const script=loadSnapshot(t.repo); if (!script) { record("跳过","未登记 snapshot"); return; }
    await checkout(t.repo,t.baseCommit,async cwd=>{
      copyLocalFiles(t,cwd);
      if(!existsSync(resolve(cwd,script))) { record("跳过","起点没有 snapshot 脚本"); return; }
      await projectCommand({...t,worktree:cwd},"setup",undefined,{isolated:{LOOP_TASK_DIR:dir,TMPDIR:cwd}});
      staticSnapshot(t,cwd,t.baseCommit,join(dir,"snapshot-base-static.json"));
      record(await snapshot(t,cwd,t.baseCommit,out,"scenario")?"基线已存":"失败");
    }, warning=>record("失败",warning));
  } catch(e) { record("失败",String(e)); } finally { release?.(); }
}
