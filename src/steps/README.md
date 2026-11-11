# 附加步骤

merge.ts、push.ts、deploy.ts 只引用 core 的对外函数和 infra，互相不引用。手工命令与自动收尾都由 cli 组合；核心只按 after.length / next 转入收尾，不调用附加步骤。
