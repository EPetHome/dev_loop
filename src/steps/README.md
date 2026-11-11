# 附加步骤

merge.ts、push.ts、deploy.ts 只引用 core 的对外函数和 infra，互相不引用。合入后可选推送由 cli 组合调用；核心不自动触发附加步骤。
