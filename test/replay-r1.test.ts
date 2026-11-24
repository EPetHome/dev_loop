import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptanceTargets, coverageCheck, focusMaterial, focuses, type Probe } from "../tools/replay-r1-cases.ts";

const p = (id: string): Probe => ({id,operation:"核对该操作的实际结果"});
function review(notes: string, must = "无", minor = "无", question = "无") {
  return [`## 结论：${must === "无" ? "通过" : "需返修"}`,notes,"## 必修",must,"## 小问题",minor,"## 需求疑问",question,"## 上轮必修复查","无"].join("\r\n");
}
const finding = (id:string) => `1. 位置：app.ts:3\n   触发：重启\n   问题：[${id}] 新状态没有写入\n   依据：重启读取旧值`;

test("R1 回放覆盖：B1 十八条只登记一次，W3-C 三条必修三条不挡交付，预期档位不进评审材料", () => {
  const plan = Array.from({length:6},(_,i)=>focuses("B1",i+1)).flat(), w3c = focuses("W3-C",1);
  assert.deepEqual(plan.flatMap(f=>f.probes.map(p=>acceptanceTargets[p.id].label)).sort(),Array.from({length:18},(_,i)=>`#0${i+82}`));
  assert.deepEqual(w3c.flatMap(f=>f.probes.map(p=>acceptanceTargets[p.id].kind)),["must","must","must","nonblocking","nonblocking","nonblocking"]);
  for (const f of [...plan,...w3c]) for (const {id} of f.probes) {
    assert(!focusMaterial(f).includes(acceptanceTargets[id].label));
    assert(!focusMaterial(f).includes(acceptanceTargets[id].fact));
  }
});

test("R1 回放覆盖：档位、有效位置触发和同一编号的实际必修必须同时成立", () => {
  const note = "覆盖 P01：必修 — 重启没有写入状态";
  const check = (output:string) => coverageCheck(output,[p("P01")])[0];
  const verified = check(review(note,finding("P01")));
  assert.equal(verified.ok,true); assert.deepEqual(verified.items,[1]);
  assert.equal(check(review(note,finding("P01").replace("[P01]","〔P01〕"))).ok,true);
  for (const bad of [review(note),review(note,finding("P02")),review(note,finding("P01").replace("app.ts:3","app.ts")),
    review(note+"\n"+note,finding("P01")),review("覆盖 P01：必修\n覆盖 P02：未发现 — 代码已核对",finding("P01")),
    review("无",finding("P01")).replace("无\r\n## 必修",`无\r\n## 必修\r\n${note}`)]) assert.equal(check(bad).ok,false);
});

test("R1 回放覆盖：不挡交付不是缺项；覆盖疑问与实际必修冲突时不通过", () => {
  const note = "覆盖 P25：需求疑问 — 缺少对报告接收者的授权约定", q = "- [P25] 报告是不是该策略约束的入口？";
  const check = (output:string) => coverageCheck(output,[p("P25")])[0];
  assert.equal(check(review(note,"无","无",q)).ok,true);
  assert.equal(check(review(note,"无",q)).ok,false);
  assert.equal(check(review(note,finding("P25"),"无",q)).ok,false);
  assert.equal(check(review("覆盖 P25：未验证 — 未取得范围资料")).ok,false);
  assert.equal(check(review("未输出覆盖标记")).ok,false);
});
