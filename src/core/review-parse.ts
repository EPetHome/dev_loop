/** 从旧 parseReview 复制标题/编号与续行解析；拒绝把残缺的必修正文当成通过。 */
export interface ParsedReview { mustFix: string[]; mustFixRaw: string; minor: string[]; questions: string[]; recheck: string[] }
export function parseReview(output: string): {ok: true; review: ParsedReview} | {ok: false; error: string} {
  const sections: {title: string; body: string}[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = /^##(?!#)\s+(.+?)\s*$/.exec(raw);
    if (m) sections.push({ title: m[1], body: "" });
    else if (sections.length) sections[sections.length - 1].body += raw + "\n";
  }
  const body = (title: string) => sections.find((s) => s.title === title)?.body.trim() ?? "";
  if (!sections.some((s) => s.title === "必修")) return { ok: false, error: "缺少「## 必修」标题" };
  const items = (value: string, pattern: RegExp) => {
    const out: string[] = [];
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim(), m = pattern.exec(line);
      if (m) out.push(m[1].trim());
      else if (line && out.length) out[out.length - 1] += " " + line;
    }
    return out;
  };
  const mustFixRaw = body("必修"), mustFix = items(mustFixRaw, /^\d+\.\s*(.*)$/);
  if (!mustFix.length && mustFixRaw !== "无") return { ok: false, error: "必修须为编号条目或「无」" };
  if (mustFix.some((s) => !/[^\s:：]+:\d+(?:-\d+)?/.test(s) || !/触发\s*[:：]/.test(s))) return { ok: false, error: "每条必修须有 文件:行 和 触发：条件" };
  const bullets = (s: string) => items(s, /^[-*]\s+(.*)$/).filter((s) => s !== "无");
  return { ok: true, review: { mustFix, mustFixRaw, minor: bullets(body("小问题")), questions: bullets(body("需求疑问")), recheck: bullets(body("上轮必修复查")) } };
}
