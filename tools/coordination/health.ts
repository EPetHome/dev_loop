import { execFileSync } from "node:child_process";
import { basename, dirname, relative, resolve } from "node:path";
import { array, entry, object, ref, sha, str, strings, type Ref } from "./files.ts";
import { delivered, type Project } from "./history.ts";
import { field, plain, sections } from "./markdown.ts";

const ids = (s: string, prefix: "F" | "S") => [...new Set(s.match(prefix === "F" ? /\bF\d+\b/g : /\bS\d+\b/g) || [])];
const paths = (s: string) => {
  const quoted = [...s.matchAll(/`([^`]+)`/g)].map(m=>m[1].trim());
  return quoted.length ? quoted : s.split(/[、,，;；\s]+/).filter(Boolean);
};
const recordedStatus = (s: string) => /^(?:状态\s*[:：]?\s*)?(规划|已上线|已删除)/.exec(plain(s))?.[1] || "";
function features(text: string, file: string) {
  const records = sections(text).flatMap(b => {
    const id = /^\[?(F\d+)\b/.exec(b.title)?.[1] || /^\s*(?:[-*]\s+)?(?:固定)?编号\s*[:：]?\s*(F\d+)\b/m.exec(b.body.replaceAll("**",""))?.[1];
    const status = field(b.body,"状态") || /(?:^|·)\s*状态\s*[:：]?\s*(已上线|已删除|规划)/m.exec(b.body.replaceAll("**",""))?.[1] || "";
    return id ? [{id,status:recordedStatus(status), verify:field(b.body,"怎么验"), source:ref(file,b.line)}] : [];
  });
  let columns: string[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) if (/^\s*\|/.test(line)) {
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(plain);
    if (cells.includes("状态") && cells.some(c=>["编号","固定编号"].includes(c))) { columns = cells; continue; }
    const n = columns.findIndex(c=>["编号","固定编号"].includes(c)), id = cells[n];
    if (id && /^F\d+$/.test(id)) records.push({id,status:recordedStatus(cells[columns.indexOf("状态")] || ""),verify:cells[columns.indexOf("怎么验")] || "",source:ref(file,i+1)});
  }
  return records;
}
function scenarios(text: string, file: string) {
  return sections(text).flatMap(b => {
    const id = /^\[?(S\d+)\b/.exec(b.title)?.[1];
    if (!id) return [];
    const owner = field(b.body,"所属功能"), [feature,...also] = ids(owner,"F"), reverse = field(b.body,"反向场景") || field(b.body,"反向");
    const modules = field(b.body,"所属模块") || /所属模块\s*[:：]?\s*(.+)/.exec(owner)?.[1] || "";
    const script = field(b.body,"脚本"), named = /`([^`]+)`/.exec(script)?.[1] || script.split(/[\s（(。]/,1)[0];
    const dependencies = [...new Set([...also,...ids(field(b.body,"依赖功能") || field(b.body,"关联功能"),"F")])];
    const reverseOf = ids(reverse,"F");
    if (!reverseOf.length && feature && (/^是$/.test(reverse) || /反向/.test(b.title))) reverseOf.push(feature);
    return [{id, feature, dependencies, reverseOf, modules:paths(modules.split(/（G11|\(G11|。/)[0]), script:named,
      approved:/状态\s*[:：]?\s*已批准/.test(plain(b.body)), source:ref(file,b.line)}];
  });
}
function matches(file: string, pattern: string) {
  pattern = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!/[*?]/.test(pattern)) return file === pattern || file.startsWith(pattern + "/");
  const tr: Record<string,string> = {"**/":"(?:.*/)?", "**":".*", "*":"[^/]*", "?":"[^/]"};
  return new RegExp("^" + pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(p=>tr[p] ?? p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("") + "$").test(file);
}
function changedPaths(project: Project, card: string, explicit: string[]) {
  if (explicit.length) return {source:"调用方提供的改动（含重命名旧名、删除路径）", paths:[...new Set(explicit.map(p=>relative(project.root,project.path(p))))]};
  const run = project.runs.findLast(r=>r.card === card), base = run?.task.baseCommit, commit = run && delivered(run);
  if (sha(base) && sha(commit)) return project.read.get(card, () => ({source: `${base} → ${commit}`, paths:execFileSync("git", ["diff","--name-only","--no-renames","--no-ext-diff","--no-textconv","-z",base,commit,"--"],
    {cwd:project.root,encoding:"utf8",timeout:3000,stdio:["ignore","pipe","pipe"]}).split("\0").filter(Boolean)}));
}
const groupNames = ["跑得起来","判断依据","动手工具","管理沉淀"] as const;
const defaultLocations = {
  featureList:["docs/功能清单.md","docs/requirements/功能清单-PA.md"],
  featureMap:["docs/功能地图.md","docs/requirements/功能地图-PA.md"],
  verifySkill:[".pi/skills/verify/SKILL.md",".agents/skills/verify/SKILL.md"],
  seeds:["docs/种子数据","test/seeds","e2e/seeds"],
};

export function health(project: Project, card: string, changed: string[]) {
  const exists = (path: string) => project.read.get(path, () => entry(project.root,path));
  const location = (key: keyof typeof defaultLocations) => str(project.config[key]) ? project.setting(key,"") :
    defaultLocations[key].map(p=>project.path(p)).find(p=>exists(p)) || project.path(defaultLocations[key][0]);
  const listFile = location("featureList"), mapFile = location("featureMap"), skill = location("verifySkill"), seeds = location("seeds");
  const functions = features(project.read.text(listFile) || "",listFile), map = scenarios(project.read.text(mapFile) || "",mapFile);
  const advice: {code: string; message: string; source: Ref; prune?: boolean; scenario?: string}[] = [];
  const hint = (code:string,message:string,source:Ref,prune = false,scenario?: string) => advice.push({code,message,source,...(prune && {prune}),...(scenario && {scenario})});
  const funcIDs = new Set(functions.map(f=>f.id));
  for (const f of functions) {
    if (functions.filter(x=>x.id === f.id).length > 1) hint("duplicate-feature", `${f.id} 编号重复`,f.source);
    if (!f.status) hint("feature-status-unknown", `${f.id} 状态未登记或无法识别`, f.source);
    if (f.status === "已上线" && !map.some(s=>s.feature === f.id && !s.reverseOf.includes(f.id))) hint("unmapped",`${f.id} 未关联场景（定向测试、人工或按批授权亦有效）`,f.source);
    if (f.status === "已上线" && (!f.verify || /^(?:无|待补充|待定|待填写|未知|未登记|暂无|—|-)\s*$/.test(plain(f.verify)))) hint("missing-verification",`${f.id} 缺少「怎么验」或不能验证的原因`,f.source);
    for (const id of ids(f.verify,"S")) {
      const declared = map.find(s=>s.id === id);
      if (!declared || declared.feature !== f.id && !declared.dependencies.includes(f.id) && !declared.reverseOf.includes(f.id)) hint("verification-mismatch",`${f.id} 的验法引用 ${id}，地图无对应场景或归属失配`,f.source);
    }
    if (f.status === "已删除" && !map.some(s=>s.reverseOf.includes(f.id))) hint("missing-reverse",`${f.id} 已删除，缺验证旧入口或行为消失的反向场景`,f.source);
  }
  let scriptsOK = 0;
  for (const s of map) {
    const owner = functions.find(f=>f.id === s.feature), script = s.script && !s.script.startsWith("/") ? project.read.get(mapFile,()=>project.path(s.script)) : undefined;
    if (functions.length && (!s.feature || !funcIDs.has(s.feature))) hint("orphan-scenario",`${s.id} 指向未登记功能 ${s.feature || "（未写）"}`,s.source,true,s.id);
    if (owner?.status === "已删除" && !s.reverseOf.includes(owner.id)) hint("deleted-feature",`${s.id} 仍覆盖已删除功能 ${owner.id}；不是反向场景`,s.source,true,s.id);
    for (const id of s.dependencies.filter(id=>functions.find(f=>f.id===id)?.status === "已删除" && !s.reverseOf.includes(id))) hint("deleted-dependency",`${s.id} 依赖已删除功能 ${id}，检查步骤及清理是否仍需调整`,s.source);
    const ambiguous = map.filter(x=>x.id === s.id).length > 1, conflict = script && map.some(x=>x.id !== s.id && x.script && project.read.get(mapFile,()=>project.path(x.script)) === script);
    const filenameId = script && /^(S\d+)(?:\.|$)/.exec(basename(script))?.[1];
    if (!script || !exists(script)?.isFile()) hint("missing-script",`${s.id} 缺少仓库内脚本：${s.script || "未登记"}`,s.source);
    else if (!ambiguous && !conflict && (!filenameId || filenameId === s.id)) scriptsOK++;
    if (ambiguous || conflict || filenameId && filenameId !== s.id) hint("script-mismatch",`${s.id} 场景编号重复、脚本被多个场景共用或编号失配：${s.script}`,s.source);
  }
  const chosen = card || project.runs.findLast(r=>r.card)?.card || (project.batches.length === 1 ? project.batches[0].card : "");
  const cardDoc = chosen ? project.read.doc(chosen) : undefined, task = object(array(cardDoc?.tasks)[0]);
  const promptFile = chosen && str(task.prompt) && project.read.get(chosen,()=>project.path(resolve(dirname(chosen),str(task.prompt))));
  const acceptanceFile = chosen && str(cardDoc?.acceptance) && project.read.get(chosen,()=>project.path(resolve(dirname(chosen),str(cardDoc?.acceptance))));
  const prompt = promptFile ? project.read.text(promptFile) || "" : "", acceptance = acceptanceFile ? project.read.text(acceptanceFile) || "" : "";
  const pathsChanged = changedPaths(project,chosen,changed), selected = array(task.e2e).map(object);
  const touchedFeatures = new Set(ids(prompt + "\n" + acceptance,"F"));
  if (chosen && map.length) for (const row of selected) if (typeof row.id === "string" && !map.some(s=>s.id === row.id)) {
    hint("card-scenario-mismatch",`卡上场景 ${row.id} 未在功能地图登记，核对是否是新增或写错编号`,ref(chosen),false,row.id);
  }
  for (const s of map) {
    if (functions.some(f=>f.id === s.feature && f.status === "已删除") && !s.reverseOf.includes(s.feature || "")) continue;
    const affected = pathsChanged?.paths.filter(p=>s.modules.some(m=>matches(p,m))) || [];
    const required = !s.modules.length || affected.length || [s.feature || "",...s.dependencies,...s.reverseOf].some(f=>touchedFeatures.has(f));
    if (!chosen || !required || !cardDoc) continue;
    const selectedByCard = selected.some(e => e.id === s.id && (!Array.isArray(e.paths) || !!pathsChanged?.paths.some(p=>strings(e.paths).some(m=>matches(p,m)))));
    if (!selectedByCard && !(!Array.isArray(task.e2e) && ids(prompt,"S").includes(s.id))) hint("possibly-unselected",`${s.id} 可能漏选（${affected.join("、") || (s.reverseOf.length ? "删除时复查反向场景" : "无所属模块：默认必跑") }）`,s.source);
  }

  const cfgPath = project.path(".autoreview.json"), cfg = project.read.doc(cfgPath), deploy = object(cfg?.deploy);
  const deferred = object(project.config.deferred), rows: {id:string; group:string; status:string; message:string; source:Ref}[] = [];
  const report = (i:number,id:string, ok:boolean, file:string, note:string, defaultReason = "") => {
    const reason = str(deferred[id]).trim() || defaultReason;
    rows.push({id,group:groupNames[i],status:ok ? "齐备" : reason ? "暂缓" : "缺少",message:ok || !reason ? note : `${reason}（${note}）`,source:ref(file)});
  };
  const executable = (raw:unknown) => {
    const s = str(raw), file = s && !s.startsWith("/") && !s.split("/").includes("..") && project.read.get(cfgPath,()=>project.path(s));
    const stat = file ? exists(file) : undefined;
    return !!stat?.isFile() && !!(stat.mode & 0o111);
  };
  report(0,"config",!!cfg,cfgPath,cfg ? "已登记本机跑法" : "无可读 .autoreview.json");
  const locals = strings(cfg?.localFiles);
  report(0,"localFiles",!!locals.length && locals.every(s=>!!project.read.get(cfgPath,()=>entry(project.root,project.path(s)))),cfgPath,"配置及本机文件是否齐备（不读内容）");
  report(0,"setup",!!str(cfg?.setup).trim(),cfgPath,"准备命令 setup");
  report(0,"deploy",executable(deploy.cmd) && ["check","rollback"].every(k=>deploy[k] === undefined || executable(deploy[k])) &&
    (!strings(cardDoc?.flow).includes("部署") || executable(deploy.check) && executable(deploy.rollback)),cfgPath,"部署脚本及已登记 check / rollback 是否存在并可执行");
  report(0,"test",!!str(task.test).trim() && !/^无\s*[:：]/.test(str(task.test)),chosen || project.setting("batches","docs/batches"),str(task.test).startsWith("无") ? "卡上声明："+str(task.test) : "本批开发卡 test 命令（只读，不执行）");
  const review = project.path("REVIEW.md");
  report(1,"review",!!project.read.text(review)?.trim(),review,"项目评审依据","需求第五节：尚无回查候选，REVIEW.md 暂缓");
  report(1,"featureMap",map.length > 0,mapFile,`${map.length} 条可识别场景`);
  report(1,"seeds",!!exists(seeds)?.isFile() || project.read.list(seeds).some(e=>!e.name.startsWith(".")),seeds,"种子数据位置（未运行）");
  const criteria = acceptance.trim() || sections(prompt).find(b=>b.title === "验收标准")?.body.trim();
  report(1,"acceptance",!!criteria,acceptanceFile || promptFile || chosen || project.root,"验收标准（独立文件或提示词的验收标准节）");
  const manual = project.read.text(skill) || "";
  const operations = [["up", "启动", "准备"],["ready", "就绪"],["reset", "重置", "隔离", "临时"],["down", "清理", "停止"]].filter(keys=>!keys.some(k=>manual.includes(k))).map(keys=>keys[0]);
  report(2,"verifySkill",!!manual && !operations.length,skill,manual ? `操作手册${operations.length ? "缺跑法："+operations.join(" / ") : "（启动 / 就绪 / 重置 / 清理）"}` : "未找到 verify skill");
  report(2,"scripts",!!map.length && scriptsOK === map.length,mapFile,`${scriptsOK}/${map.length} 条场景有匹配脚本（只查登记与文件，不执行）`);
  const agents = project.path("AGENTS.md"), issueDir = project.setting("issues","issues"), batchDir = project.setting("batches","docs/batches");
  report(3,"agents",!!project.read.text(agents)?.trim(),agents,"项目 AGENTS.md");
  report(3,"issues",!!exists(issueDir)?.isDirectory(),issueDir,"本项目问题单目录");
  const batchHome = [batchDir, project.path("loop-cards")].find(f=>exists(f)?.isDirectory());
  report(3,"batches",!!batchHome,batchHome || batchDir,"批次目录（兼容 loop-cards）");
  return {card:chosen || null, featureList:listFile, featureMap:mapFile, affectedPaths:pathsChanged || null, checklist:rows, advice};
}
