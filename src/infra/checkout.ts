import { constants, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { inside, safeRelative } from "./config.ts";
import { errorText, ifPresent } from "./files.ts";
import { gitText, gitTry } from "./git.ts";
export function removeCheckout(repo: string, cwd: string, warning = console.error, env?: NodeJS.ProcessEnv) {
  const r = existsSync(cwd) && gitTry(repo,["worktree","remove","--force",cwd],env);
  if (r && r.code) warning("临时检出移除失败："+r.stdout+r.stderr);
}
function removeTree(root: string, warning = console.error) {
  try { rmSync(root,{recursive:true,force:true}); } catch(e) { warning("临时目录删除失败："+String(e)); }
}
export async function checkout<T>(repo:string,commit:string,run:(cwd:string)=>Promise<T>,warning=console.error,source?:string) {
  const root=mkdtempSync(join(tmpdir(),"dev-loop-check-")), cwd=join(root,"src");
  try {
    gitText(repo,["worktree","add","--detach",...(source?["--no-checkout"]:[]),cwd,commit]);
    if (source) {gitText(cwd,["read-tree",commit]);await copySnapshot(realpathSync(source),cwd);}
    return await run(cwd);
  } finally {removeCheckout(repo,cwd,warning);removeTree(root,warning);}
}
function hasParentDependencies(path: string): boolean {
  for (let dir = path;; dir = dirname(dir)) {
    if (basename(dir).toLowerCase() === "node_modules" || lstatSync(join(dir,"node_modules"),{throwIfNoEntry:false})) return true;
    if (dir === dirname(dir)) return false;
  }
}
function privateScratch(excluded: string[]) {
  const blocked = excluded.map(p => ifPresent(() => realpathSync.native(p)) ?? resolve(p));
  const errors: string[] = [];
  // 不让调用者的 TMPDIR 把检出放进项目或共享 node_modules 的解析范围。
  for (const base of ["/tmp","/var/tmp"]) try {
    const parent = realpathSync.native(base);
    if (blocked.some(path => inside(path,parent)) || hasParentDependencies(parent)) continue;
    return mkdtempSync(join(parent,"dev-loop-proof-"));
  } catch (e) { errors.push(errorText(e)); }
  throw new Error(["没有位于项目、任务工作区和共享依赖之外的证明临时目录",...errors].join("\n"));
}
/** 只取本地对象，不复制配置或共享 Git 元数据；每端 setup 可写自己的仓库配置。 */
export async function privateCheckout<T>(repo: string, commit: string, excluded: string[], env: NodeJS.ProcessEnv,
  run: (cwd: string) => Promise<T>, warning?: (text: string) => void) {
  const root = privateScratch([repo,...excluded]), cwd = join(root,"src");
  try {
    const format = gitText(repo,["rev-parse","--show-object-format"],env);
    gitText(root,["init","--template=","--object-format="+format,cwd],env);
    gitText(cwd,["fetch","--no-tags","--no-recurse-submodules","--no-write-fetch-head","--no-auto-maintenance","--",repo,commit],
      {...env,GIT_ALLOW_PROTOCOL:"file"});
    gitText(cwd,["checkout","--detach",commit],env);
    return await run(cwd);
  } finally { removeTree(root,warning); }
}
function copySnapshot(source:string,dest:string) {
  return cp(source,dest,{recursive:true,mode:constants.COPYFILE_FICLONE,filter(from,to) {
    if (basename(from).toLowerCase() === ".git") return false; if (!lstatSync(from).isSymbolicLink()) return true;
    const path = relative(source,realpathSync(from));
    if (!safeRelative(path.toLowerCase() || ".")) throw new Error("留痕链接越出副本范围：" + relative(source,from));
    symlinkSync(relative(dirname(to),join(dest,path)) || ".",to); return false;
  }});
}
