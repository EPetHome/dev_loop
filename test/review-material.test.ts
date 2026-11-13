import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { fixture, write, sq, MUST, PASS } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";

test("A8：删除文件只列原行数、中文/制表路径；修改和新增 diff、运行差异不变", async t => {
  const f = fixture(t), deleted = "src/被删\t文件.txt";
  write(join(f.repo, deleted), "DELETED-CONTENT-NEVER-IN-REVIEW\n".repeat(10000));
  write(join(f.repo, "src/no-newline.txt"), "NO-NEWLINE-DELETED\nlast");
  write(join(f.repo, "src/empty.txt"), "");
  write(join(f.repo, "src/binary.bin"), "\0binary-deleted-content\0");
  f.git("add", "src"); f.git("commit", "-m", "files to delete");
  const task = await f.prepare();
  for (const path of [deleted, "src/no-newline.txt", "src/empty.txt", "src/binary.bin"]) rmSync(join(task.worktree, path));
  write(join(task.worktree, "src/app.txt"), "good modified\n"); write(join(task.worktree, "src/added.txt"), "ADDED-CONTENT\n");
  deliver(task.dir); await settle(task.dir);
  const input = readFileSync(join(task.dir, "review-input-r1.md"), "utf8"), deletion = input.split("## 删除的文件\n\n")[1].split("## 新增文件")[0];
  assert.ok(deletion.includes(deleted + "（原 10000 行）")); assert.match(deletion, /src\/no-newline.txt（原 2 行）/);
  assert.match(deletion, /src\/empty.txt（原 0 行）/); assert.match(deletion, /src\/binary.bin（二进制，行数不适用）/);
  assert.doesNotMatch(input, /DELETED-CONTENT-NEVER-IN-REVIEW|NO-NEWLINE-DELETED|binary-deleted-content|deleted file mode/);
  assert.match(input, /-good\n\+good modified/); assert.match(input, /\+ADDED-CONTENT/);
  assert.match(input, /## 新增文件\n\nsrc\/added.txt/); assert.match(input, /## 运行差异[\s\S]*src\/app.txt[\s\S]*src\/no-newline.txt/);
  assert.ok(input.length < 10000);
});
test("增量评审删除文件按上次评审commit计行，需求变化仍按起点完整diff但不含删除内容", async t => {
  const f = fixture(t, {reviewer: 'if [ "$1" = 1 ]; then printf %s ' + sq(MUST) + '; else printf %s ' + sq(PASS) + '; fi'});
  write(join(f.repo, "src/old.txt"), "old-base-secret\n"); f.git("add", "src/old.txt"); f.git("commit", "-m", "old file");
  const task = await f.prepare(); write(join(task.worktree, "src/old.txt"), "round-one\nsecond-line\n"); deliver(task.dir); await settle(task.dir);
  rmSync(join(task.worktree, "src/old.txt")); deliver(task.dir); await settle(task.dir);
  let input = readFileSync(join(task.dir, "review-input-r2.md"), "utf8");
  assert.match(input, /src\/old.txt（原 2 行）/); assert.doesNotMatch(input, /-round-one|-old-base-secret/);
  write(join(f.repo, "prompt.md"), "需求改变后完整评审"); deliver(task.dir); await settle(task.dir);
  input = readFileSync(join(task.dir, "review-input-r3.md"), "utf8");
  assert.match(input, /需求已变化/); assert.match(input, /src\/old.txt（原 1 行）/); assert.doesNotMatch(input, /old-base-secret/);
});
