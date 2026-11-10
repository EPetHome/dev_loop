# dev-loop · 核心第 1 步

单任务：开发会话 → `交付` → 会话停下 → 复测 → 独立评审 → 返修或完成。
不合入、不推送、不部署，不读取旧 loop 的运行数据。

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
```

- 启动回执只表示已接收；worktree、localFiles、setup、开会话均在后台完成。Terminal 接收命令不算会话启动成功：后台会在 60 秒内确认本次会话的进程登记；启动失败/超时写 failed，并保留 `launch-*.log` 原始错误。
- 同一张卡有多个活动执行时，控制命令要求执行编号；可用 `--task 名` 核对任务名。
- 交付可用 `--text-file 文件` 代替 `--说明`，不在此命令里跑检查。
- 停止保留 worktree、分支和证据；放弃删除 worktree，保留本地分支和证据，不可原执行续跑。
- 达到退回上限后，`续跑` 给耗尽的步骤再一轮；原会话仍在时，不另开第二个会话，请在原会话继续输入。
- `启动 --派单编号 X --指令编号 Y` 保留派单编号，重复启动指令返回同一回执。其他带编号的 PA 指令、第 4 步的答复/能力声明尚未实现。

## 开发卡（version 1 不变）

文件引用相对卡文件目录，scope 相对仓库根目录。base 须为已有本地分支，不能是 main；target 只允许 dev（本步不会合入它）。

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
多任务/验收第 3 步支持，提交（合入）第 2 步支持；部署第 1–4 步均不做，启动时拒绝，不建执行目录。

## 项目配置

仓库根目录 `.autoreview.json`（可选）：

```json
{
  "localFiles": [".env.local"],
  "setup": "项目自己的依赖准备命令",
  "reviewerModel": "astra",
  "reviewerThinking": "xhigh",
  "reviewerCmd": "./reviewer.sh"
}
```

localFiles 建 worktree 后复制；setup 跑一次，失败保留原始输出并报失败，可修复环境后续跑。旧 preparation/gate/methods 不读。

未配置 reviewerCmd 时用 `pi -p`、全新会话、只读工具 `read,grep,find,ls`，关闭全局/项目扩展、MCP 和上下文文件发现。
配置 reviewerCmd 时，它是**可执行脚本的路径，不是 shell 命令串**，相对 worktree；参数为：`轮次 输入文件路径 本次会话编号`。标准输出按 `src/core/review-prompt.md` 的标题格式返回，标准错误保留原文。两次调用共享本轮时限。

## 数据与状态

默认 `~/.dev-loop/tasks/<ASCII 执行编号>/`，`LOOP_TASKS_ROOT` 覆盖根目录。
开发方优先用 `LOOP_TASK_DIR` 定位，无此变量时按当前目录匹配 worktree。

- `task.json`：启动时只写一次；`status.json`：原子重写、seq 每次递增、generation=1（不重建同一执行目录）。
- `checks.jsonl`：追加写检查结果与耗时；`instructions.jsonl`：已处理的启动指令。
- `summary.md`：一屏结论与开发/复测/评审/等你/dev-loop 自身耗时。
- 测试、评审原文在同目录；证据缺失不作废通过。

状态协议 `loop-status/1`，state 仅 `working/input_required/completed/failed/cancelled`。`查询 --all --brief --json` 一次返回 `{complete:true, executions:[状态报告...]}`，不调用 git 或模型。

通过资格只取 commit + 提示词内容哈希 + 验收标准内容哈希；当前两份输入从 task 中的源文件引用读取。聊天、原目录 AGENTS/CLAUDE、忽略产物、证据文件不参与资格判定。同 tree 再交付不造重复提交。

## 宿主边界

- pi：`bin/pi-dev` 默认 sol/max，显式加载权限扩展和 `src/hosts/pi.ts`，不加载旧 loop/Ponytail/其他扩展；`--session` 精确恢复。
- pi 会话启动后每 60 秒心跳，仅 working 时更新；最终停下边界可注入 custom_message 并请求继续。
- Claude/Codex：薄入口 `hosts/hook.ts`，处理 SessionStart、PostToolUse（至少间隔 60 秒）、Stop；不处理 UserPromptSubmit。插件 Stop 外层时限为 4900 秒，保留 100 秒开销余量；两项 timeoutMin 合计超过 80 分钟的卡会在启动前明确拒绝，可降低时限或改用 pi。pi 不受这个外层上限约束。
- 插件清单在 `plugins/dev-loop/`，**没有安装**。本步自动开终端只针对 pi；Claude/Codex 的真实插件加载没有验证，需手动接入 hook，其卡准备后转等你，不冒充已开会话。连续长时间不调工具的 hook 宿主没有定时心跳。
- 生产 pi 启动在 macOS Terminal；自动测试用 `LOOP_LAUNCH_CMD` 可执行替身（收到 pi-dev 参数，cwd=worktree，环境含 LOOP_TASK_DIR），绝不打开真实终端。

## 自检

```sh
cd /Users/Admin/Desktop/dev-loop
PATH=/Users/Admin/.hermes/node/bin:$PATH node --test test/*.test.ts
bash -n bin/loop bin/pi-dev
```

测试只在系统临时目录里创建仓库/提交；评审用脚本，宿主用模拟事件和假的 pi API，不调用真实模型。文件事件和模拟时钟替代固定 sleep。技术测试不等于真实宿主/业务验收。
