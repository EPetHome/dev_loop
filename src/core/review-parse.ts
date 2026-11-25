const sections=(output:string)=>Object.fromEntries(
  [...output.matchAll(/^##[ \t]+([^\r\n]+)\r?$([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/gm)].map(m=>[m[1].trim(),m[2].trim()]));
export function originalReview(output:string) {
  const parts=sections(output), titles=Object.keys(parts).filter(k=>/^结论\s*[:：]/.test(k)), body=parts.必修;
  if (titles.length!==1 || body===undefined) return;
  const verdict=titles[0].split(/[:：]/)[1].trim(), items=body.split(/\r?\n/);
  const mustFix:string[]=[]; for (const line of items) {
    const item=/^\s*\d+[.、)）]\s*(\S.*)$/.exec(line);
    if (item) mustFix.push(item[1]); else if (line.trim() && mustFix.length) mustFix[mustFix.length-1]+=" "+line.trim();
  }
  if (!(verdict==="通过" && body==="无" || verdict==="需返修" && mustFix.length)) return;
  const questions=parts.需求疑问 || "", blocker=questions.split(/\r?\n/).filter(line=>/^\s*(?:[-*]|\d+[.、])?\s*(?:\*\*)?阻断\s*[:：]/.test(line)).join("\n");
  return {mustFix,blocker,questions,minor:parts.小问题 || ""};
}
export function parseReview(output:string): {ok:true; review:NonNullable<ReturnType<typeof originalReview>>} | {ok:false;error:string} {
  const review=originalReview(output);
  if (!review) return {ok:false,error:"结论与「## 必修」缺失、不完整或不一致"};
  if (review.mustFix.some(s=>! /[^\s:：]+:\d+(?:-\d+)?/.test(s) || !/触发\s*[:：]/.test(s))) return {ok:false,error:"每条必修须有 文件:行 和 触发：条件"};
  return {ok:true,review};
}
