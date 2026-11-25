import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger } from "../src/core/store.ts";
import { assertNoFixtureProcesses, fixtureProcesses } from "./fixture-cleanup.ts";
import { fixture, until, write, writeFixtureScript } from "./helpers.ts";

test("N3 A4 · 未登记的开窗进程组在自检收尾全部退出", async t => {
  let base = "";
  await t.test("子进程已启动，但账本还没有登记", async t => {
    const f = fixture(t), x = await f.prepare();
    base = f.base;
    writeFixtureScript(f.env.LOOP_LAUNCH_CMD!, "node", "setInterval(() => {}, 1000);\n");
    // 固定 A7 中 B 卡开窗与 teardown 竞争的时序。这里不让窗口登记，也不靠定长等待猜时机。
    const shim = write(join(base, "pause-launch.mjs"), `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = function (command, args, options) {
  const child = spawn(command, args, options);
  if (command === process.env.LOOP_LAUNCH_CMD) process.kill(process.pid, "SIGSTOP");
  return child;
};
syncBuiltinESMExports();
`);
    const env = {NODE_OPTIONS: [f.env.NODE_OPTIONS, `--import=${pathToFileURL(shim).href}`].filter(Boolean).join(" ")};
    const tick = await f.call(["tick", "--all"], f.repo, env);
    assert.deepEqual(tick.errors, []);
    await until(base, () => fixtureProcesses(base), rows => {
      const launcher = rows.find(p => p.command.includes("/src/hosts/launch.ts ") && p.stat.startsWith("T"));
      return !!launcher && launcher.pgid === launcher.pid && rows.some(p =>
        p.ppid === launcher.pid && p.pgid === launcher.pgid && p.command.includes(f.env.LOOP_LAUNCH_CMD!));
    }, "等待同组 launcher 与 fake-launch");
    assert.equal(new Ledger(x.dir).last("子进程"), undefined);
  });
  assert.ok(base && !existsSync(base), "临时目录已删除");
  assertNoFixtureProcesses(base);
});
