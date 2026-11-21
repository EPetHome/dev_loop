import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, write, NODE } from "./helpers.ts";
import { registerSession } from "../src/core/lifecycle.ts";
import { deliver } from "../src/core/deliver.ts";
export const flow = ["开发评审", "测试", "合入", "部署", "推送"];
export async function finishingFixture(t: Parameters<typeof fixture>[0], o: {flow?: string[]; cmd?: string; check?: string; rollback?: string} = {}) {
  const f = fixture(t,{card:{flow:o.flow || flow.slice(0,4)},config:{deploy:{cmd:"deploy.cjs",check:"check.cjs",rollback:"rollback.cjs"}}});
  f.raw.tasks[0].scope = ["src/**","check.cjs"]; write(f.card,JSON.stringify(f.raw));
  for (const name of ["deploy","check","rollback"] as const) {
    const body = name === "deploy" ? o.cmd : o[name];
    write(join(f.repo,name+".cjs"), "#!"+NODE+"\nconst fs=require('fs'),path=require('path'),cp=require('child_process'),e=process.env,evidence=e.LOOP_EVIDENCE_DIR,dir=path.dirname(evidence);\nfs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({name:"+JSON.stringify(name)+",commit:e.LOOP_DEPLOY_COMMIT,dev:cp.execFileSync('git',['rev-parse','dev'],{cwd:e.LOOP_REPO,encoding:'utf8'}).trim(),status:JSON.parse(fs.readFileSync(dir+'/status.json')),evidence})+'\\n');\n"+(body || "")+"\n");
    chmodSync(join(f.repo,name+".cjs"),0o755);
  }
  f.git("add","."); f.git("commit","-m","deploy substitutes");
  const task = await f.prepare(), before = f.git("rev-parse","dev"); registerSession(task.dir,"pi","fake",process.pid);
  write(join(task.worktree,"src/app.txt"),"good finish\n"); const {commit} = deliver(task.dir);
  return {...f,task,before,commit};
}
export const received = (dir: string) => readFileSync(join(dir,"calls.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
