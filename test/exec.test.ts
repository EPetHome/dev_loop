import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { alive, identity, retireGroup, signalProcess, childExec } from "../src/infra/exec.ts";
const p = {pid: 700001, startedAt: "test process identity"};
/** 只替换系统调用，不制造真实僵尸或向假 PID 发信号；稳定复现 macOS EPERM。 */
function mockPs(t: TestContext, stat: string | Error) {
  const original = childProcess.execFileSync, queried: string[][] = [];
  t.mock.method(childProcess, "execFileSync", (...args: any[]) => {
    const [file, argv] = args;
    if (file === "ps" && Number(argv[1]) >= p.pid && Number(argv[1]) <= p.pid + 4) {
      queried.push(argv);
      if (argv[3] === "lstart=") return p.startedAt;
      assert.equal(argv[3], "stat=");
      if (stat instanceof Error) throw stat;
      return stat;
    }
    return (original as any)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return queried;
}
for (const stat of ["Z", " Z+\n", "S", "R+", "", new Error("ps failed")]) test("signalProcess：EPERM 仅忽略确认的僵尸 stat=" + String(stat).trim(), t => {
  const queried = mockPs(t, stat), error = Object.assign(new Error("kill EPERM"), {code: "EPERM"});
  const kill = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, -p.pid); assert.equal(signal, "SIGKILL"); throw error;
  });
  if (typeof stat === "string" && stat.trim().startsWith("Z")) assert.doesNotThrow(() => signalProcess(p, true));
  else assert.throws(() => signalProcess(p, true), e => e === error);
  assert.equal(kill.mock.callCount(), 1);
  assert.deepEqual(queried, [["-p", String(p.pid), "-o", "lstart="], ["-p", String(p.pid), "-o", "stat="]]);
});
test("进程身份只缓存本进程，外部 PID 更换仍重新核对", t => {
  const self = identity(), original = childProcess.execFileSync;
  let start = "first", selfReads = 0;
  t.mock.method(childProcess, "execFileSync", (...args: any[]) => {
    if (args[0] === "ps" && Number(args[1][1]) === p.pid) return start;
    if (args[0] === "ps" && Number(args[1][1]) === process.pid) selfReads++;
    return (original as any)(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.ok(self.startedAt);
  assert.deepEqual(identity(), self); assert.equal(selfReads, 0);
  const first = identity(p.pid); assert.equal(alive(first), true);
  start = "reused PID"; assert.equal(alive(first), false);
});
for (const replaced of [false,true]) test("retireGroup：组长起初不可见，"+(replaced ? "等候时确认复用则退出" : "组内有活进程仍不放行"), async t => {
  let groupProbes = 0;
  const ps = t.mock.method(childProcess,"execFileSync",(file: string, args: string[]) => {
    assert.equal(file,"ps");
    if (args[0] === "-p") { assert.deepEqual(args,["-p",String(p.pid),"-o","lstart="]); return replaced && groupProbes ? "new identity" : ""; }
    assert.deepEqual(args,["-Ao","pgid=,stat="]); groupProbes++; return `${p.pid} S\n`;
  });
  const kill = t.mock.method(process,"kill",() => assert.fail("不能向身份不明的组发信号"));
  let now = 0; const clock = t.mock.method(Date,"now",() => now+=2000);
  syncBuiltinESMExports();
  try { if (replaced) await retireGroup(p); else await assert.rejects(retireGroup(p),/旧检查进程组仍未退出/); }
  finally { clock.mock.restore(); ps.mock.restore(); kill.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(groupProbes,1);
});
test("signalProcess：ESRCH 仍忽略，不查询 stat", t => {
  const queried = mockPs(t, "S");
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), {code: "ESRCH"}); });
  assert.doesNotThrow(() => signalProcess(p, true)); assert.equal(queried.length, 1);
});
test("真实进程超时保留原文、整组退出；UTF-8 跨块不裂开",async()=>{
  const cwd=process.cwd(), code=`process.stdout.write('你好'.repeat(60000))`;
  assert.equal((await childExec(process.execPath,["-e",code],{cwd,timeoutMs:3000})).stdout,"你好".repeat(60000));
  const r=await childExec("/bin/sh",["-c","sleep 10 & wait"],{cwd,timeoutMs:30});assert(r.killed);assert.notEqual(r.code,0);
});
