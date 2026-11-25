/** JSON Pointer 路径不会混淆含点、斜杠的键；不解释指标含义。 */
export function compare(before: unknown, after: unknown): string[] {
  const flatten = (value: unknown, path = "", out = new Map<string,string>()) => {
    const entries = value !== null && typeof value === "object" ? Object.entries(value) : [];
    if (!entries.length) out.set(path || "/",JSON.stringify(value));
    else for (const [key,v] of entries) flatten(v,path+"/"+key.replaceAll("~","~0").replaceAll("/","~1"),out);
    return out;
  };
  const a=flatten(before), b=flatten(after);
  return [...new Set([...a.keys(),...b.keys()])].sort().flatMap(path=>
    !a.has(path)?["新增 "+path+"："+b.get(path)]
      :!b.has(path)?["减少 "+path+"："+a.get(path)]
      :a.get(path)!==b.get(path)?["变化 "+path+"："+a.get(path)+" → "+b.get(path)]:[]);
}
