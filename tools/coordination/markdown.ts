import { ref, type Ref } from "./files.ts";

export type Block = { title: string; body: string; line: number; bodyLine: number; level: number };
export const plain = (s: string) => s.replace(/\*\*|`/g, "").trim();
export function sections(text: string): Block[] {
  const lines = text.split(/\r?\n/), headings: {title: string; index: number; level: number}[] = [];
  let fence = "";
  for (const [index, line] of lines.entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker.startsWith(fence)) fence = ""; continue; }
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) headings.push({title: plain(h[2]), index, level: h[1].length});
  }
  return headings.map(({title,index,level}, i) => ({title, level, line: index + 1, bodyLine: index + 2, body: lines.slice(index + 1, headings[i + 1]?.index).join("\n")}));
}
export function items(body: string, file: string, bodyLine: number): {text: string; source: Ref}[] {
  if (!body.trim() || /^(?:无|（无）|暂无)[。.]?$/.test(plain(body))) return [];
  const result: {text: string; source: Ref}[] = [];
  for (const [i, line] of body.split("\n").entries()) {
    if (!line.trim()) continue;
    const item = /^\s*(?:\d+[.)]|[-*+])\s+(.+)$/.exec(line);
    if (item || !result.length) result.push({text: item?.[1] || line.trim(), source: ref(file, bodyLine + i)});
    else result[result.length - 1].text += "\n" + line.trim();
  }
  return result;
}
export function field(text: string, label: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*+]\s+/, "").replaceAll("**", "").trimStart();
    if (!line.startsWith(label)) continue;
    const m = /^(?:\s*[:：]\s*|[\s　]+)(.+)$/.exec(line.slice(label.length));
    if (m) return m[1].trim();
  }
  return "";
}
export const links = (text: string) => [...text.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))\s*\)/g)].map(m => m[1] || m[2]);
export const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
