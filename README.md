# dev-loop

单任务核心：开发会话 → `交付` → 会话停下 → 复测 → 独立评审 → 返修或完成。
卡上约定的合入、部署、推送在评审通过后自动走完，不调用模型；未约定的卡保持完成即停。也支持显式命令，不读取旧 loop 的运行数据。

## 运行

Node ≥22.19；`bin/loop` 默认用 `/Users/Admin/.hermes/node/bin/node`，可用 `LOOP_NODE` 覆盖。无需安装 npm 包或构建。

```sh
/Users/Admin/Desktop/dev-loop/bin/loop 启动 /绝对路径/开发卡.json --json
# 开发会话在后台创建的 worktree 中工作，完成后执行：
/Users/Admin/Desktop/dev-loop/bin/loop 交付 --说明 '做了什么、如何自测'
/Users/Admin/Desktop/dev-loop/bin/loop 查询 --all --brief --json
/Users/Admin/Desktop/dev-loop/bin/loop 续跑 <执行编号或卡路径> [--话 文本 | --text-file 文件] --json
/Users/Admin/Desktop/dev-loop/bin/loop 续跑 <执行编号> --交付提交 <完整SHA> --json
/Users/Admin/Desktop/dev-loop/bin/loop 答复 <执行编号或卡路径> (--话 文本 | --text-file 文件) --json
/Users/Admin/Desktop/dev-loop/bin/loop 停止 <执行编号或卡路径> --json
/Users/Admin/Desktop/dev-loop/bin/loop 放弃 <执行编号或卡路径> --json
# 没有约定收尾的卡，完成后按需执行：
/Users/Admin/Desktop/dev-loop/bin/loop 合入 <执行编号或卡路径> [--commit <sha>] [--接受未验证] --json
/Users/Admin/Desktop/dev-loop/bin/loop 合入 <执行编号或卡路径> --推送 --json
/Users/Admin/Desktop/dev-loop/bin/loop 部署 <执行编号或卡路径> [--commit <sha>] --json
/Users/Admin/Desktop/dev-loop/bin/loop 收尾 <执行编号或卡路径> --json
/Users/Admin/Desktop/dev-loop/bin/loop 退回 <执行编号或卡路径> --json
/Users/Admin/Desktop/dev-loop/bin/loop 对比 <执行编号> [<另一个执行编号>] --json
/Users/Admin/Desktop/dev-loop/bin/loop 陪跑 <执行编号或卡路径> --json
# 已完成且未自动释放的执行，可按需手工释放：
/Users/Admin/Desktop/dev-loop/bin/loop 释放 <执行编号或卡路径> --json
```

- 启动回执只表示已接收；worktree、localFiles、setup、开会话均在后台完成。Terminal 接收命令不算会话启动成功：后台会在 60 秒内确认本次会话的进程登记；启动失败/超时写 failed，并保留 `launch-*.log` 原始错误。
- 同一张卡有多个活动执行时，控制命令要求执行编号；可用 `--task 名` 核对任务名。
- 交付可用 `--text-file 文件` 代替 `--说明`，不在此命令里跑检查；普通 `交付` 在「等你」时仍拒收。
- 停下时，HEAD 领先于起点（或上次登记），或有未提交文件，即有交付候选。三种宿主都按「完整 HEAD + 未提交路径集合」去重；同一路径同时出现在暂存区和工作区也只记一次。第一次提醒当前提交、上次登记（首次写「还没登记」）和交付命令；同一候选再停下转「等你 · 停下没交付」，不再催。旧回执不会给新提交放行。
- 查询给出「用当前提交交付」时，本人可运行 `续跑 <执行编号> --交付提交 <完整SHA>`，不得同时带话。程序在执行锁内重核等待原因、分支、HEAD、干净状态及自起点以来的累计文件范围；若不符，拒绝且保留现场和原回执。成功只登记该现有提交，不暂存、不造新提交；有有效检查就沿用，否则直接后台复测、评审，不等原会话再次停下。
- 停止保留 worktree、分支和证据；放弃删除 worktree，保留本地分支和证据，不可原执行续跑。
- 达到退回上限后，`续跑` 给耗尽的步骤再一轮；不带话时行为不变，原会话仍在就请在原会话继续输入。
- `续跑 --话 文本` / `--text-file 文件` 原文按接收顺序追加到 `loop.pendingReturn`，保留尚未交接的内容，各段之间仅加两个换行，不改每段原话、不设长度上限。Pi 原会话仍在时送进窗口并开新一轮，只送一次后清空；会话已退出时用原 session 文件重开，原话放进开场提示，不重复注入。带话明确回开发，但不删除或作废已有检查结论。Claude/Codex 交给下一次现有 hook；交接前再次处于「等你」时仍可继续答复，已接收的多段原话按序一并交接一次，不覆盖前文。状态和回执明确写「未送达，需在窗口里说」，不冒充主动唤起。空话或全空白拒收，不续跑。
- `答复` 只在「等你」时接收非空原话，追加带时间的答复记录后按带话续跑，送进开发会话的是 `本人答复：<原话>`。其他状态（含已停止、已放弃）拒收，不写答复记录。之后的评审输入按时间带全部「本人答复」，它们是本人开发途中的决定，和提示词冲突时按答复判；不改提示词、验收标准或它们的哈希，也不作废已有结论。
- 没有交付候选且本该在未交付处等待时，Pi 最后一条助手回复 `stopReason: "error"` 则改记「模型出错」，消息保留 `errorMessage` 原话；如果有候选，按上述停下规则判断，第二次停下在「停下没交付」的消息里保留原错。开发模型出错不另加自动重试。
- 评审调用「临时故障」失败后，若最后一次核心检查是「评审 / 失败」、HEAD 仍是最后交付 commit、工作区干净、提示词/验收标准哈希未变，且同 commit、同哈希下有复测「通过」或「没验证」，`续跑` 立即返回回执，在后台只补评审：不开开发会话、不重跑复测或留痕。失败调用不计一次退回；补评审通过后照常完成/收尾，必修照常返修。Claude/Codex 的后台必修先保留 `pendingReturn`，用已有「需手动接入会话」明确等待交接，不因原进程存活就假报 working；下一次已接入的 Stop hook 用 `decision:block` 返回必修，SessionStart/PostToolUse 则用 `additionalContext` 交接，之后才转开发中。宿主已空闲时需在原会话继续或重新接入，不冒充已主动唤起。任一条件不满足仍走原续跑逻辑；检查原文丢失不影响复用。
- `启动 --派单编号 X --指令编号 Y` 保留派单编号，重复启动指令返回同一回执。其他带编号的 PA 指令、能力声明尚未实现；答复已支持上述命令，但不支持指令编号去重。

## 自动收尾与接力

`flow` 必须以开发评审开头，是 `开发评审, 测试, 合入, 部署, 推送` 的不重复子序列；部署、推送均要求包含合入。不设项目默认走法。`提交` 请改写 `合入`，提交已由交付完成。

- `开发评审, 测试`：完成即停；加合入停在「已合入」；再加部署停在「已部署」；再加推送停在「已推送」。推送仅卡上写了才执行。
- 评审通过先转 working /「收尾中」，宿主拉起脱离会话的独立进程，关闭开发窗口仍继续。同一 commit 只自动发起一次；走完之前不报 completed。自动收尾绝不用「接受未验证」。
- 写到部署：先检查合入资格、用 `merge-tree` 试合并，再用真实索引/工作区做不写入的 Git 快进预检；只拦会阻碍快进的改动，无关本地改动保留。部署试合并 commit，成功后 dev 才快进；若期间新改动导致快进失败，在同一个项目队列内回退线上，保留 dev、用户文件和索引，转「等你」；回退失败也明确记录。需要 Git ≥2.38。仅合入的卡仍用 `merge --no-ff`。
- 同项目收尾、手工合入、部署、退回共用项目队列，等待不拒绝、心跳不停。`停止` 不杀正在运行的部署脚本，脚本及必要回退跑完后不进入后续步骤。
- 冲突、部署失败且已回退：Pi 收到原因继续返修；窗口不在时精确恢复会话。默认最多自动返修 2 轮，可用 `limits.部署.maxRepairs` 调整。修好新 commit 再走复测、评审、收尾，不原样自动重试。
- 回退也失败、返修耗尽、合入资格不足、推送失败，或 Claude/Codex 不能自动送回：转「等你」，原因为「收尾没走完」。`续跑` 回开发；`收尾` 可手工接手待收尾/收尾没走完的执行，也可直接接手留有死亡 finisher 身份的中断收尾，无须开发窗口再停一次。取执行锁后重读阶段、commit 和进程身份，再原子登记执行权；迟到的进程不能重复已完成的收尾；自动请求也不能把失败或中断当成手工接手，死亡进程不由宿主自动原样重试。收尾进行中不接受交付或续跑。
- 可选 `next` 相对卡目录指向下一张卡。启动前检查整条链（坏卡、环、中间批收尾都拒绝）；中间批正式复测、评审通过后不动 dev，下一批以该交付 commit 为起点、沿用派单号。`loop.next` 是已分配的执行编号；下一卡后台进程领取时持久写 `loop.launchStarted`，原卡收到领取后才完成。若分配后、领取前中断，手工 `收尾` 会补派同一执行；已经领取的不重复启动。领取不等于开发窗口已登记，下一卡的准备和启动结果单独查。最后一批才合入、部署。
- 卡上约定合入时，全部收尾步骤（含约定的部署、推送）成功后才[自动释放工作区](#留痕陪跑与释放)。无收尾的卡和接力中间批不自动释放；失败、退回或停止时也不释放。先登记 completed 和 `loop.releasePending`，再删工作区；这时若进程中断，手工 `收尾` 只补齐释放，不再执行合入、部署或推送。
- 收尾结束在卡目录追加 `结果.md`：版本、时间、dev 前后、证据、退回原因、恢复入口、验收标准位置。自动释放成功时，`结果.md` 和完成 message 均写明「工作区已释放」。完成 message 带同级其他目录 `验收.md` 第一行「状态：待验」的批次数。程序检查或部署成功不等于本人验收通过。

开发会话开场写明本卡已获本人授权由 dev-loop 管理、完成后登记交付，并给出实际命令。权限边界不变：有收尾时不要手工合入、推送、部署；无收尾时用户要求才运行命令，报错原文返回，不临时编部署步骤。

## 合入与推送

手工 `合入` 只合最后一次交付登记的 commit，目标固定为本地 dev，在 dev 的检出目录运行 `git merge --no-ff`。支持 dev 位于另一个 worktree；不改任务分支、不删任务 worktree、不碰 main。仅 abort 本次产生的冲突合并，不重试；执行前已有的未完成合并及手工解决内容不撤销，无关本地改动由 git 保留。

- `--commit` 可用短 sha，必须与最后交付相同，否则报「目标已变化」。
- 资格是同 commit、同提示词/验收标准哈希下的复测「通过」或「没验证」，以及评审「通过」。缺项逐条列出；明确加 `--接受未验证` 才放行并标注未验证。
- 提交信息为 `Merge <卡名>: reviewed <短sha>`，有缺项时为 `Merge <卡名>: unverified <短sha>`。已在 dev 上时不新建提交，结果「已在 dev」。
- 输出字段：`executionId`、`commit`、`devBefore`、`devAfter`、`result`、`unverified`、`seconds`、`worktree`、`revert`。`revert` 给出 `git -C '<dev 检出目录>' revert -m 1 <devAfter>`；已在 dev 且 dev 未检出时，后两项为空。
- 没有交付、版本不符、检查不足、dev 未检出等前置拒绝不写记录、不改阶段；合入结果（包括失败、已在 dev）写记录。

**手工推送默认关闭**，显式 `合入 --推送` 或卡上约定的推送步骤在合入成功或已在 dev 后执行：确认 origin → `git fetch --no-tags --prune --no-prune-tags --refmap= origin '+refs/heads/*:refs/remotes/origin/*'` → 扫描 dev 上、origin 所有分支都没有的提交 → `git push --no-follow-tags origin <完整sha>:refs/heads/dev`。显式关闭 follow-tags，即使配置 `push.followTags=true` 也不推标签。不强推、不推其他分支、不拉取、不重试；fetch 只清理 origin 的分支跟踪引用，关闭 prune-tags 并忽略配置的额外抓取映射，保留本地标签，同时避免把已删除的 dev 误报成「已推送」。刷新后的远端 dev 等于本地时直接返回「已推送」。

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
多任务/整合/验收尚不支持（第 3 步）。要一条龙收尾，将示例 flow 改为 `["开发评审", "测试", "合入", "部署", "推送"]`；链路示例：第一张写 `"next": "../第2批/开发卡.json"` 且不写收尾，最后一张才写合入以后的步骤。`after`、`next` 和限额在启动时存进 task.json，旧执行没有 after 按无收尾处理。

自动部署卡启动前必须登记 `deploy.cmd/check/rollback`，执行时也不能缺失；推送卡必须有 origin。不预查脚本文件（本批可能正是来添加脚本的），执行时在目标 commit 检出中检查。整链预检失败不建执行目录。

| 新增拒绝 | 需求「约定收尾一条龙」第十一节 |
|---|---|
| 自动部署缺 cmd / check / rollback | 第 1 行 |
| 推送没有 origin | 第 2 行 |
| 收尾中交付或续跑 | 第 3 行 |
| 接力链解析失败、有环、中间批收尾 | 第 4 行 |

此外仅有方案所列的无法执行：没有约定或不在待收尾、同执行收尾已在运行、非项目最新部署/没有回退脚本、未完成或已释放的工作区。字段格式校验沿用卡/配置的输入校验，不增加其他项目级门槛。

## 项目配置

仓库根目录 `.autoreview.json`（可选）：

```json
{
  "localFiles": [".env.local"],
  "setup": "项目自己的依赖准备命令",
  "reviewerModel": "astra",
  "reviewerThinking": "xhigh",
  "reviewerCmd": "./reviewer.sh",
  "snapshot": "scripts/snapshot.sh",
  "deploy": {
    "cmd": "scripts/deploy.sh",
    "check": "scripts/deploy-check.sh",
    "rollback": "scripts/deploy-rollback.sh",
    "timeoutMin": 20,
    "env": {"APP_DIR": "/path/to/app", "OBSERVE_MIN": "5"}
  }
}
```

开发 worktree 建好后复制 localFiles、运行 setup；setup 失败保留原始输出，可修正后续跑。正式复测和评审使用交付 SHA 的独立 detached worktree，不读开发工作区的后续改动。独立检出复制登记的 localFiles、运行 setup（输出 `check-setup-<sha>.log`），setup 与测试命令共用复测时限；可选留痕的检出、复制和脚本共用剩余复测时间。指向原检出内部的软链接在副本中改指副本对应文件；链接越界或无法解析时只记留痕失败，不运行脚本。准备超时也只记留痕失败，副本后台清理，不占用评审时限；评审仍读原源码和原产物。评审临时故障后保留该次复测检出和产物；符合补评审条件时复用它，不再跑 setup、复测或留痕。旧记录没有可用的原检出时，在同一 SHA 重建检出，不假造丢失的产物。正常结束或进入新检查时清理旧检出。命令使用所在检出，不依赖开发工作区的绝对路径。旧 preparation/gate/methods 不读。

未配置 reviewerCmd 时用 `pi -p`、全新会话、只读工具 `read,grep,find,ls`，关闭全局/项目扩展、MCP 和上下文文件发现；每次调用的 Pi 会话单独存在执行目录的 `review-sessions/<会话编号>/`。
配置 reviewerCmd 时，它是**可执行脚本的路径，不是 shell 命令串**，相对 worktree；参数为：`轮次 输入文件路径 本次会话编号`，会话目录见 `LOOP_REVIEW_SESSION_DIR`。标准输出按 `src/core/review-prompt.md` 的标题格式返回，标准错误保留原文。

评审材料保留提示词、验收标准和原有差异规则：「本轮改动」diff 排除被删文件，另在「删除的文件」列路径和原行数（空文件 0 行，二进制不适用行数）；返修轮按上次评审 commit 计算，需求变化则按任务起点计算。复测正文不嵌整份日志，只给命令、结果、能识别的通过/失败数和失败测试名、至多 20 行输出尾部，以及原文路径和实际字节数；整个摘要最多 8192 UTF-8 字节，超长单行也截断。未识别的计数不写作 0；原日志缺失不作废可沿用的检查。

评审临时故障可自动重试一次，两次调用共享本轮时限。若本次会话最后一条助手消息明确报上下文超限（如 Codex 上下文窗口或 Gemini 单次输入 token 上限），记「评审上下文超限」，查询 `error.raw` 返回模型原错并留下该次会话证据，不原样重投。限流、临时断连仍按原规则重试。

### 部署

未登记 `deploy` 默认关闭。`cmd` 必填，`check`、`rollback` 可选；三个值必须是仓库内普通可执行文件的相对路径，**不是 shell 命令串**。`timeoutMin` 为 1–240 的整数，默认 20，分别适用于每个脚本。部署命令读仓库根目录当前的登记，不读取启动时的配置快照；无自动部署 flow 的卡，deploy 写错仍不影响启动。`deploy.env` 可选：键匹配 `^[A-Z][A-Z0-9_]*$`，不能以 `LOOP_` 开头，值为字符串；覆盖宿主同名变量，框架 `LOOP_*` 优先。不放密钥，改值下次部署立即生效。

`部署` 默认取本地 dev 当前 commit，`--commit` 可指定其他 commit；输出 `onDev` 表明它是否已在 dev 上。代码临时独立检出，登记的所有脚本必须在该 commit 中存在且可执行，否则清理检出后拒绝，不写记录。

脚本 cwd 是临时检出，环境变量：

- `LOOP_DEPLOY_COMMIT`：完整 sha。
- `LOOP_REPO`：项目仓库根目录。
- `LOOP_EVIDENCE_DIR`：本次部署的持久证据目录。
- rollback 另有 `LOOP_DEPLOY_FAILED=cmd`、`check`、部署后快进失败补偿时的 `merge`，或手工退回时的 `manual`。

执行 cmd → 可选 check。cmd/check 失败或超时则运行一次已登记的 rollback；无重试，超时结束整个进程组。结果分别为「已部署」「已部署（未检查）」「部署失败，已回退」「部署失败，回退也失败」「部署失败，未回退」。不改 dev、不推送；部署副作用与健康判断由项目脚本负责。

输出字段：`executionId`、`commit`、`onDev`、`result`、`steps`（每项 `name/path/code/seconds/killed`）、`log`、`evidenceDir`、`seconds`。三个脚本完整输出写到执行目录的 `deploy-<短sha>-<本地时间>.log`，证据目录同名不带 `.log`；同秒重复时加数字后缀，避免覆盖。部署重复请求就是再运行一次。无论结果如何删除临时检出，清理失败只记日志、不覆盖脚本结果。失败退出码 1，错误 raw 是日志最后 40 行。

### 退回线上

`退回` 只允许项目最新一次成功部署的执行，运行该部署 commit 中登记的 rollback，收到当次原证据目录；成功阶段为「已退回」，清除项目最新部署记录。只换线上，**不动 dev，不用 git revert**；修复向前走。重复退回、没有 rollback 或不是最新部署均无法执行。手工部署仍不强制登记 rollback。

框架不实现项目迁移、备份、空闲检查或观察期，须由项目脚本负责；回退脚本不得用旧备份覆盖当前授权、设置等可变数据，应做反向转换。

## 留痕、陪跑与释放

`snapshot` 是可选仓库内普通可执行文件相对路径，不是命令串。未登记或目标 commit 没有脚本就跳过。脚本时限 5 分钟，写 JSON 对象到 `LOOP_SNAPSHOT_OUT`；`LOOP_SNAPSHOT_MODE=scenario` 跑固定替身场景，`live` 读线上指标。scenario 模式不得读写线上，由项目脚本负责保证。`TMPDIR` 是独立临时数据目录，完成即清理。失败只记「留痕 / 失败」，不改阶段或阻断任何流程。误输出目录会被清理，清理本身失败则一并记录原因，不向主流程传播。

每个时机的留痕脚本也拿到 `deploy.env`，和部署命令一样读项目仓库根目录当前的登记，不读启动时的配置快照。环境变量优先级从低到高：宿主环境 → `deploy.env` → 框架的 `LOOP_*` 和 `TMPDIR`；登记的同名 `TMPDIR` 不能覆盖框架的独立临时目录。没有 `deploy` 段时行为不变；`deploy` 登记不合法也只记留痕失败及原因，不阻断流程。

| 时机 | 模式 / 产出 |
|---|---|
| 开工，独立陪跑工作区，与开发同起点 | scenario → `snapshot-base.json` |
| 复测通过、评审之前，开发工作区 | scenario → `snapshot-<commit>.json`，文件清单和基线差异进入评审「运行差异」 |
| deploy.cmd 之前 / check 成功后 | live → 证据目录 `snapshot-before.json` / `snapshot-after.json` |

部署证据中的 `snapshot-static.json` 内置保存 commit、依赖锁摘要、上次部署至本次的文件清单。陪跑复制 localFiles、运行 setup，产出只进任务目录；无论成功失败移除自己创建的陪跑 worktree，失败只记「陪跑 / 失败」，不改 state。`陪跑` 可手工运行。

`对比 <执行>` 现场采 live，与该执行部署后的快照比；`对比 <执行> <另一执行>` 比两次部署后的快照。逐路径报新增、减少、变化，报告留在执行目录，不自动判断指标好坏；缺快照写「没有基线」。

自动、手工释放都先检查登记的开发 worktree：未跟踪（不含 Git 忽略文件）、已暂存或未暂存的改动均会阻止删除。用临时索引核对 Git 标记隐藏的修改，不改用户索引。释放成功时保留分支、日志和证据，写 `loop.released=true`，记「释放 / 已释放」，不改阶段。已释放不能续跑。

- 自动释放遇到未提交文件，仍正常完成，message 写「工作区有未提交文件，已保留」，在「释放 / 保留」中列出最多 20 个路径。删除出错则只记「释放 / 失败」及原始报错，不影响收尾结论。
- `释放` 仅在 completed 且未释放时可手工执行；有未提交文件则退出 1，列出路径，不删除、不写释放记录。存量或未登记的目录不自动清理。

## 数据与状态

默认 `~/.dev-loop/tasks/<ASCII 执行编号>/`，`LOOP_TASKS_ROOT` 覆盖根目录。
开发方优先用 `LOOP_TASK_DIR` 定位，无此变量时按当前目录匹配 worktree。

- `task.json`：启动时只写一次；`status.json`：原子重写、seq 每次递增、generation=1（不重建同一执行目录）。
- `checks.jsonl`：追加写检查结果与耗时；`instructions.jsonl`：已处理的启动指令。
- `answers.jsonl`：仅接收答复时创建、只追加；每行 `{at: ISO时间, text: 本人原话}`，换行按 JSON 转义，读取后原文不变。`loop.answerCount` 在所有公开状态（含 `--brief`）给出答复条数，旧执行没有记录时为 0；查询不回写。
- `summary.md`：结论与开发/复测/评审/等你/dev-loop 自身耗时；做过的合入/推送/部署按首次出现顺序插在 dev-loop 自身之前，结果取最近一次，耗时累计。
- 合入/推送/部署每次结果追加到 `checks.jsonl`，含 commit、tree、输入哈希、开始/结束时间、毫秒数、证据与详情。
- 测试、评审原文在同目录；证据缺失不作废通过。

状态协议 `loop-status/1`，state 仅 `working/input_required/completed/failed/cancelled`。`查询 --all --brief --json` 一次返回 `{complete:true, executions:[状态报告...]}`，不调用模型。仅对「等你 · 停下没交付」的执行只读查看 Git：当前在任务分支、工作区干净且 HEAD 是未登记的新提交时，公开查询（含 `--brief`）增加 `loop.deliveryConfirmation: {label, commit, command}`，其中 `commit` 为完整 SHA。其他状态或现场不提供；该字段不回写 `status.json`。

`loop.facts` 是可直接照抄的执行事实，所有公开查询（含 `--brief`）原样带出：

- `name`：卡上 `tasks[].name`，等于 task.json 的 `name`；`startedAt`：执行开始时间，等于 task.json 的 `createdAt`（ISO）。
- `resumes`：成功续跑次数（含本人确认交付），初始为 0；收尾、合入不计入。
- `stops`：最近 50 条停下记录。进入 `input_required/failed/cancelled` 时追加，每条包含 `at`（ISO）、`step`（停下前的 PHASES 阶段）、`state`、`reason`、`message`（当时原话，最多 200 字）、`resumedAt`、`resolvedBy`。
- `reason`：等你取 `loop.wait` 的六种原因；失败取 `error.category`；停止写「已停止」，放弃写「已放弃」。原因不随 `loop.wait` 清空而丢失。
- 未解开时 `resumedAt/resolvedBy` 为 null；成功续跑、收尾、`合入 --接受未验证` 离开停下状态时补上时间和去向。去向为「续跑 / 收尾 / 合入（接受未验证） / 停止 / 放弃 / 沿用通过记录」；若已有未解开的停下记录，进入新停下状态前先关闭旧记录，例如等你后停止，旧条目写「停止」。

没有 `facts` 的旧状态仍可读取、查询和续跑；查询不回写，下一次状态更新起补齐基本事实并开始记录，不倒推、编造旧的停下历史。

合入/推送/部署通常不改 state：手工执行仅 state 为 completed 时更新阶段；自动收尾登记 finisher 后可在 working 下更新阶段，仍维持 working 直到全程走完。其他 state 下只追加结果、不改阶段。唯一例外：「等你」时明确用 `合入 --接受未验证` 成功（含已在 dev），改为 completed，阶段「已合入」。失败的附加步骤不把 state 改成 failed。

命令成功 stdout 为 JSON；失败 stderr 为 `{error:{category,raw,result?}}`，退出码 1，`result` 保留已执行部分。运行 `bin/loop 帮助` 查看参数。

通过资格只取 commit + 提示词内容哈希 + 验收标准内容哈希；当前两份输入从 task 中的源文件引用读取。聊天、原目录 AGENTS/CLAUDE、忽略产物、证据文件不参与资格判定。同 tree 再交付不造重复提交。

## 防止空闲睡眠

macOS 只在执行 `working` 时持有防睡：Pi、准备/复测/评审/收尾用用户态 `caffeinate -i -t 120`，由现有的 60 秒心跳续期，干活进程崩溃/心跳中断后最长 120 秒失效。Claude/Codex 已登记的开发会话（含已交付待停下）改用 `caffeinate -i -w <宿主PID>`，绑定核对过启动时间的真实宿主进程；长工具调用或思考没有 hook 事件也持续生效，宿主退出时由 caffeinate 自行释放，不依赖下一次心跳。各执行独立持有，转等你、完成、失败、停止时主动释放；不新增常驻监控进程。仅阻止**空闲**睡眠，不阻止关屏或合盖睡眠，不改系统设置、不需管理员权限。防睡命令异常只在执行目录 `idle-sleep.log` 留原文，不阻断任务。

测试用 `LOOP_CAFFEINATE_CMD` 指向可执行替身（收到相同参数和 `LOOP_TASK_DIR`）；全套测试强制替身，绝不调用真实 `caffeinate`。真实机器断言由协调方在合入后的任务中检查。

## 宿主边界

- pi：`bin/pi-dev` 默认 sol/max，显式加载权限扩展和 `src/hosts/pi.ts`，不加载旧 loop/Ponytail/其他扩展；`--session` 精确恢复。
- pi 会话启动后每 60 秒心跳，仅 working 时更新；最终停下边界可注入 custom_message 并请求继续。
- pi 每秒读到 `pendingReturn` 时发送 custom message 并 `triggerTurn:true`，清除待送原因，无 UI 也生效。退出后重开的续跑原话用 `pendingOpening` 标记已放入开场，插件只清空待送，不再注入第二次。独立收尾进程每 60 秒心跳，`loop.finisher` 是其身份，`loop.afterCommit` 防止同 commit 重复自动发起。
- pi 另外每秒读状态，有变化刷新底部 `dev-loop【<阶段>】<任务名> · <附加信息>` 和标题 `【<阶段>】<任务名>`；无附加信息时不带分隔符。评审显示「第 N 轮」，等你显示原因，失败显示错误类别，附加步骤显示短 sha / 结果原因。无 UI 时不调用界面接口，关闭时清理定时器和状态栏。Claude/Codex 不做阶段显示。
- Claude/Codex：薄入口 `hosts/hook.ts`，处理 SessionStart、PostToolUse（至少间隔 60 秒）、Stop；不处理 UserPromptSubmit。插件 Stop 外层时限为 4900 秒，保留 100 秒开销余量；隔离 setup、复测和可选留痕不叠加独立预算。复测与评审两项 timeoutMin 合计超过 80 分钟的卡会在启动前明确拒绝，可降低时限或改用 pi。pi 不受这个外层上限约束。
- 插件清单在 `plugins/dev-loop/`，**没有安装**。本步自动开终端只针对 pi；Claude/Codex 的真实插件加载没有验证，需手动接入 hook，其卡准备后转等你，不冒充已开会话。连续长时间不调工具的 hook 宿主没有定时心跳，防睡按上一节绑定宿主进程，不以租约过期冒充任务停下。
- 生产 pi 启动在 macOS Terminal；自动测试用 `LOOP_LAUNCH_CMD` 可执行替身（收到 pi-dev 参数，cwd=worktree，环境含 LOOP_TASK_DIR），绝不打开真实终端。

### 21 个阶段

`src/core/store.ts` 的 `PHASES` 按顺序固定为：

准备中、开发中、已交付、复测中、评审中、等你、完成、失败、已停止、已放弃、已合入、合入失败、推送中、已推送、推送失败、推送结果不确定、部署中、已部署、部署失败、收尾中、已退回。

启动或工作区未就绪的续跑为「准备中」；交付成功且未沿用为「已交付」；交付后出现新候选时先提示并回「开发中」，同一候选下次停下转「等你」；放弃并删除工作区为「已放弃」，不能续跑。

`loop.wait` 只取六种原因：复测退回到上限、评审必修到上限、停下没交付、模型出错、需手动接入会话、收尾没走完。离开等你时清空；旧状态文件没有 wait 仍可读取，pi 用 message 第一行前 30 字补显原因。到上限后可运行 `bin/loop 续跑 <执行编号>` 再给一轮、停止，或 `bin/loop 合入 <执行编号> --接受未验证`。

## 自检

```sh
cd /Users/Admin/Desktop/dev-loop
PATH=/Users/Admin/.hermes/node/bin:$PATH node --test test/*.test.ts
bash -n bin/loop bin/pi-dev
```

测试只在系统临时目录里创建仓库/提交；origin 是本地裸仓库，部署、评审用脚本替身，宿主用模拟事件和假的 pi API，不调用真实模型、GitHub、服务或真实终端。macOS 测试若命中 `/usr/bin/git`，直接使用 `xcrun` 解析的同一 Git，避免每次调用都启动 shim。文件事件和模拟时钟替代固定 sleep；超时注入毫秒数。技术测试不等于真实宿主/业务验收。

续跑带话、模型出错和答复 A1–A10 的替身验证在 `test/resume-answer.test.ts`：活会话只送一次、退出后精确恢复且开场不重复、无话兼容、构造 Pi 结束原因与催交付规则、答复原文追加/计数/评审输入及哈希不变、非等你/空话拒收、Claude/Codex 未送达回执和真实 hook CLI 交接。未开真实模型或窗口，不代替飞书/PA 的业务验收。

停下事实与防睡批次 A1–A9 的替身验证在 `test/facts.test.ts`、`test/retry-review.test.ts`、`test/idle-sleep.test.ts`、`test/review-material.test.ts`，包括旧状态兼容、只补评审的条件回退、后台回执/返修/收尾、心跳租约与删除材料。A10 真实 `pmset -g assertions` **未验证**，由协调方在合入后执行；技术测试不替代本机验收。`test/idle-sleep.test.ts` 补 Claude/Codex 真实 hook 入口登记后超过 120 秒无事件仍防睡、等你和宿主退出释放；`test/hook-return.test.ts` 经真实 hook CLI 验证后台必修交接的 block/context 输出、只消费一次及后续修复交付，而非只断言状态字段。

链路入口 W1-A1 的替身验证见 `test/hosts.test.ts`、`test/delivery-entry.test.ts`、`test/review-material.test.ts`、`test/retry-review.test.ts`、`test/finish.test.ts`：首次及返修候选去重、本人确认和现场变化、长日志摘要、会话超限、通过后接力与开场授权（另见 `test/finish-recovery.test.ts`）。

本批一条龙 A1–A10 在 `test/finish.test.ts`：A1/A3/A8 自动部署与状态/去重，A2 只合入，A4/A5 失败回退和返修后推送，A6 回退失败，A7 接力。`test/finish-recovery.test.ts` 保留 A9 同项目排队、A10 手工退回及既有中断恢复用例，供全量并行调度。`test/companion.test.ts` 覆盖陪跑、运行差异、live 前后、对比和释放；`test/deploy.test.ts` 补 deploy.env。仅用替身，不代表真实线上或真实 Pi 窗口验收。

既有合入/推送/部署与阶段显示的验收测试：

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

方案补充用例分布在上述四个文件及 `test/core.test.ts`、`test/resilience.test.ts`；`test/dependencies.test.ts` 保持依赖方向与 src ≤2000 行约束。`src/steps/` 的合入、部署、推送互不引用，由 CLI 组合；核心只根据是否约定收尾或接力推进，不调用附加步骤。
