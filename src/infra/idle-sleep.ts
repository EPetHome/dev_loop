import { spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { optionalJson, writeJson } from "./files.ts";
import { signalProcess, identity, type Identity } from "./exec.ts";
export function idleSleep(dir:string,working:boolean,interval:number,now=Date.now(),env=process.env) {
  if (process.platform!=="darwin" && !env.LOOP_CAFFEINATE_CMD) return;
  const file=join(dir,"idle-sleep.json"), warn=(e:unknown)=>{try{appendFileSync(join(dir,"idle-sleep.log"),String(e)+"\n");}catch{}};
  try {
    const old=optionalJson<Identity & {renewAt:number}>(file);
    if (!working) {signalProcess(old);rmSync(file,{force:true});return;}
    if (old && now<old.renewAt && now>=old.renewAt-interval*1000) return;
    const child=spawn(env.LOOP_CAFFEINATE_CMD || "/usr/bin/caffeinate",["-i","-t",String(interval*2)],{env,detached:true,stdio:"ignore"});
    child.once("error",warn);child.unref();writeJson(file,{...identity(child.pid || 0),renewAt:now+interval*1000});signalProcess(old);
  } catch(e) {warn(e);}
}
