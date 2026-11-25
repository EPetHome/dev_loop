import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { fixture, write, sq, MUST, PASS, ROOT, deliver, settle, statusOf } from "./helpers.ts";
import { checksOf, Ledger } from "../src/core/store.ts";
import { git } from "../src/infra/git.ts";
import { parseReview } from "../src/core/review-parse.ts";

test("R1 A5：必修模板与解析器约定的触发标签和路径行号一致", () => {
  const rules = readFileSync(join(ROOT,"src/core/review-prompt.md"),"utf8");
  const format = /^- `## 必修`：(.+)\r?\n([^\r\n]+)/m.exec(rules);
  assert.ok(format, "必修标题下须有格式说明和分行模板");
  assert.match(format[1], /`触发：`/);
  assert.match(format[2], /`触发：[^`]+`/);
  assert.match(format[2], /`位置：相对路径:行(?:或起-止)?`/);
  const example = [...format[2].matchAll(/`([^`]+)`/g)].map(m=>m[1].replace(/相对路径:行(?:或起-止)?/,"src/app.ts:12-18"));
  const parsed = parseReview("## 结论：需返修\n## 必修\n1. " + example.join("\n   ") + "\n## 小问题\n无\n");
  assert.ok(parsed.ok); assert.deepEqual(parsed.review.mustFix,[example.join(" ")]);
});

const projectRules = (input: string) => input.split("## 项目评审规则\n\n")[1]?.split("\n\n## 本轮改动")[0];

test("R1 A6：评审只拼开工提交的 REVIEW.md 和仓库内相对链接全文", async t => {
  const f = fixture(t), rules = ["# 起点规则", "", "[规范](./docs/规范.md#一 \"条目\")", "[同文件](docs/./规范.md)",
    "[引用规范][ref]", "[ref]: <docs/另一 条.md>", "[编码](docs/编码%20名.md)",
    `[绝对](<${join(f.base,"abs.md")}>)`, "[仓库内绝对](/docs/规范.md)", "[上级](../abs.md)", "[网址](https://example.invalid/ignore)",
    "[链接文件](docs/symlink.md)", "[目录](docs/)", "`[内联示例](docs/示例.md)`", "```md", "[示例](docs/示例.md)", "```", ""].join("\n");
  const standard = "# 一\n\n完整规则一\n\n完整规则二（含结尾）\n[不递归](不递归.md)\n";
  write(join(f.base,"abs.md"),"ABSOLUTE-SECRET");
  write(join(f.repo,"REVIEW.md"),rules); write(join(f.repo,"docs/规范.md"),standard);
  write(join(f.repo,"docs/另一 条.md"),"REFERENCE-LINK"); write(join(f.repo,"docs/编码 名.md"),"ENCODED-LINK");
  write(join(f.repo,"docs/示例.md"),"EXAMPLE-NOT-RULE"); write(join(f.repo,"docs/不递归.md"),"NESTED-NOT-RULE");
  symlinkSync(join(f.base,"abs.md"),join(f.repo,"docs/symlink.md"));
  f.git("add","."); f.git("commit","-m","base rules");
  const task = await f.prepare();
  write(join(f.repo,"REVIEW.md"),"LATE-REVIEW\n"); write(join(f.repo,"docs/规范.md"),"LATE-LINK\n");
  f.git("commit","-am","new rules on dev");
  write(join(task.worktree,"src/app.txt"),"good new delivery\n"); deliver(task.dir); await settle(task.dir);
  const input = readFileSync(join(task.dir,"review-input-r1.md"),"utf8"), section = projectRules(input);
  assert.ok(section?.includes(rules)); assert.ok(section.includes(standard));
  assert.deepEqual(section.match(/^### .+$/gm)?.sort(),["### REVIEW.md","### docs/规范.md","### docs/另一 条.md","### docs/编码 名.md","### docs/symlink.md"].sort());
  assert.match(section,/REFERENCE-LINK/); assert.match(section,/ENCODED-LINK/);
  assert.doesNotMatch(input,/LATE-REVIEW|LATE-LINK|ABSOLUTE-SECRET|EXAMPLE-NOT-RULE|NESTED-NOT-RULE/);
  assert.equal(statusOf(task.dir).state,"completed");
});

test("R1 A7：没有 REVIEW.md 和起点缺链接文件均继续评审", async t => {
  for (const hasRoot of [false,true]) {
    const f = fixture(t);
    if (hasRoot) {
      write(join(f.repo,"REVIEW.md"),"[还未提交](rules/later.md)\n"); f.git("add","REVIEW.md"); f.git("commit","-m","missing link");
    }
    const task = await f.prepare();
    write(join(f.repo,"rules/later.md"),"ONLY-IN-LATER-TREE\n");
    f.git("add","rules/later.md"); f.git("commit","-m","later content");
    write(join(task.worktree,"src/app.txt"),"good with optional rules\n"); deliver(task.dir); await settle(task.dir);
    const input = readFileSync(join(task.dir,"review-input-r1.md"),"utf8"), section = projectRules(input);
    if (hasRoot) assert.match(section!,/### rules\/later\.md\n\n起点版本里没有/);
    else assert.equal(section,"无");
    assert.doesNotMatch(input,/ONLY-IN-LATER-TREE/);
    assert.equal(statusOf(task.dir).state,"completed");
    assert.equal(checksOf(task.dir).find(c=>c.step === "评审")?.result,"通过");
  }
});

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
  const path=join(task.dir,"review-input-r1.md"), log=new Ledger(task.dir).last("复测")!.check!.evidence[0];
  const material=readFileSync(path,"utf8"), original=readFileSync(log,"utf8"), body=material.split("## 复测结果\n\n")[1].split("\n\n## 上一轮必修")[0];
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
  const task=await f.prepare(); write(join(task.worktree,"src/app.txt"),"good log fixture\n"); const {commit}=deliver(task.dir); await settle(task.dir);
  const path=join(task.dir,"review-input-r1.md"), log=new Ledger(task.dir).last("复测")!.check!.evidence[0];
  const material=readFileSync(path,"utf8"), body=material.split("## 复测结果\n\n")[1].split("\n\n## 上一轮必修")[0];
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
  const task = await f.prepare(); write(join(task.worktree, "src/old.txt"), "round-one\nsecond-line\n"); deliver(task.dir); await settle(task.dir); await f.pump(task.dir,l=>!!l.last("发回"));
  rmSync(join(task.worktree, "src/old.txt")); deliver(task.dir); await settle(task.dir);
  let input = readFileSync(join(task.dir, "review-input-r2.md"), "utf8");
  assert.match(input, /src\/old.txt（原 2 行）/); assert.doesNotMatch(input, /-round-one|-old-base-secret/);
  write(join(f.repo, "prompt.md"), "需求改变后完整评审"); await settle(task.dir);
  input=readFileSync(join(task.dir,"review-input-r2.md"),"utf8");
  assert.match(input, /需求已变化/); assert.match(input, /src\/old.txt（原 1 行）/); assert.doesNotMatch(input, /old-base-secret/);
});
