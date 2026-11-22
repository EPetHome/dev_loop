import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fixture, ROOT } from "./helpers.ts";
import { HOOK_TIMEOUT_SEC } from "../src/infra/host-limits.ts";
function files(dir: string): string[] {return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
test("依赖方向：cli/hosts/steps/core/infra 单向；不引用旧 loop、不引入新依赖",t=>{
  fixture(t);
  const src=join(ROOT,"src"),allowed:Record<string,string[]>={cli:["cli","steps","core","infra"],hosts:["hosts","core","infra"],steps:["core","infra"],core:["core","infra"],infra:["infra"]};
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
  assert.ok(lines<=2000,"src 超过 2000 行："+lines);
  console.log("依赖方向检查通过："+edges+" 条本地模块边，src "+lines+" 行");
  const pkg=JSON.parse(readFileSync(join(ROOT,"package.json"),"utf8"));
  assert.deepEqual(pkg.dependencies||{},{});assert.deepEqual(pkg.devDependencies||{},{});
});
test("插件只是本地清单：三事件，无 UserPromptSubmit，薄入口",t=>{
  fixture(t);
  for(const name of [".claude-plugin",".codex-plugin"])assert.equal(JSON.parse(readFileSync(join(ROOT,"plugins/dev-loop",name,"plugin.json"),"utf8")).name,"dev-loop");
  const hooks=JSON.parse(readFileSync(join(ROOT,"plugins/dev-loop/hooks/hooks.json"),"utf8")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(),["PostToolUse","SessionStart","Stop"]);
  assert.equal(hooks.Stop[0].hooks[0].timeout,HOOK_TIMEOUT_SEC);
  const entry=readFileSync(join(ROOT,"hosts/hook.ts"),"utf8");assert.ok(entry.split("\n").length<=6);assert.match(entry,/src\/hosts\/hook.ts/);
});
