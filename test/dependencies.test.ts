import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { fixture, ROOT, write } from "./helpers.ts";
import { timerPlist } from "../src/cli/inspect.ts";
function files(dir: string): string[] {return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}

const SOURCE_CHAR_LIMIT = 155_000;

function checkSourceSize(src: string, report?: (message: string) => void) {
  let chars = 0, lines = 0;
  for (const file of files(src).filter(f => /\.(ts|md)$/.test(f))) {
    const text = readFileSync(file,"utf8");
    chars += text.replace(/\s/g, "").length;
    lines += text.trimEnd().split("\n").length;
  }
  const size = `src ${chars.toLocaleString("en-US")} 个非空白字符；上限 ${SOURCE_CHAR_LIMIT.toLocaleString("en-US")}`;
  report?.(`${size}；${lines} 行（仅供参考）`);
  assert.ok(chars <= SOURCE_CHAR_LIMIT, size);
  return {chars, lines};
}

function tempSource(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dev-loop-size-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return join(root, "src");
}

test("依赖方向：cli/hosts/steps/core/infra 单向；不引用旧 loop、不引入新依赖",t=>{
  fixture(t);
  const src=join(ROOT,"src"),allowed:Record<string,string[]>={cli:["cli","steps","hosts","core","infra"],hosts:["hosts","core","infra"],steps:["core","infra"],core:["core","infra"],infra:["infra"]};
  let edges=0;
  for(const file of files(src).filter(f=>f.endsWith(".ts"))){
    const layer=relative(src,file).split("/")[0],content=readFileSync(file,"utf8");
    const imports=[...content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)].map(m=>m[1]);
    for(const spec of imports){
      if(spec.startsWith("node:"))continue;
      assert.ok(spec.startsWith("."),"禁止包/绝对路径依赖："+file+" → "+spec);
      const target=realpathSync(resolve(dirname(file),spec)),rel=relative(src,target),to=rel.split("/")[0];
      assert.ok(!rel.startsWith(".."),"越出 src："+spec);assert.ok(allowed[layer]?.includes(to),layer+" → "+to);edges++;
    }
    assert.doesNotMatch(content,/\/Users\/Admin\/Desktop\/loop\//);
  }
  console.log("依赖方向检查通过："+edges+" 条本地模块边");
  const pkg=JSON.parse(readFileSync(join(ROOT,"package.json"),"utf8"));
  assert.deepEqual(pkg.dependencies||{},{});assert.deepEqual(pkg.devDependencies||{},{});
});

test("体量检查：src/ 非空白字符不超过 155,000", t => {
  checkSourceSize(join(ROOT, "src"), message => t.diagnostic(message));
});

test("A1：合并两行只改变参考行数，体量计数和判定不变", t => {
  const src = tempSource(t);
  const split = 'const a=1;\n\tconst b="汉";\n';
  const file = write(join(src, "code.ts"), split);
  write(join(src, "nested", "notes.md"), "一\u00a0二\u3000三\r\n\t四\n");
  write(join(src, "ignored.txt"), "x".repeat(155_001));
  const report = (message: string) => t.diagnostic(`临时目录：${message}`);
  assert.deepEqual(checkSourceSize(src, report), {chars: 24, lines: 4});
  write(file, split.replace("\n\t", ""));
  assert.deepEqual(checkSourceSize(src, report), {chars: 24, lines: 3});
});

test("A2：恰好到上限通过，超出时报告实际字符数和上限", t => {
  const src = tempSource(t);
  const file = write(join(src, "padding.md"), "x\n".repeat(3_000) + "x".repeat(152_000));
  assert.deepEqual(checkSourceSize(src), {chars: 155_000, lines: 3_001});
  appendFileSync(file, "x");
  assert.throws(() => checkSourceSize(src), {message: "src 155,001 个非空白字符；上限 155,000"});
});

test("launchd 只生成用户定时项，安全转义路径并使用固定间隔（不安装）",()=>{
  const plist=timerPlist("test", "/tmp/a&b", 17);
  assert.match(plist,/<string>tick<\/string><string>--all<\/string>/);
  assert.match(plist,/<key>StartInterval<\/key><integer>17<\/integer>/);
  assert.match(plist,/\/tmp\/a&amp;b/);
});
