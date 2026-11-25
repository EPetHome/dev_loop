import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { checkout } from "../infra/checkout.ts";
import { snapshot, differences } from "../core/snapshot.ts";
import { Ledger } from "../core/store.ts";
import { defaults } from "../infra/config.ts";
import { entrypoint, tasksRoot } from "../infra/paths.ts";
import { atomicWrite } from "../infra/files.ts";
import { InputError } from "../core/card.ts";
export async function comparison(dir:string,other?:string) {
  const l=new Ledger(dir), deployment=(d:Ledger)=>d.rows.findLast(r=>r.type==="部署" && r.result==="成功"), a=deployment(l), b=other && deployment(new Ledger(other)), report=join(dir,`comparison-${Date.now()}.md`);
  let diff="没有基线"; if (a && (!other || b)) {
    const current=b ? join(b.value.evidenceDir,"snapshot-after.json") : join(dir,`snapshot-live-${Date.now()}.json`);
    if (!b) await checkout(l.task.repo,a.sha!,cwd=>snapshot(l.task,cwd,a.sha!,current,"live"));
    diff=differences(join(a.value.evidenceDir,"snapshot-after.json"),current);
  }
  atomicWrite(report,"# 运行差异\n\n"+diff+"\n");return {report,diff};
}
export function timerPlist(label:string,root:string,seconds=defaults().tickIntervalSec) {
  const xml=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath,entrypoint,"tick","--all"].map(p=>`<string>${xml(p)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>LOOP_TASKS_ROOT</key><string>${xml(root)}</string><key>PATH</key><string>${xml(process.env.PATH || "/usr/bin:/bin")}</string></dict><key>StartInterval</key><integer>${seconds}</integer></dict></plist>`;
}
export function timer(install:boolean) {
  if (process.platform!=="darwin") throw new InputError("launchd 只支持 macOS");
  const root=tasksRoot(), label="local.dev-loop.tick", domain=`gui/${process.getuid?.()}`, file=join(homedir(),"Library","LaunchAgents",label+".plist");
  const call=(...args:string[])=>spawnSync("/bin/launchctl",args,{encoding:"utf8"}), found=call("print",`${domain}/${label}`);
  if (found.status===0) {const r=call("bootout",`${domain}/${label}`);if(r.status)throw new Error(r.stderr || r.stdout);}
  if (install) {atomicWrite(file,timerPlist(label,root));const r=call("bootstrap",domain,file);if(r.status)throw new Error(r.stderr || r.stdout);}
  else rmSync(file,{force:true});return {file,installed:install};
}
