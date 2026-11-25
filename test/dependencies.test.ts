import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fixture, ROOT } from "./helpers.ts";
import { timerPlist } from "../src/cli/inspect.ts";
function files(dir: string): string[] {return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
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
  const lines=files(src).filter(f=>/\.(ts|md)$/.test(f)).reduce((n,f)=>n+readFileSync(f,"utf8").trimEnd().split("\n").length,0);
  assert.ok(lines<=2000,`src ${lines} 行；上限 2000 行`);
  console.log("依赖方向检查通过："+edges+" 条本地模块边，src "+lines+" 行");
  const pkg=JSON.parse(readFileSync(join(ROOT,"package.json"),"utf8"));
  assert.deepEqual(pkg.dependencies||{},{});assert.deepEqual(pkg.devDependencies||{},{});
});
test("launchd 只生成用户定时项，安全转义路径并使用固定间隔（不安装）",()=>{
  const plist=timerPlist("test", "/tmp/a&b", 17);
  assert.match(plist,/<string>tick<\/string><string>--all<\/string>/);
  assert.match(plist,/<key>StartInterval<\/key><integer>17<\/integer>/);
  assert.match(plist,/\/tmp\/a&amp;b/);
});
