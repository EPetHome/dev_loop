/** 只从「必修」节提取阻断项；完整报告另存原文。 */
export function parseReview(output: string): {ok: true; review: {mustFix: string[]}} | {ok: false; error: string} {
  const headings = [...output.matchAll(/^##(?!#)[^\S\r\n]+(.+?)[^\S\r\n]*\r?$/gm)];
  const section = headings.findIndex(h => h[1] === "必修");
  if (section === -1) return {ok: false, error: "缺少「## 必修」标题"};
  const heading = headings[section], body = output.slice(heading.index + heading[0].length, headings[section + 1]?.index).trim();
  const mustFix: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim(), item = /^\d+\.\s*(.*)$/.exec(line);
    if (item) mustFix.push(item[1].trim());
    else if (line && mustFix.length) mustFix[mustFix.length - 1] += " " + line;
  }
  if (!mustFix.length && body !== "无") return {ok: false, error: "必修须为编号条目或「无」"};
  if (mustFix.some(s => !/[^\s:：]+:\d+(?:-\d+)?/.test(s) || !/触发\s*[:：]/.test(s))) return {ok: false, error: "每条必修须有 文件:行 和 触发：条件"};
  return {ok: true, review: {mustFix}};
}
