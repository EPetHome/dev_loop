# W2-E-两批移植到当前dev

## 目标

W2-A1+W2-A2（分支 `dev-loop/dev-loop-W2-A2---20261122-W2-A2--5d0717`，已含 W2-A1）和 W3-B（分支 `dev-loop/dev-loop-W3-B-Pi--20261122-W3-B-Pi-163aa3`）都已经复测、评审通过。但两个分支都是从旧 dev 拉出来的，和后来合入的 W3-A 在测试文件上冲突，`bin/loop 合入` 失败了。本批从当前 dev 出发，把这两个分支的改动原样搬过来，只解冲突。

## 已拍板

- 先搬 W2-A2 分支，再搬 W3-B 分支。用 git 合并即可，交付前不能停在合并到一半的状态。
- 两个分支原有的改动已经评审通过，本批不重新设计，也不重审。只处理：冲突、两批之间以及它们和 W3-A 交叉的地方、合并后出现的测试失败。
- 冲突的参考解法（W2-A2 和当前 dev 之间，协调方试合并时定下的；按这个解法跑全量，334 个用例里只有 1 个失败，原因是第 2 条说的重复 `until`）：
  1. `test/helpers.ts`：保留 W2-A2 的 `writeFixtureScript` 和轮询式 `until`，同时保留 dev 的 `fixture` 选项 `cliTimeoutMs`，以及 `until` 的第 5 个参数 `timeoutMs`（dev 的 `test/finish-helpers.ts` 用它传 `finishDeadlineMs`）。
  2. `test/finish-recovery.test.ts`：import 取两边的并集，但不要再从 `helpers.ts` 引入 `until`，因为 dev 已经有 `untilFinish as until`。
  3. `test/deploy.test.ts`：用 W2-A2 的 `.cjs` 脚本和 `direct` 选项，保留 dev 的 `cliTimeoutMs:45000` 和那行注释。
  4. `test/cli.test.ts`：用 W2-A2 的 setup 脚本和 `setup-finished` 闸门，保留 dev 的预热调用、5 秒计时断言、`loop.ready === false` 检查和 `cliTimeoutMs:30000`。
  5. `test/idle-sleep.test.ts`：用 W2-A2 的 `driver.event(event, pid, at?)`（基于 `until`）和只认 `checked` 的那一行，去掉 dev 的 `wait` 和 `pollAfter`。
  6. W3-B 的冲突（`test/finish-helpers.ts`、`test/finish-recovery.test.ts`、`test/helpers.ts`）按同样的原则处理：两边新加的都保留，行为以已经评审通过的分支为准。

## 边界

- 只解冲突，并让合并后的测试通过。不改 `src/` 的行为，不加功能，不顺手重构。
- 除了冲突处，交付内容要和两个分支逐行一致。
- 自测只跑上面列出的冲突文件，以及两个分支新增的测试文件。

## 验收标准

A1. 操作：在交付提交上运行 `PATH=/Users/Admin/.hermes/node/bin:$PATH node --test test/*.test.ts`
    预期：`# fail 0`
A2. 操作：把交付提交和当前 dev 比较 `src/` 下的差异，再和两个分支各自相对旧起点的 `src/` 改动对照
    预期：两个分支对 `src/` 的改动都在，没有多出来的 `src/` 改动；不一致的地方只出现在冲突处，并在交付说明里逐处写明
A3. 操作：比较交付提交和当前 dev 在 `README.md`、`docs/参考-运行细节.md`、`docs/写法-需求提示词与验收标准.md` 上的差异
    预期：两个分支对这三个文件的改动都在，W3-A 在这三个文件上的内容也没有丢
