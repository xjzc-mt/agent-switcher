const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { initializeDiagnostics, runDiagnostic, stepDiagnostic, resultDiagnostic, exportDiagnostics } = require('../dist/diagnostics');

function open(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ags-diagnostics-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  initializeDiagnostics(dir,'1.0.0+source');
  return dir;
}

test('concurrent traces export only approved fields, merging a repeated wait without swallowing the actual exception', async t => {
  const dir = open(t), secret = 'private@example.test';
  const wait = () => runDiagnostic('refresh','agy','automatic',secret, async () => {
    stepDiagnostic('access-expired'); stepDiagnostic(secret);
    resultDiagnostic('waiting','2026-01-01T00:00:00Z');
  });
  const error = new Error('private://token/' + secret);
  await Promise.all([wait(), assert.rejects(runDiagnostic('refresh','codex','manual','different-user',async () => {
    await Promise.resolve(); stepDiagnostic('query-start'); resultDiagnostic('timeout'); resultDiagnostic('failed'); throw error;
  }), actual => actual === error)]);
  await wait();
  const report = exportDiagnostics();
  assert.deepEqual(report.operations.map(r => [r.account,r.attempts,r.result,r.steps.map(s => s.step)]),
    [[1,2,'waiting',['access-expired']],[2,1,'timeout',['query-start']]]);
  assert.equal(report.operations[0].lastQuotaAt,'2026-01-01T00:00:00.000Z');
  assert.ok(report.operations[0].lastAttemptAt);
  for (const [specific, status] of [['cached','failed'],['unsupported','waiting']]) {
    await runDiagnostic('refresh','agy','manual',secret,async () => {
      resultDiagnostic(specific); resultDiagnostic(status);
    });
  }
  await assert.rejects(runDiagnostic('refresh','agy','manual',secret,async () => {
    resultDiagnostic('cached'); throw error;
  }), actual => actual === error);
  assert.deepEqual(exportDiagnostics().operations.slice(2).map(r => r.result), ['cached','unsupported','failed']);
  for (const content of [JSON.stringify(report),...fs.readdirSync(dir).map(f=>fs.readFileSync(path.join(dir,f),'utf8'))]) {
    assert.ok(!content.includes(secret) && !content.includes('different-user') && !content.includes('private://token') && !content.includes(dir));
  }
});

test('restart finds an interrupted trace, ignores unknown fields on disk and retains incident context after the recent window rolls', async t => {
  const dir = open(t);
  let finish;
  const old = runDiagnostic('switch','agy','manual','profile', () => {
    stepDiagnostic('credential-write'); return new Promise(resolve => { finish=resolve; });
  });
  const file = path.join(dir,fs.readdirSync(dir)[0]), data = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file,JSON.stringify({...data,unexpected:'private-field',steps:[...data.steps,{step:'private-field',at:Date.now()}]}));
  initializeDiagnostics(dir,'1.0.0+source');
  finish(); await old;
  for (let i=0;i<65;i++) await runDiagnostic('refresh','codex','automatic',undefined,async () => {});
  const records=exportDiagnostics().operations;
  assert.equal(records[0].result,'interrupted'); assert.equal(records[0].endedAt,undefined);
  assert.deepEqual(records[0].steps.map(s=>s.step),['credential-write']);
  assert.equal(records.length,50);
  assert.equal(fs.readdirSync(dir).length,records.length);
  assert.ok(!JSON.stringify(records).includes('private-field'));
  t.mock.timers.enable({apis:['Date'],now:Date.now()+8*86400000});
  assert.equal(exportDiagnostics().operations.length,0);
  assert.deepEqual(fs.readdirSync(dir),[]);
});

test('an unavailable diagnostics directory leaves the operation result intact',async t => {
  const dir = open(t), occupied = path.join(dir,'occupied');
  fs.writeFileSync(occupied,'fixture');
  initializeDiagnostics(occupied,'1.0.0+source');
  assert.equal(await runDiagnostic('refresh','agy','manual','profile',async () => 42),42);
  assert.deepEqual(exportDiagnostics().operations,[]);
});
