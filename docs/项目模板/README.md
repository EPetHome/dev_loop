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

## 验证闭环接入清单

新旧项目都可用 `node <dev-loop>/tools/coordinate.ts 体检 --project <项目根>` 盘点。结果是提示，不是开工条件。旧项目仍可使用 `loop-cards/`，非标准位置登记在项目根 `.dev-loop-coord.json`（[可用字段](../参考-运行细节.md#协调工具的输入和存档)）；问题单在外部共享目录的项目可写明原因暂缓，不把别的项目当输入。

| 类别 | 检查什么 |
|---|---|
| 跑得起来 | `.autoreview.json`：`localFiles`、`setup`、`deploy`；开发卡 `test`。按项目需要登记，未采用的项说明原因 |
| 判断依据 | `REVIEW.md`、功能地图、种子数据、提示词或卡上独立验收标准。没有回查候选的 `REVIEW.md` 暂缓 |
| 动手工具 | `verify` skill 提供启动、就绪、重置、清理跑法；功能地图逐条对应仓库内固定的 E2E 脚本 |
| 管理沉淀 | `AGENTS.md`、项目问题单目录、开发卡与批次目录。协调产物 `.dev-loop-coord/` 本机保存 |

功能清单「怎么验」可以是场景、定向测试、人工、需授权，或写清不能验证的原因。删除功能要登记验证旧行为消失的反向场景。不要为消掉体检提示改变用户已定预期、批准状态或部署事实。

## 谁负责

| 角色 | 负责 |
|---|---|
| 用户 | 拍板目标、取舍和验收标准；授权合入和推送；做业务验收和人工验收 |
| 协调方 | 写需求、方案、提示词和开发卡；启动 dev-loop；核对结果；维护基线和问题单 |
| 开发方（pi） | 在 dev-loop 建好的 worktree 里改代码、做定向自测，完成后运行 `bin/loop 交付` |
| dev-loop | 复测、调用独立评审、退回返修，按 commit 记录结论；不替代业务验收 |
