import { parseReview } from "../src/core/review-parse.ts";

// 覆盖输入是操作、初始状态与终点观察，不含历史结论和预期评审档位。
export type Probe = {id:string; operation:string};
export type Focus = {key:string; title:string; paths:string[]; probes:Probe[]; reference?:string};
const probe = (id:string,operation:string): Probe => ({id,operation});
const install = "agent/src/upgrade/install.rs", desktop = "agent/src/desktop/mod.rs", upgrade = "agent/src/upgrade/mod.rs";
const nsi = "agent/scripts/promate-x64.nsi", uninstall = "agent/src/upgrade/install/uninstall.rs";
const installDir = "agent/src/upgrade/install";

const b1: Record<number,Focus[]> = {
  1: [
    {key:"login",title:"正常启动与就绪",paths:[desktop,"agent/src/desktop/macos.rs",install],probes:[
      probe("P01","A3：Mac 用户重新登录，由登录项启动守护；守护启动主应用后退出。核对主进程是否仍可运行、设备是否能继续处理下发。"),
      probe("P03","A4：升级后，新版本能跑独立自检，但日常工作进程初始化没有成功。追到何时确认成功、何时清理旧版和最终可运行版本。"),
    ]},
    {key:"resume",title:"中断恢复与文件系统",paths:[install,upgrade],probes:[
      probe("P02","A4：替换前的升级准备已持久化，此时进程退出；重启时暂存内容损坏。核对从恢复入口到实际装入内容的完整性与失败结果。"),
      probe("P04","A4：合法、可写的 Mac 安装目录与用户数据分处不同卷。跟一次下载、替换失败、重启到下一次检查；记录版本及在线状态。"),
    ]},
    {key:"windows",title:"卸载、信任轮换和受管安装",paths:[nsi,install,"agent/scripts/package-release.py","agent/src/agent.rs"],
      // 摘录原卡直接引用的 2.4.4 §6；只补合同依据，不引入外链整页后续改动。
      reference:"B1 提示词引用《详细设计-Promate重构》2.4.4 第 6 条：『助手里内置两把公钥，现用的和备用的；万一现用的私钥泄露，用备用的私钥签一版新助手，把公钥换掉。』",
      probes:[
      probe("P05","A3：Windows 已接收网页卸载并清完本机数据，最后移除程序文件之前/期间遇到占用或中断。核对续卸登记何时清除、重启后能否接手续卸以及实际删除对象。"),
      probe("P06","A4 和本卡签名设计：Windows 用备用钥匙发布一次合法换钥，再用换入钥匙发布下一合法升级。分别核对工作进程与真正应用升级的验证方使用的信任来源。"),
      probe("P07","本卡明确要求不能写系统安装目录时提示 IT：标准账号遇到不可写的受管位置。追踪诊断最终到谁，正常使用者实际能看到什么。"),
    ]},
  ],
  3: [
    {key:"mac",title:"恢复中的文件及安装身份",paths:[install,desktop],probes:[
      probe("P08","A4：恢复时暂存 DMG 位于能被外界变动的位置。比较核验和挂载实际消费的文件对象是否绑定为同一份，以及不一致时的结果。"),
      probe("P09","A1/A3/A4：旧升级有恢复事务，用户手动换入合法安装再启动。追踪事务身份的每个分支和最终能否启动、上线。"),
    ]},
    {key:"install",title:"Windows 安装与卸载断点",paths:[nsi,uninstall],probes:[
      probe("P10","A2/A3：卸载器已被移除，清理辅助程序之前进程中止或文件占用；随后普通用户重试安装。核对可用的清理入口和最终可安装性。"),
      probe("P11","A2：标准用户首次安装，写入初批程序文件后、安装登记和卸载器写完之前中断，原样重跑安装器。追踪残留识别和可恢复性。"),
    ]},
  ],
  4: [
    {key:"identity",title:"未确认事务的对象与归属",paths:[install,desktop],probes:[
      probe("P12","A4：Mac 安装 A 正在等待升级确认，仍要保留旧版用于回退；此时启动另一目录中已存在的合法安装 B。逐步核对 A 的事务、备份和后续恢复入口。"),
      probe("P13","A4：Mac 应用目录仍是待确认的新版本目录，但包内主程序的文件身份变化。分别核对安装位置、包和内部程序的身份，追到启动、回退或拒绝。"),
    ]},
    {key:"precreated",title:"首装目的地的数据边界",paths:[nsi,uninstall,`${installDir}/provisioning.rs`],probes:[
      probe("P14","A2：Windows 当前用户首装，无旧卸载计划；用户或 IT 已建空安装目录，并设有自己的权限或目录附带数据。追踪普通首装及残留接管对现有目录对象的读写删除。"),
    ]},
  ],
  5: [
    {key:"ready",title:"健康确认与同次回退",paths:[install,desktop],probes:[
      probe("P15","A4：工作进程已报初步就绪；随后守护做磁盘上的完整性复核。分别走工作进程在复核期间仍存活与等待超时退出的两支，追到备份清理与版本结论。"),
      probe("P16","A4：试运行的应用仍在已换入的目录，复核结果不一致，本机旧备份完整。追到这一次守护返回前实际的回退、重启与最终可用版本。"),
    ]},
    {key:"reinstall",title:"旧位置的状态与当前更新",paths:[install,upgrade],probes:[
      probe("P17","A4：已移除旧位置 A 的安装，但它留有待确认事务；另一位置的合法安装 B 日常使用，收到有效升级或最低版本要求。核对恢复和普通更新入口对状态目录的选取、是否仍能更新。"),
    ]},
  ],
  6: [{key:"confirm",title:"不同进程的确认与持久化次序",paths:[`${installDir}/startup.rs`,upgrade,install],probes:[
    probe("P18","A4：工作进程写入正式就绪标记，守护和工作进程继续并发。按标记可见、工作进程对父目录落盘、守护提交成功及改名的顺序分别检查谁先谁后、最终进程是否存活及备份是否保留。"),
  ]}],
};

const acceptance = "code/agent/src/acceptance.ts", expiry = "code/agent/src/acceptance-expiry.ts";
const coord = "code/agent/src/coordination.ts";
const w3c: Focus[] = [
  {key:"decisions",title:"体验清单、反馈和授权主路径",paths:[acceptance,expiry,"历史依赖/W3-A/tools/coordination/acceptance.ts"],probes:[
    probe("P21","验收 2、4：同项目一批有人工条目、另一批只有机器项或没验收文件；先看实际发的待验清单，不带批次名或引用回复「都通过」。逐批核对展示、候选选择、写回及台账。"),
    probe("P22","验收 3：本人对 A1 反馈通过，A2 以后再看；然后满七天或同项目下一次开工。分别沿两个到期入口找到反馈保存位置、双方传递的数据、最后发出的明细及写入验收文件的字节。"),
    probe("P23","验收 2、3：有正式的「本人已做：A3」答复，验收文件没有另记；核对协调工具的查询、PA 的计数和实际提醒。与「同意授权但还没做」区分。"),
  ]},
  {key:"boundary",title:"恢复和读写边界的依据",paths:[coord,"code/agent/src/start-work.ts","code/agent/src/files.ts","code/agent/src/config.ts","历史依赖/W3-A/tools/coordinate.ts","历史依赖/W3-A/tools/coordination/write-plan.ts"],probes:[
    probe("P24","验收 5：区别协调进程不可用后重试、收单成功后重投、协调工具已接管原件但应用到一半时中断。核对原命令恢复能力在哪个入口提供，任务是否指定必须从 PA 开工入口接管第三种现场。"),
    probe("P25","验收 1 和权限边界：只查显示授权项目的复盘预览。检查直接文件工具的拒读配置与经本人授权的复盘报告的权限关系；要判越权须找到实际适用于这条链和接收者的拒读对象，而非预设存在这样的生产配置。"),
    probe("P26","验收 5：正式收单前核对拟改文件，同时定位实际会写的协调计划、原件和收据目录。核对本批的已知授权约定，区分已有明确禁止和没有说明的新位置。"),
  ]},
];

export function focuses(name: string,round: number): Focus[] {
  if (name === "B1") return b1[round] ?? [];
  return name === "W3-C" && round === 1 ? w3c : [];
}

export function focusMaterial(focus: Focus) {
  return ["## 静态覆盖操作", `本次独立覆盖的是「${focus.title}」。仅审这些操作及必要的直接代码链，保留原审查范围和必修门槛。逐条独立判断，不把题目当成已知缺陷，不要求凑条数。上轮必修的复查不能代替本次操作。历史验收和所给版本是依据，不读其他评审报告或未固定版本的外链。`,
    `定位入口（相对于本次导出目录）：${focus.paths.map(p=>"`"+p+"`").join("、")}。`,
    ...(focus.reference ? [`历史合同摘录：${focus.reference}`] : []),
    ...focus.probes.map(({id,operation})=>`- ${id}：${operation}`),
    "仍用标准五个标题。相关必修的「问题：」后紧跟实际覆盖编号（方括号格式 `[P编号]`），位置、触发和代码因果照常写。小问题、需求疑问在对应条目里也写相同方括号编号。结论标题下对每个编号另写一行 `覆盖 P编号：必修/小问题/需求疑问/未发现/未验证 — 一句代码依据`（斜线中的档位只选一个）。档位不能只报在覆盖行。"].join("\n\n");
}

// 成功口径不进入评审材料，轮次和出处只用于报告对照。
export const acceptanceTargets: Record<string,{label:string; kind:"must"|"nonblocking"; fact:string}> = {
  P01:{label:"#082",kind:"must",fact:"登录守护退出使主应用随进程组终止"},
  P02:{label:"#083",kind:"must",fact:"恢复安装遗漏对实际装入内容的完整性核验"},
  P03:{label:"#084",kind:"must",fact:"独立自检过早成功，正常启动失败却已丢回退副本"},
  P04:{label:"#085",kind:"must",fact:"跨卷替换反复下载重启，旧版不保持可用"},
  P05:{label:"#086",kind:"must",fact:"清除标记早于实际删除，中断后失去续卸，删除对象未可靠绑定"},
  P06:{label:"#087",kind:"must",fact:"Windows 守护仍用旧信任集，拒绝下一合法升级"},
  P07:{label:"#088",kind:"must",fact:"受管安装失败的 IT 提示只写日志，用户不可见"},
  P08:{label:"#089",kind:"must",fact:"校验与挂载未使用同一份 DMG"},
  P09:{label:"#090",kind:"must",fact:"手动换包后旧事务持续阻断正常启动"},
  P10:{label:"#091",kind:"must",fact:"尾段续卸被移除、残留挡住重装"},
  P11:{label:"#092",kind:"must",fact:"首装中断留下半成品，原安装器无法重试"},
  P12:{label:"#093",kind:"must",fact:"另一合法副本归档了原安装的未确认事务，失去回退"},
  P13:{label:"#094",kind:"must",fact:"包内主程序变化后直接普通启动而非核验或回退"},
  P14:{label:"#095",kind:"must",fact:"Windows 首装误删 IT 预建空目录及其权限或附带数据"},
  P15:{label:"#096",kind:"must",fact:"工作进程超时退出后仍确认升级成功并删备份"},
  P16:{label:"#097",kind:"must",fact:"已发现完整性不一致却没有在同次调用回退"},
  P17:{label:"#098",kind:"must",fact:"旧位置事务阻断当前合法安装升级"},
  P18:{label:"#099",kind:"must",fact:"正式确认与目录改名竞态使工作进程失败、守护假成功并清理备份"},
  P21:{label:"A3.1",kind:"must",fact:"都通过为未列出的批次写入通过"},
  P22:{label:"A3.2",kind:"must",fact:"到期收单将已回复的逐项反馈写成无反馈"},
  P23:{label:"A3.3",kind:"must",fact:"本人已做仍算入需试数"},
  P24:{label:"A3.4",kind:"nonblocking",fact:"下游半完成计划是否要求从上游开工接管"},
  P25:{label:"A3.5",kind:"nonblocking",fact:"只查的派生预览是否适用所假定的禁读范围"},
  P26:{label:"A3.6",kind:"nonblocking",fact:"协调收据目录是否在获准写入范围内"},
};

export function reviewSection(stdout: string, heading: string) {
  const headings = [...stdout.matchAll(/^##(?!#)[^\S\r\n]+(.+?)[^\S\r\n]*\r?$/gm)];
  const index = headings.findIndex(h=>h[1] === heading);
  if (index < 0) return "";
  const h = headings[index];
  return stdout.slice(h.index+h[0].length,headings[index+1]?.index).trim();
}

type Mark = {id:string; grade:string; note:string};
export function coverageCheck(stdout: string, probes: Probe[]) {
  const parsed = parseReview(stdout), must = parsed.ok ? parsed.review.mustFix : [], marks: Mark[] = [];
  const heading = /^## 结论[：:][ \t]*(通过|需返修)[ \t]*\r?$/m.exec(stdout)?.[0]?.trim();
  if (heading) {
    const notes = reviewSection(stdout,heading.slice(3));
    for (const m of notes.replace(/[`*]/g,"").matchAll(/^[ \t]*(?:-[ \t]*)?覆盖[ \t]+(P\d{2})[ \t]*[：:][ \t]*(必修|小问题|需求疑问|未发现|未验证)[ \t]*[—–-]+[ \t]*([^\r\n]+)$/gm)) {
      marks.push({id:m[1],grade:m[2],note:m[3].trim()});
    }
  }
  return probes.map(({id})=>{
    const target = acceptanceTargets[id], matching = marks.filter(m=>m.id === id), mark = matching.length === 1 ? matching[0] : undefined;
    // 中文评审偶尔用同义的龟甲括号；仍须是条目中的完整编号，不能只靠覆盖总结认领。
    const tagged = (text: string) => text.includes(`[${id}]`) || text.includes(`〔${id}〕`);
    const items = must.flatMap((item,index)=>tagged(item) ? [index+1] : []);
    const consistent = parsed.ok && heading?.endsWith(must.length ? "需返修" : "通过");
    let ok = false;
    if (consistent && mark?.note && target) {
      ok = target.kind === "must" ? mark.grade === "必修" && items.length > 0 :
        !items.length && (["小问题","需求疑问"].includes(mark.grade) && tagged(reviewSection(stdout,mark.grade)) || mark.grade === "未发现");
    }
    return {id,target,grade:mark?.grade ?? "覆盖行缺失或重复",note:mark?.note ?? "",items,ok};
  });
}
