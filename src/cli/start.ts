import { readCard, InputError } from "../core/card.ts";
import { loadDeploy } from "../infra/config.ts";
import { gitTry } from "../infra/git.ts";
/** 整链预检在创建执行目录之前；不检查本批尚未写出的脚本。 */
export function validateStart(file: string): void {
  const seen = new Set<string>();
  for (let next: string | undefined = file; next;) {
    const {file:source,card,repo} = readCard(next); if (seen.has(source)) throw new InputError("next 接力链有环："+source);
    seen.add(source);
    if (card.next && card.after.length) throw new InputError("接力中间批不能写合入、部署或推送");
    if (card.after.includes("部署")) {
      let cfg: ReturnType<typeof loadDeploy>; try { cfg = loadDeploy(repo); } catch (e) { throw new InputError(String(e)); }
      if (!cfg?.cmd || !cfg.check || !cfg.rollback) throw new InputError("自动部署须登记 deploy.cmd、check、rollback");
    }
    if (card.after.includes("推送") && gitTry(repo, ["remote", "get-url", "origin"]).code) throw new InputError("flow 写推送但项目没有 origin");
    next = card.next;
  }
}
