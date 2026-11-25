import { execFileSync } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function processTable() {
  return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,command="], {encoding: "utf8"})
    .split("\n").flatMap(line => {
      const row = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!row || row[4].startsWith("Z")) return []; // 僵尸已退出，没有可结束的命令。
      const [, pid, ppid, pgid, stat, command] = row;
      return [{pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat, command}];
    });
}

type ProcessRow = ReturnType<typeof processTable>[number];
function belongsTo(base: string) {
  if (!isAbsolute(base) || !/^dev-loop-test-[a-zA-Z0-9]{6}$/.test(basename(base))) throw new Error(`非测试临时目录：${base}`);
  const path = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(?:^|[\\s'"=])(?:file://)?${path}(?=$|[/\\s'"])`);
  return ({command}: ProcessRow) => token.test(command);
}

export const fixtureProcesses = (base: string) => processTable().filter(belongsTo(base));

function kill(pid: number) {
  try { process.kill(pid, "SIGKILL"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
}

export async function stopFixtureProcesses(base: string) {
  const owns = belongsTo(base), deadline = Date.now() + 2000;
  for (;;) {
    const table = processTable(), targets = table.filter(owns);
    if (!targets.length || Date.now() >= deadline) return; // 未退出的由收尾断言报出。
    for (const pgid of new Set(targets.map(p => p.pgid))) {
      const group = table.filter(p => p.pgid === pgid);
      // 开窗组的 launcher 未必在账本里。组内每个活进程都匹配本次目录才整组结束；不碰同组的其他进程。
      const scoped = (p: ProcessRow) => p.pid !== process.pid && owns(p);
      if (pgid > 1 && group.every(scoped)) kill(-pgid);
      else for (const p of group.filter(scoped)) kill(p.pid);
    }
    await delay(15);
  }
}

export function assertNoFixtureProcesses(...bases: string[]) {
  if (!bases.length) return;
  const table = processTable();
  const residual = bases.flatMap(base => table.filter(belongsTo(base)));
  if (residual.length) throw new Error(`自检遗留进程：\n${residual.map(p => `${p.pid} (组 ${p.pgid}) ${p.command}`).join("\n")}`);
}
