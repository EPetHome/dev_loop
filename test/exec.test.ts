import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { signalProcess } from "../src/infra/exec.ts";
import { stop } from "../src/core/lifecycle.ts";
import { update, statusOf } from "../src/core/store.ts";
import { fixture } from "./helpers.ts";
const p = {pid: 700001, startedAt: "test process identity"};
/** 只替换系统调用，不制造真实僵尸或向假 PID 发信号；稳定复现 macOS EPERM。 */
function mockPs(t: TestContext, stat: string | Error) {
  const original = childProcess.execFileSync, queried: string[][] = [];
  t.mock.method(childProcess, "execFileSync", (...args: any[]) => {
    const [file, argv] = args;
    if (file === "ps" && Number(argv[1]) >= p.pid && Number(argv[1]) <= p.pid + 3) {
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
test("signalProcess：ESRCH 仍忽略，不查询 stat", t => {
  const queried = mockPs(t, "S");
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), {code: "ESRCH"}); });
  assert.doesNotThrow(() => signalProcess(p, true)); assert.equal(queried.length, 1);
});
test("停止/放弃：首个进程僵尸 EPERM 不阻断后续终止或 worktree 清理", async t => {
  const f = fixture(t), task = await f.prepare(); mockPs(t, "Z");
  update(task.dir, s => {
    s.loop.startingSession = {...p, launchId: "fake"}; s.loop.activeProcess = {...p, pid: p.pid + 1};
    s.loop.launcher = {...p, pid: p.pid + 2}; s.loop.session = {...p, pid: p.pid + 3, host: "pi", id: "fake"};
  });
  const killed: number[] = [];
  t.mock.method(process, "kill", (pid: number) => {
    killed.push(pid); if (pid === p.pid) throw Object.assign(new Error("zombie"), {code: "EPERM"}); return true;
  });
  const s = stop(task.dir, true);
  assert.deepEqual(killed, [p.pid, -(p.pid + 1), -(p.pid + 2), p.pid + 3]);
  assert.equal(s.state, "cancelled"); assert.equal(statusOf(task.dir).loop.abandoned, true); assert.equal(existsSync(task.worktree), false);
  assert.ok(f.git("show-ref", "--verify", "refs/heads/" + task.branch)); assert.equal(existsSync(join(task.dir, "checks.jsonl")), true);
});
