import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerPi } from "../src/hosts/pi.ts";
import { jsonLines } from "../src/infra/files.ts";
const arg=(key:string)=>{const i=process.argv.indexOf(key);return i<0 ? undefined : process.argv[i+1];};
export function fakeWindow() {
  const dir=process.env.LOOP_TASK_DIR!, id=process.env.LOOP_EXPECT_SESSION!, file=arg("--session") || join(arg("--session-dir")!,id+".jsonl"), handlers=new Map<string,Function>();
  if (!existsSync(file)) writeFileSync(file,JSON.stringify({type:"session",id})+"\n");
  let idle=true,assistant:any,percent:number|null=null;
  const ctx={cwd:process.cwd(),hasUI:false,mode:"tui",getContextUsage:()=>({percent}),isIdle:()=>idle,shutdown:()=>setImmediate(()=>process.exit(0)),
    sessionManager:{getBranch:()=>assistant ? [{message:assistant}] : [],getSessionId:()=>id,getSessionFile:()=>file}};
  const emit=(name:string,event?:any)=>handlers.get(name)?.(event,ctx);
  registerPi({on:(name,fn)=>{handlers.set(name,fn);},sendMessage:(message)=>{
    appendFileSync(join(dir,"inbox.jsonl"),JSON.stringify({pid:process.pid,content:message.content})+"\n");idle=false;setImmediate(()=>emit("agent_start"));
  }});
  emit("session_start"); let read=0;
  setInterval(()=>{
    const rows=jsonLines<any>(join(dir,"window-control.jsonl"));
    for (const x of rows.slice(read)) if (x.pid===process.pid) {
      if (x.type==="turn") {idle=false;emit("agent_start");}
      if (x.type==="input") {emit("input",{source:x.source || "interactive",text:x.text});idle=false;emit("agent_start");}
      if (x.type==="pre-retry") emit("agent_end");
      if (x.type==="settle") {assistant={role:"assistant",content:[{type:"text",text:x.text || "已完成"}],stopReason:x.reason || "stop",errorMessage:x.error};percent=x.percent ?? null;idle=true;emit("agent_settled",{aborted:!!x.aborted});}
      if (x.type==="close") {emit("session_shutdown");process.exit(0);}
      appendFileSync(join(dir,"window-control-ack.jsonl"),JSON.stringify({id:x.id})+"\n");
    }
    read=rows.length;
  },10);
}
