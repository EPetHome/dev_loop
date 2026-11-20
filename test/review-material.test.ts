import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fixture, write, sq, MUST, PASS } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { settle } from "../src/core/settle.ts";
import { checksOf, statusOf } from "../src/core/store.ts";
import { git } from "../src/infra/git.ts";

function keepMaterial(label: string, paths: string[]) {
  const root = process.env.LOOP_W1_EVIDENCE; if (!root) return;
  const dir = join(root, label); mkdirSync(dir, {recursive: true});
  for (const path of paths) copyFileSync(path, join(dir, basename(path)));
}

test("W1 A17 / 问题单 A3：7.3 MB 日志、超长单行，材料保留完整需求和 diff", async t => {
  const f = fixture(t, {test: "node large-log.cjs"});
  const header = "LOG-HEAD-NEVER-IN-MATERIAL\n# pass 100\n# fail 0\n", line = "行".repeat(220) + "\n";
  write(join(f.repo, "large-log.cjs"), `process.stdout.write(${JSON.stringify(header)} + ${JSON.stringify(line)}.repeat(33) + "🙂".repeat(1819000) + "\\nLOG-FINAL\\n");`);
  f.git("add", "large-log.cjs"); f.git("commit", "-m", "large log fixture");
  const task = await f.prepare(); write(join(task.worktree, "src/app.txt"), "good material diff\n");
  const {commit} = deliver(task.dir); await settle(task.dir);
  const path = join(task.dir, "review-input-r1.md"), log = join(task.dir, "test-" + commit + ".log");
  const material = readFileSync(path, "utf8"), original = readFileSync(log, "utf8"), body = material.split("## 复测结果\n\n")[1];
  const bytes = Buffer.byteLength(original), bodyBytes = Buffer.byteLength(body), bodyLines = body.split("\n").length;
  const checks = checksOf(task.dir).filter(c => ["复测", "评审"].includes(c.step));
  keepMaterial("A17-large", [path, log, ...checks.flatMap(c => c.step === "评审" ? c.evidence : [])]);
  t.diagnostic(JSON.stringify({base: task.baseCommit, commit, end: statusOf(task.dir).loop.phase, checks: checks.map(c => [c.step, c.result]), logBytes: bytes, materialBytes: Buffer.byteLength(material), bodyBytes, bodyLines}));
  assert.ok(bytes > 7_200_000 && bytes < 7_400_000);
  assert.equal(statusOf(task.dir).state, "completed");
  assert.deepEqual(checks.map(c => [c.step, c.result, c.commit]), [["复测", "通过", commit], ["评审", "通过", commit]]);
  assert.ok(material.includes(readFileSync(task.prompt, "utf8")));
  assert.ok(material.includes(readFileSync(task.acceptance!, "utf8")));
  assert.ok(material.includes(git(task.worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--diff-filter=d", task.baseCommit, commit, "--"])));
  assert.ok(bodyBytes <= 8192 && bodyLines <= 30, "复测正文须同时限行和限 UTF-8 字节");
  assert.match(body, /命令：node large-log.cjs\n结果：通过/);
  assert.match(body, /通过数：100；失败数：0/);
  assert.ok(body.includes(log) && body.includes(bytes + " 字节"));
  assert.ok(original.includes("LOG-HEAD-NEVER-IN-MATERIAL") && original.includes("🙂".repeat(2048)));
  assert.match(body, /…[\s\S]*LOG-FINAL/);
  assert.doesNotMatch(body, /LOG-HEAD-NEVER-IN-MATERIAL|�/);
});

test("W1 A17：读取靠前的失败测试名与计数，长命令、长测试名及长输出不撑破限额", async t => {
  const f = fixture(t, {test: "node failing-subreport.cjs # " + "长".repeat(5000)});
  const subreport = ["not ok 1 - 登录超时", "not ok 2 - 长测试名" + "界".repeat(5000), "not ok 3 - 已知限制 # TODO fix later",
    "# pass 7", "# fail 2", ...Array(40).fill("tail " + "尾".repeat(400)), "LAST"];
  // 内层报告含预期失败，外层任务命令成功，验证实际送出的材料，不改变判定复测结果的规则。
  write(join(f.repo, "failing-subreport.cjs"), "console.log(" + JSON.stringify(subreport.join("\n")) + ");\n");
  f.git("add", "failing-subreport.cjs"); f.git("commit", "-m", "inner report fixture");
  const task = await f.prepare(), {commit} = deliver(task.dir); await settle(task.dir);
  const path = join(task.dir, "review-input-r1.md"), log = join(task.dir, "test-" + commit + ".log");
  const material = readFileSync(path, "utf8"), body = material.split("## 复测结果\n\n")[1];
  keepMaterial("A17-names", [path, log]);
  t.diagnostic(JSON.stringify({commit, end: statusOf(task.dir).loop.phase, logBytes: readFileSync(log).byteLength, materialBytes: Buffer.byteLength(material), bodyBytes: Buffer.byteLength(body), bodyLines: body.split("\n").length}));
  assert.ok(Buffer.byteLength(body) <= 8192 && body.split("\n").length <= 30);
  assert.match(body, /通过数：7；失败数：2/);
  assert.match(body, /失败测试名：[\s\S]*登录超时[\s\S]*长测试名/);
  assert.match(body, /LAST/); assert.doesNotMatch(body, /已知限制|�/);
});

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
