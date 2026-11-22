const assert = require('node:assert/strict');
const fs = require('node:fs');
const {join} = require('node:path');
const {observe} = require('./proof-fixture-helper.cjs');

async function main() {
  const dir = process.env.LOOP_E2E_DIR;
  const {executionId,attempt,commit,scenarios:[scenario]} = JSON.parse(fs.readFileSync(join(dir,'plan.json'),'utf8'));
  const checkpoint = scenario.checks[0], actual = observe(), expected = 1;
  assert.equal(checkpoint.id,'原单重投');
  if (process.argv.includes('hold') && actual === 0) await new Promise(resolve => {
    const check = () => { if (fs.existsSync(join(dir,'go'))) { watcher.close(); resolve(); } };
    const watcher = fs.watch(dir,check);
    fs.writeFileSync(join(dir,'started'),''); check();
  });
  const status = actual === expected ? '通过' : '失败';
  const report = {executionId,attempt,commit,unit:'通过',scenarios:[{id:scenario.id,status,
    steps:[{id:checkpoint.id,status,actual,evidence:['替身记录.json']}]}]};
  fs.writeFileSync(join(dir,'替身记录.json'),JSON.stringify({actual,expected}));
  fs.writeFileSync(join(dir,'result.tmp'),JSON.stringify(report)); fs.renameSync(join(dir,'result.tmp'),join(dir,'result.json'));
  process.exitCode = status === '失败' ? 1 : 0;
  if (process.argv.includes('wrong-exit')) process.exitCode = 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
