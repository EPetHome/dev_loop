// Isolated replacement for a project's existing test command.
const fs = require("node:fs"), path = require("node:path");
const root = process.env.LOOP_TASK_DIR, dir = process.env.LOOP_E2E_DIR;
const mode = fs.existsSync(path.join(root,"mode")) ? fs.readFileSync(path.join(root,"mode"),"utf8") : "pass";
const plan = JSON.parse(fs.readFileSync(path.join(dir,"plan.json"),"utf8"));
const {executionId, attempt, commit} = plan;
const report = {executionId, attempt, commit, unit:"通过", scenarios:[]};
const evidence = (name,value) => { fs.writeFileSync(path.join(dir,name),value); return [name]; };
const error = "connect ECONNREFUSED 127.0.0.1:45121 (fake notifier)";
let exit = 0;
fs.appendFileSync(path.join(root,"order"), "test\n");
const messages = mode === "only-stop" ? ["T17 已停下"] : mode === "duplicate-notice" ? ["T17 已完成", "T17 已完成"] : ["T17 已停下", "T17 已完成"];
for (const [i, scene] of plan.scenarios.entries()) {
  let status = "通过";
  const steps = [];
  for (const [j, check] of scene.checks.entries()) {
    const item = {id:typeof check === "string" ? check : check.id, status:"通过", actual:typeof check === "string" ? "已到达" : check.expected};
    if (item.id === "同一任务完成通知") {
      item.actual = messages.filter(text => text.endsWith("已完成")).length;
      if (item.actual !== 1 && mode !== "lying-assertion") { item.status = status = "失败"; exit = 1; }
    }
    item.evidence = evidence(`s${i}-${j}.txt`, JSON.stringify(messages));
    if (mode.startsWith("env") && scene.dependencies?.includes("fake notifier")) {
      const productError = mode === "env-product-log", raw = productError ? "ENOENT: open delivered/status.json" : error;
      const probe = `s${i}-probe.json`, diagnostic = {executionId,attempt,commit,dependency:"fake notifier",result:"不可用",error:raw};
      if (mode === "env-fake-error") diagnostic.error = "wrong raw";
      if (mode === "env-probe-ready") diagnostic.result = "就绪";
      if (mode === "env-probe-other") diagnostic.dependency = "different dependency";
      if (mode === "env-probe-stale") diagnostic.attempt = "older-attempt";
      Object.assign(item,{status:"未验证",actual:productError ? "产品未写出状态文件：" + raw : "隔离通知服务连不通，尚未运行产品",
        cause:"外部环境",dependency:"fake notifier",error:raw,probe,evidence:evidence(probe,productError ? raw : JSON.stringify(diagnostic))});
      if (mode === "env-undeclared") item.dependency = "product app";
      status = "未验证"; exit = 75;
    }
    steps.push(item);
    if (status !== "通过") break;
  }
  report.scenarios.push({id:scene.id,status,steps});
}
const first = report.scenarios[0];
if (mode === "env-check-gap") first.steps.push({id:"重启不再通知",status:"通过",actual:"无额外通知",evidence:evidence("restart.txt","T17: no extra notification")});
if (mode === "lying-assertion") first.steps.find(step => step.id === "同一任务完成通知").actual = 2;
if (mode === "missing-scene") report.scenarios.pop();
if (mode === "extra-scene") report.scenarios.push({...first,id:"not-in-plan"});
if (mode === "repeat-scene") report.scenarios.push(first);
if (mode === "missing-check") first.steps.pop();
if (mode === "repeat-check") first.steps.push(first.steps[0]);
if (mode === "wrong-commit") report.commit = "different-commit";
if (mode === "wrong-attempt") report.attempt = "different-attempt";
if (mode === "wrong-execution") report.executionId = "different-execution";
if (mode === "absolute") first.steps[0].evidence = [path.join(dir,"s0-0.txt")];
if (mode === "outside") first.steps[0].evidence = ["../../status.json"];
if (mode === "symlink") {
  fs.symlinkSync(root,path.join(dir,"linked-root"));
  first.steps[0].evidence = ["linked-root/status.json"];
}
if (mode === "hardlink") {
  fs.linkSync(path.join(root,"order"),path.join(dir,"hardlink.txt"));
  first.steps[0].evidence = ["hardlink.txt"];
}
if (mode === "missing-evidence") first.steps[0].evidence = ["not-created.txt"];
if (mode === "unit-skipped") report.unit = "跳过";
if (mode === "env-unit-skipped") report.unit = "未验证";
if (mode === "env-unit-failed") report.unit = "失败";
if (mode === "env-product-failed") { const last = report.scenarios.at(-1); last.status = last.steps[0].status = "失败"; last.steps[0].actual = "actual product failure"; }
if (mode === "env-wrong-code") exit = 0;
if (mode === "rewritten-plan") fs.writeFileSync(path.join(dir,"plan.json"),JSON.stringify({...plan,scenarios:[]}));
if (mode === "no-report") process.exit(exit);
const publish = () => {
  fs.writeFileSync(path.join(dir,"report.tmp"), JSON.stringify(report));
  fs.renameSync(path.join(dir,"report.tmp"),path.join(dir,"result.json"));
  process.exit(exit);
};
if (mode === "hold") {
  // Simulate a started scenario with no complete result. Tests release via a file event.
  fs.writeFileSync(path.join(dir,"report.tmp"), "{\"executionId\":");
  const go = path.join(root,"test-go");
  const watch = fs.watch(root, () => { if (fs.existsSync(go)) { watch.close(); publish(); } });
  fs.writeFileSync(path.join(root,"test-started"), attempt);
  if (fs.existsSync(go)) { watch.close(); publish(); }
} else publish();
