# 项目模板：接入 dev-loop 的项目

> 迁自旧 loop 的 `项目模板/`，11-09 按 dev-loop 改写：去掉了开工、准备方法、门禁、合入队列、部署这些旧流程。

## 目录

| 文件 | 用途 |
|---|---|
| `项目根/AGENTS.md` | 协调方的项目规则模板，填好后放到项目根目录 |
| `项目根/CLAUDE.md` | 只引用 AGENTS.md |
| `项目根/.autoreview.json.示例` | 本机配置样板，替换占位内容后另存为 `.autoreview.json`，不进仓库 |
| `项目根/.gitignore.示例` | 本机才有的文件，写进项目的 `.git/info/exclude` 或项目的 `.gitignore` |

项目里推荐的文档位置：

- `docs/requirements/`：需求
- `docs/prompt/`：方案和提示词
- `docs/batches/<批次>/开发卡.json`：每批一张卡
- `docs/baseline/`：基线
- `issues/`：问题单

写法统一看 [写法](../写法-需求提示词与验收标准.md)，项目里不另写一份。

## 接入步骤

1. 项目要用 Git，并且有本地 `dev` 分支。
2. 把 `AGENTS.md`、`CLAUDE.md` 填好后放进项目根目录。
3. 按需写 `.autoreview.json`：`localFiles`、`setup`，评审模型和替身也写在这里。字段说明见 dev-loop 的 [README.md](../../README.md)。
4. 写需求、提示词和开发卡，然后执行 `/Users/Admin/Desktop/dev-loop/bin/loop 启动 <开发卡> --json`。
5. 用 `bin/loop 查询` 看状态。当前能用到哪一步，以 dev-loop README 为准。

## 谁负责

| 角色 | 负责 |
|---|---|
| 用户 | 拍板目标、取舍和验收标准；授权合入和推送；做业务验收和人工验收 |
| 协调方 | 写需求、方案、提示词和开发卡；启动 dev-loop；核对结果；维护基线和问题单 |
| 开发方（pi） | 在 dev-loop 建好的 worktree 里改代码、做定向自测，完成后运行 `bin/loop 交付` |
| dev-loop | 复测、调用独立评审、退回返修，按 commit 记录结论；不替代业务验收 |
