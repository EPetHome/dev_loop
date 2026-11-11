import { join } from "node:path";
import { fixture, write } from "./helpers.ts";
import { deliver } from "../src/core/deliver.ts";
import { appendCheck, inputs, transition, type Task } from "../src/core/store.ts";
import { tree } from "../src/infra/git.ts";
/** 附加步骤只消费已有结论；直接准备记录，不调用评审或宿主。 */
export function reviewed(task: Task, commit: string, testResult = "通过") {
  const h = inputs(task), at = new Date().toISOString();
  for (const [step, result] of [["复测", testResult], ["评审", "通过"]]) appendCheck(task.dir, {
    commit, tree: tree(task.repo, commit), step, result, startedAt: at, endedAt: at, durationMs: 0,
    evidence: [], promptHash: h.promptHash, acceptanceHash: h.acceptanceHash,
  });
  transition(task.dir, "completed", "完成", "复测、评审通过", null);
}
export async function delivered(t: Parameters<typeof fixture>[0], options: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(t, options), task = await f.prepare();
  write(join(task.worktree, "src/app.txt"), "good delivered\n");
  const {commit} = deliver(task.dir);
  return {...f, task, commit};
}
