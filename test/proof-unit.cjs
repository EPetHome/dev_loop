// 将 Node 自己的定向用例结果映射为证明报告；不从日志 grep 一个成功/失败字样。
const {run} = require('node:test');
const {inspect} = require('node:util');
const fs = require('node:fs');
const {join, resolve} = require('node:path');

async function main() {
  const dir = process.env.LOOP_PROOF_DIR;
  const {executionId,attempt,commit,testName} = JSON.parse(fs.readFileSync(join(dir,'plan.json'),'utf8'));
  const [pattern] = process.argv.slice(2), outcomes = [], observations = [];
  for await (const {type,data} of run({files:[resolve('test/proof-cases.cjs')],testNamePatterns:[new RegExp(pattern || '^原单重投$')]})) {
    if (type === 'test:pass' && !data.skip && !data.todo || type === 'test:fail') {
      outcomes.push({type,data}); console.log(type,data.name,data.details.error ? inspect(data.details.error) : '');
    }
    if (type === 'test:diagnostic' && data.message.startsWith('observation:')) observations.push(JSON.parse(data.message.slice('observation:'.length)));
    if (type === 'test:stdout') process.stdout.write(data.message);
    if (type === 'test:stderr') process.stderr.write(data.message);
  }
  const [{type,data} = {}] = outcomes, [{actual,expected} = {}] = observations;
  if (outcomes.length !== 1 || data.name !== testName || observations.length !== 1) {
    console.error('runner 未取得唯一目标断言：'+testName); process.exitCode = 1; return;
  }
  if (type === 'test:fail') {
    const {failureType,cause} = data.details.error;
    if (failureType !== 'testCodeFailure' || cause?.code !== 'ERR_ASSERTION' || !cause.message.startsWith(testName) || cause.actual !== actual || cause.expected !== expected) {
      process.exitCode = 1; return;
    }
    process.exitCode = 76;
  }
  const report = {executionId,attempt,commit,testName,expected,actual,status:type === 'test:pass' ? '通过' : '失败'};
  fs.writeFileSync(join(dir,'result.tmp'),JSON.stringify(report)); fs.renameSync(join(dir,'result.tmp'),join(dir,'result.json'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
