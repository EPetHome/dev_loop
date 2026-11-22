import { APP_ROOT } from "../infra/paths.ts";
export function convention(t: {after?: string[]; executionId: string}): string {
  const loop=APP_ROOT+"/bin/loop", common="开发完成后运行 "+loop+" 交付；会话停下后自动复测、评审";
  const boundary = t.after?.length ? "，通过后自动收尾。不要手工合入、推送或部署。" : "。用户要求合入或部署时，只运行 "+loop+" 合入 "+t.executionId+" 或 "+loop+" 部署 "+t.executionId+"；命令报错就把原文告诉用户，不要现场编步骤。";
  return "本会话是本人已明确授权由 dev-loop 管理的开发卡；开发完成后按本批说明登记交付。\n"+common+boundary+"\n交付只提交并登记。";
}
