# dev-loop

单任务核心：开发会话 → `交付` → 会话停下 → 复测 → 独立评审 → 返修或完成。
合入、可选推送和部署是显式命令，不自动触发，不调用模型，不读取旧 loop 的运行数据。

## 运行

Node ≥22.19；`bin/loop` 默认用 `/Users/Admin/.hermes/node/bin/node`，可用 `LOOP_NODE` 覆盖。无需安装 npm 包或构建。

```sh
/Users/Admin/Desktop/dev-loop/bin/loop 启动 /绝对路径/开发卡.json --json
# 开发会话在后台创建的 worktree 中工作，完成后执行：
/Users/Admin/Desktop/dev-loop/bin/loop 交付 --说明 '做了什么、如何自测'
/Users/Admin/Desktop/dev-loop/bin/loop 查询 --all --brief --json
/Users/Admin/Desktop/dev-loop/bin/loop 续跑 <执行编号或卡路径> --json
/Users/Admin/Desktop/dev-loop/bin/loop 停止 <执行编号或卡路径> --json
/Users/Admin/Desktop/dev-loop/bin/loop 放弃 <执行编号或卡路径> --json
# 完成后按需执行（不会自动触发）：
/Users/Admin/Desktop/dev-loop/bin/loop 合入 <执行编号或卡路径> [--commit <sha>] [--接受未验证] --json
/Users/Admin/Desktop/dev-loop/bin/loop 合入 <执行编号或卡路径> --推送 --json
/Users/Admin/Desktop/dev-loop/bin/loop 部署 <执行编号或卡路径> [--commit <sha>] --json
```

- 启动回执只表示已接收；worktree、localFiles、setup、开会话均在后台完成。Terminal 接收命令不算会话启动成功：后台会在 60 秒内确认本次会话的进程登记；启动失败/超时写 failed，并保留 `launch-*.log` 原始错误。
- 同一张卡有多个活动执行时，控制命令要求执行编号；可用 `--task 名` 核对任务名。
- 交付可用 `--text-file 文件` 代替 `--说明`，不在此命令里跑检查。
- 停止保留 worktree、分支和证据；放弃删除 worktree，保留本地分支和证据，不可原执行续跑。
- 达到退回上限后，`续跑` 给耗尽的步骤再一轮；原会话仍在时，不另开第二个会话，请在原会话继续输入。
- `启动 --派单编号 X --指令编号 Y` 保留派单编号，重复启动指令返回同一回执。其他带编号的 PA 指令、第 4 步的答复/能力声明尚未实现。

## 合入与推送

`合入` 只合最后一次交付登记的 commit，目标固定为本地 dev，在 dev 的检出目录运行 `git merge --no-ff`。支持 dev 位于另一个 worktree；不改任务分支、不删任务 worktree、不碰 main。仅 abort 本次产生的冲突合并，不重试；执行前已有的未完成合并及手工解决内容不撤销，无关本地改动由 git 保留。

- `--commit` 可用短 sha，必须与最后交付相同，否则报「目标已变化」。
- 资格是同 commit、同提示词/验收标准哈希下的复测「通过」或「没验证」，以及评审「通过」。缺项逐条列出；明确加 `--接受未验证` 才放行并标注未验证。
- 提交信息为 `Merge <卡名>: reviewed <短sha>`，有缺项时为 `Merge <卡名>: unverified <短sha>`。已在 dev 上时不新建提交，结果「已在 dev」。
- 输出字段：`executionId`、`commit`、`devBefore`、`devAfter`、`result`、`unverified`、`seconds`、`worktree`、`revert`。`revert` 给出 `git -C '<dev 检出目录>' revert -m 1 <devAfter>`；已在 dev 且 dev 未检出时，后两项为空。
- 没有交付、版本不符、检查不足、dev 未检出等前置拒绝不写记录、不改阶段；合入结果（包括失败、已在 dev）写记录。

**推送默认关闭**，只有 `合入 --推送` 在合入成功或已在 dev 后执行：确认 origin → `git fetch --no-tags --prune origin` → 扫描 dev 上、origin 所有分支都没有的提交 → `git push --no-follow-tags origin <完整sha>:refs/heads/dev`。显式关闭 follow-tags，即使配置 `push.followTags=true` 也不推标签。不强推、不推其他分支、不拉取、不重试；先清理远端已删除分支的陈旧跟踪引用，避免把已删除的 dev 误报成「已推送」。刷新后的远端 dev 等于本地时直接返回「已推送」。

推送非 0 时只做一次 `git ls-remote origin refs/heads/dev`：远端等于目标则「已推送」，不等则「推送失败」，核对也失败则「推送结果不确定」并给出核对命令。网络命令默认时限 120 秒，核对最多 30 秒。成功的合入输出增加 `push` 结果；推送失败在错误的 `result` 中返回已执行的推送结果，合入记录仍然保留。

### 内置密钥扫描

逐提交只查新增行和新增文件，命中仅输出 `<短sha> <文件>:<行> <规则名>`，不输出内容；扫描命中或出错均不推送，没有放行开关。不做通用 `password=` 匹配。

| 规则名 | 格式 |
|---|---|
| 私钥 | 私钥 BEGIN 头（`-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}`） |
| AWS 访问密钥 | AKIA / ASIA 后接 16 位大写字母或数字，带单词边界 |
| GitHub 令牌 | gh[pousr]_ 后至少 36 位字母/数字；github_pat_ 后至少 50 位字母/数字/下划线 |
| sk- 类 API 密钥 | sk-，可带 ant- / proj-，后至少 20 位字母/数字/下划线/连字符 |
| Slack 令牌 | xox[abposr]- 后至少 10 位字母/数字/连字符 |
| Google API 密钥 | AIza 后接 35 位字母/数字/下划线/连字符，带单词边界 |
| .env 文件 | 新增 `.env` / `.env.*`；排除 `.env.example`、`.env.sample`、`.env.template` |

二进制跳过；合并提交本身不单扫，带入的普通提交逐个扫描。**人工解决合并冲突时新写入合并提交的内容扫不到**；dev-loop 自己遇到冲突会 abort，不生成这种提交。规则有限，不保证识别所有秘密。

## 开发卡（version 1 不变）

文件引用相对卡文件目录，scope 相对仓库根目录。base 须为已有本地分支，不能是 main；target 只允许 dev。

```json
{
  "version": 1, "name": "示例", "nature": "开发",
  "base": "dev", "target": "dev", "host": "pi",
  "flow": ["开发评审", "测试"],
  "tasks": [{
    "name": "任务", "prompt": "提示词.md",
    "scope": {"allow": ["src/**", "test/**"], "deny": ["src/private/**"]},
    "test": "node --test test/*.test.ts"
  }],
  "limits": {
    "测试": {"maxRepairs": 3, "timeoutMin": 20},
    "开发评审": {"maxRepairs": 4, "timeoutMin": 60}
  }
}
```

scope 也接受字符串数组；支持目录前缀、`*`、`**`、`?`。越界检测包含暂存、未跟踪、删除/重命名，以及开发方已经自行提交的改动。忽略文件不参与交付。

`无：原因` 的测试记为“没验证”后继续评审；省略 flow 的测试步骤且没有 test 时同样不伪造测试通过。
多任务/整合/验收尚不支持（第 3 步）。flow 不写「提交」「部署」：启动时仍明确拒绝、不建执行目录，完成后另用 `bin/loop 合入`、按需用 `bin/loop 部署`。

## 项目配置

仓库根目录 `.autoreview.json`（可选）：

```json
{
  "localFiles": [".env.local"],
  "setup": "项目自己的依赖准备命令",
  "reviewerModel": "astra",
  "reviewerThinking": "xhigh",
  "reviewerCmd": "./reviewer.sh",
  "deploy": {
    "cmd": "scripts/deploy.sh",
    "check": "scripts/deploy-check.sh",
    "rollback": "scripts/deploy-rollback.sh",
    "timeoutMin": 20
  }
}
```

localFiles 建 worktree 后复制；setup 跑一次，失败保留原始输出并报失败，可修复环境后续跑。旧 preparation/gate/methods 不读。

未配置 reviewerCmd 时用 `pi -p`、全新会话、只读工具 `read,grep,find,ls`，关闭全局/项目扩展、MCP 和上下文文件发现。
配置 reviewerCmd 时，它是**可执行脚本的路径，不是 shell 命令串**，相对 worktree；参数为：`轮次 输入文件路径 本次会话编号`。标准输出按 `src/core/review-prompt.md` 的标题格式返回，标准错误保留原文。两次调用共享本轮时限。

### 部署

未登记 `deploy` 默认关闭。`cmd` 必填，`check`、`rollback` 可选；三个值必须是仓库内普通可执行文件的相对路径，**不是 shell 命令串**。`timeoutMin` 为 1–240 的整数，默认 20，分别适用于每个脚本。部署命令读仓库根目录当前的登记，不读取启动时的配置快照；deploy 写错只影响部署，不影响启动。

`部署` 默认取本地 dev 当前 commit，`--commit` 可指定其他 commit；输出 `onDev` 表明它是否已在 dev 上。代码临时独立检出，登记的所有脚本必须在该 commit 中存在且可执行，否则清理检出后拒绝，不写记录。

脚本 cwd 是临时检出，环境变量：

- `LOOP_DEPLOY_COMMIT`：完整 sha。
- `LOOP_REPO`：项目仓库根目录。
- `LOOP_EVIDENCE_DIR`：本次部署的持久证据目录。
- rollback 另有 `LOOP_DEPLOY_FAILED=cmd` 或 `check`。

执行 cmd → 可选 check。cmd/check 失败或超时则运行一次已登记的 rollback；无重试，超时结束整个进程组。结果分别为「已部署」「已部署（未检查）」「部署失败，已回退」「部署失败，回退也失败」「部署失败，未回退」。不改 dev、不推送；部署副作用与健康判断由项目脚本负责。

输出字段：`executionId`、`commit`、`onDev`、`result`、`steps`（每项 `name/path/code/seconds/killed`）、`log`、`evidenceDir`、`seconds`。三个脚本完整输出写到执行目录的 `deploy-<短sha>-<本地时间>.log`，证据目录同名不带 `.log`；同秒重复时加数字后缀，避免覆盖。部署重复请求就是再运行一次。无论结果如何删除临时检出，清理失败只记日志、不覆盖脚本结果。失败退出码 1，错误 raw 是日志最后 40 行。

## 数据与状态

默认 `~/.dev-loop/tasks/<ASCII 执行编号>/`，`LOOP_TASKS_ROOT` 覆盖根目录。
开发方优先用 `LOOP_TASK_DIR` 定位，无此变量时按当前目录匹配 worktree。

- `task.json`：启动时只写一次；`status.json`：原子重写、seq 每次递增、generation=1（不重建同一执行目录）。
- `checks.jsonl`：追加写检查结果与耗时；`instructions.jsonl`：已处理的启动指令。
- `summary.md`：结论与开发/复测/评审/等你/dev-loop 自身耗时；做过的合入/推送/部署按首次出现顺序插在 dev-loop 自身之前，结果取最近一次，耗时累计。
- 合入/推送/部署每次结果追加到 `checks.jsonl`，含 commit、tree、输入哈希、开始/结束时间、毫秒数、证据与详情。
- 测试、评审原文在同目录；证据缺失不作废通过。

状态协议 `loop-status/1`，state 仅 `working/input_required/completed/failed/cancelled`。`查询 --all --brief --json` 一次返回 `{complete:true, executions:[状态报告...]}`，不调用 git 或模型。

合入/推送/部署通常不改 state：仅 state 为 completed 时更新阶段；其他 state 下只追加结果、不改阶段。唯一例外：「等你」时明确用 `合入 --接受未验证` 成功（含已在 dev），改为 completed，阶段「已合入」。失败的附加步骤不把 state 改成 failed。

命令成功 stdout 为 JSON；失败 stderr 为 `{error:{category,raw,result?}}`，退出码 1，`result` 保留已执行部分。运行 `bin/loop 帮助` 查看参数。

通过资格只取 commit + 提示词内容哈希 + 验收标准内容哈希；当前两份输入从 task 中的源文件引用读取。聊天、原目录 AGENTS/CLAUDE、忽略产物、证据文件不参与资格判定。同 tree 再交付不造重复提交。

## 宿主边界

- pi：`bin/pi-dev` 默认 sol/max，显式加载权限扩展和 `src/hosts/pi.ts`，不加载旧 loop/Ponytail/其他扩展；`--session` 精确恢复。
- pi 会话启动后每 60 秒心跳，仅 working 时更新；最终停下边界可注入 custom_message 并请求继续。
- pi 另外每秒读状态，有变化刷新底部 `dev-loop【<阶段>】<任务名> · <附加信息>` 和标题 `【<阶段>】<任务名>`；无附加信息时不带分隔符。评审显示「第 N 轮」，等你显示原因，失败显示错误类别，附加步骤显示短 sha / 结果原因。无 UI 时不调用界面接口，关闭时清理定时器和状态栏。Claude/Codex 不做阶段显示。
- Claude/Codex：薄入口 `hosts/hook.ts`，处理 SessionStart、PostToolUse（至少间隔 60 秒）、Stop；不处理 UserPromptSubmit。插件 Stop 外层时限为 4900 秒，保留 100 秒开销余量；两项 timeoutMin 合计超过 80 分钟的卡会在启动前明确拒绝，可降低时限或改用 pi。pi 不受这个外层上限约束。
- 插件清单在 `plugins/dev-loop/`，**没有安装**。本步自动开终端只针对 pi；Claude/Codex 的真实插件加载没有验证，需手动接入 hook，其卡准备后转等你，不冒充已开会话。连续长时间不调工具的 hook 宿主没有定时心跳。
- 生产 pi 启动在 macOS Terminal；自动测试用 `LOOP_LAUNCH_CMD` 可执行替身（收到 pi-dev 参数，cwd=worktree，环境含 LOOP_TASK_DIR），绝不打开真实终端。

### 19 个阶段

`src/core/store.ts` 的 `PHASES` 按顺序固定为：

准备中、开发中、已交付、复测中、评审中、等你、完成、失败、已停止、已放弃、已合入、合入失败、推送中、已推送、推送失败、推送结果不确定、部署中、已部署、部署失败。

启动或工作区未就绪的续跑为「准备中」；交付成功且未沿用为「已交付」；交付后又改代码/自行提交则回「开发中」；放弃并删除工作区为「已放弃」，不能续跑。

`loop.wait` 只取四种原因：复测退回到上限、评审必修到上限、停下没交付、需手动接入会话。离开等你时清空；旧状态文件没有 wait 仍可读取，pi 用 message 第一行前 30 字补显原因。到上限后可运行 `bin/loop 续跑 <执行编号>` 再给一轮、停止，或 `bin/loop 合入 <执行编号> --接受未验证`。

## 自检

```sh
cd /Users/Admin/Desktop/dev-loop
PATH=/Users/Admin/.hermes/node/bin:$PATH node --test test/*.test.ts
bash -n bin/loop bin/pi-dev
```

测试只在系统临时目录里创建仓库/提交；origin 是本地裸仓库，部署、评审用脚本替身，宿主用模拟事件和假的 pi API，不调用真实模型、GitHub、服务或真实终端。文件事件和模拟时钟替代固定 sleep；超时注入毫秒数。技术测试不等于真实宿主/业务验收。

合入/推送/部署与阶段显示的验收测试：

| 条目 | 测试文件与断言 |
|---|---|
| A1 | `test/merge.test.ts`：dev 第二父提交是最后交付，输出前后 sha/秒数/撤销命令，评审与 pi 调用为零 |
| A2 | `test/merge.test.ts`：缺复测/评审逐条拒绝，dev 不变；哈希变化列明原因 |
| A3 | `test/merge.test.ts`：冲突原文、退出 1、abort 后 dev/索引/文件/status 恢复 |
| A4 | `test/push.test.ts`：不加 --推送，本地合入后裸仓库 dev 不变 |
| A5 | `test/push.test.ts`：显式推送后裸仓库 dev 等于本地，只更新 dev |
| A6 | `test/push.test.ts`：中间提交的合成密钥已删除仍拦截，仅输出中文路径/正确行号/规则名，不泄漏内容 |
| A7 | `test/deploy.test.ts`：cmd/check 各一次、commit/env 正确、完整日志、检出已删除 |
| A8 | `test/deploy.test.ts`：check 失败时 rollback 一次、FAILED=check、退出 1、已回退 |
| A9 | `test/hosts.test.ts`：注入定时器下已交付→复测中→评审中·第1轮→完成，状态栏/标题同步、外部变化刷新 |
| A10 | **未验证**：合入后的下一个任务在真实 pi 窗口人工观察，本批不验 |

方案补充用例分布在上述四个文件及 `test/core.test.ts`、`test/resilience.test.ts`；`test/dependencies.test.ts` 保持依赖方向与 src ≤2000 行约束。
