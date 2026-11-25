const { installMockKeychain, accessToken } = require('./helpers/test-env.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-temp-lifecycle-test-'));
const temporary = path.join(sandbox, 'temporary'), home = path.join(sandbox, 'home');
fs.mkdirSync(temporary); fs.mkdirSync(home);
os.tmpdir = () => temporary; os.homedir = () => home;
const modulePath = require.resolve('../dist/temporary-credentials');
const lifecycle = require(modulePath);
const marker = directory => path.join(directory, '.ags-temporary-owner.json');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function abandoned(body = '') {
  const source = `
    const fs=require('fs'),os=require('os'),cp=require('child_process');
    os.tmpdir=()=>${JSON.stringify(temporary)};os.homedir=()=>${JSON.stringify(home)};
    const api=require(${JSON.stringify(modulePath)});
    const directory=api.createTemporaryCredentials('import',{store:true});
    fs.writeFileSync(require('path').join(directory,'credential'),'fixture-secret');
    ${body}
    console.log(JSON.stringify({directory,pid:process.pid}));
  `;
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function rewriteOwner(directory, change) {
  const original = JSON.parse(fs.readFileSync(marker(directory), 'utf8'));
  fs.writeFileSync(marker(directory), JSON.stringify({ ...original, ...change }));
}

test('registered private directories can be removed normally; arbitrary paths cannot', () => {
  const directory = lifecycle.createTemporaryCredentials('quota');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(marker(directory)).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(directory, 'auth.json'), 'fixture-secret');
  assert.equal(lifecycle.removeTemporaryCredentials(home), false);
  assert.equal(lifecycle.removeTemporaryCredentials(directory), true);
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => lifecycle.createTemporaryCredentials('quota', { store: true }), /仅导入/);
});

test('startup reclaims a dead owner staging directory without touching account files or legacy directories', () => {
  const { directory } = abandoned();
  assert.equal(path.dirname(directory), path.join(home, '.agent-switcher'));
  const legacy = path.join(home, '.agent-switcher', '.import-legacy');
  const account = path.join(home, '.agent-switcher', 'codex', 'A');
  fs.mkdirSync(legacy); fs.mkdirSync(account, { recursive: true });
  fs.writeFileSync(path.join(account, 'auth.json'), 'keep-account');
  const result = lifecycle.reapTemporaryCredentials();
  assert.ok(result.removed.includes(directory));
  assert.ok(fs.existsSync(legacy));
  assert.equal(fs.readFileSync(path.join(account, 'auth.json'), 'utf8'), 'keep-account');
});

test('live or reused owner PIDs and an interrupted process launch are retained', () => {
  const live = abandoned().directory, launching = abandoned().directory;
  rewriteOwner(live, { pid: process.pid });
  rewriteOwner(launching, { launching: true });
  const result = lifecycle.reapTemporaryCredentials();
  assert.ok(result.retained.includes(live));
  assert.ok(result.retained.includes(launching));
  assert.ok(fs.existsSync(live)); assert.ok(fs.existsSync(launching));
});

test('a crash cannot reclaim credentials marked as awaiting write-back', () => {
  const { directory } = abandoned('api.markTemporaryCredentialsPending(directory);');
  const result = lifecycle.reapTemporaryCredentials();
  assert.ok(result.retained.includes(directory));
  assert.equal(fs.readFileSync(path.join(directory, 'credential'), 'utf8'), 'fixture-secret');
  const active = lifecycle.createTemporaryCredentials('quota');
  lifecycle.markTemporaryCredentialsPending(active);
  assert.equal(lifecycle.removeTemporaryCredentials(active), false);
  assert.ok(fs.existsSync(active));
  assert.equal(lifecycle.releaseTemporaryCredentials(active), true);
  assert.equal(fs.existsSync(active), false);
});

test('killing a Codex query with a fresh bearer leaves only a reclaimable read-only copy', () => {
  const bearer = accessToken('workspace', 'member', 'member@example.test', 'fresh', Math.floor(Date.now() / 1000) + 3600);
  const child = spawnSync(process.execPath, ['-e', `
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    os.homedir=()=>process.argv[1]; os.tmpdir=()=>process.argv[2];
    const { CodexAgent }=require('./dist/agents/codex'), agent=new CodexAgent();
    agent.queryLiveRpc=dir=>{ fs.writeSync(1,dir); process.kill(process.pid,'SIGKILL'); };
    const bearer=process.argv[3];
    agent.queryCredential(Buffer.from(JSON.stringify({refresh_token:'fixture-original',tokens:{account_id:'workspace',id_token:bearer,access_token:bearer,refresh_token:'fixture-original'}})));
  `, home, temporary, bearer], { encoding: 'utf8', timeout: 5000 });
  assert.ok(child.signal === 'SIGKILL' || (process.platform === 'win32' && child.status !== 0), child.stderr);
  const dir = child.stdout, file = path.join(dir, 'auth.json');
  const copy = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(copy).tokens.refresh_token, 'ags-refresh-disabled');
  assert.ok(!copy.includes('fixture-original'));
  assert.ok(!JSON.parse(fs.readFileSync(marker(dir))).pendingCommit);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  assert.ok(lifecycle.reapTemporaryCredentials().removed.includes(dir));
});

test('a new process cannot replay a lost agy request and can restore its sealed successor after TMPDIR is cleared', { skip: process.platform !== 'darwin' }, t => {
  installMockKeychain();
  const email = 'crash@example.test';
  const credential = token => Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: 'crash@example.test',
    token: { refresh_token: token, access_token: 'access-' + token, expiry: '2000-01-01T00:00:00Z' } }));
  const next = credential('successor-token');
  const blocked = lifecycle.createTemporaryCredentials('agy-quota');
  lifecycle.markTemporaryCredentialsPending(blocked, email, 'no-record', credential('no-record'));
  const fault = t.mock.method(fs, 'linkSync', () => { throw new Error('fixture storage unavailable'); });
  assert.throws(() => lifecycle.withTemporaryProcess(blocked, () => assert.fail('process launched without a durable intent')), /fixture storage unavailable/);
  fault.mock.restore();
  assert.equal(lifecycle.releaseTemporaryCredentials(blocked), true);
  function interrupted(token, output) {
    const directory = lifecycle.createTemporaryCredentials('agy-quota');
    lifecycle.markTemporaryCredentialsPending(directory, email, token, credential(token));
    lifecycle.withTemporaryProcess(directory, () => spawnSync(process.execPath, ['-e', ''], { detached: true }));
    if (output) lifecycle.recordAntigravityQuotaOutput(directory, email, output);
    fs.rmSync(directory, { recursive: true });
  }
  interrupted('lost-request');
  interrupted('completed-request', next);
  const store = path.join(home, '.agent-switcher');
  const records = fs.readdirSync(store).filter(n => n.startsWith('.antigravity-quota-'));
  assert.equal(records.length, 2);
  for (const name of records) {
    const bytes = fs.readFileSync(path.join(store, name));
    assert.ok(bytes.subarray(0, 18).equals(Buffer.from('AGS-CREDENTIALS-1\n')));
    assert.equal(bytes.includes(next), false);
  }
  const result = spawnSync(process.execPath, ['-e', `
    const os=require('node:os'), assert=require('node:assert/strict');
    os.homedir=()=>${JSON.stringify(home)}; os.tmpdir=()=>${JSON.stringify(temporary)};
    require(${JSON.stringify(require.resolve('./helpers/test-env.cjs'))}).installMockKeychain();
    const api=require(${JSON.stringify(modulePath)}), credential=${credential.toString()};
    const {recoverAntigravityQuota}=require(${JSON.stringify(require.resolve('../dist/antigravity-quota-recovery'))});
    const {antigravityAgent}=require(${JSON.stringify(require.resolve('../dist/agents/antigravity'))});
    const get=(id,token)=>api.pendingAntigravityQuota(id,token,credential(token));
    assert.throws(()=>get('crash@example.test','lost-request'),e=>e.diagnostic==='recovery-missing');
    const retry=api.createTemporaryCredentials('agy-quota');
    assert.throws(()=>api.markTemporaryCredentialsPending(retry,'crash@example.test','lost-request',credential('lost-request')),api.PendingQuotaConflict);
    assert.equal(get('different@example.test','lost-request'),undefined);
    assert.equal(get('crash@example.test','fresh-login'),undefined);
    assert.equal(get('crash@example.test','successor-token').alreadyStored,true);
    let stored=credential('completed-request');
    const recovered=recoverAntigravityQuota(antigravityAgent,'crash@example.test',stored,{
      read:()=>stored,write:bytes=>{stored=bytes;},
    });
    assert.deepEqual(recovered.bytes,credential('successor-token'));
    assert.deepEqual(stored,recovered.bytes);
    assert.equal(get('crash@example.test','completed-request'),undefined);
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('symlink directories, replaced markers and malformed ownership never authorize cleanup', () => {
  const directory = abandoned().directory;
  const destination = path.join(sandbox, 'unrelated');
  fs.renameSync(directory, destination); fs.symlinkSync(destination, directory, 'dir');
  const linkedMarker = abandoned().directory;
  fs.unlinkSync(marker(linkedMarker)); fs.symlinkSync(marker(destination), marker(linkedMarker));
  const invalid = lifecycle.createTemporaryCredentials('agy-quota');
  fs.writeFileSync(marker(invalid), 'null');
  assert.equal(lifecycle.pendingAntigravityQuota('other@example.test', 'other', Buffer.from('fixture')), undefined);
  const result = lifecycle.reapTemporaryCredentials();
  for (const item of [directory, linkedMarker, invalid]) assert.ok(result.retained.includes(item));
  assert.equal(fs.readFileSync(path.join(destination, 'credential'), 'utf8'), 'fixture-secret');
});

test('a live child process group survives its owner and blocks recovery', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  let childPid;
  const { directory } = abandoned(`
    const child=api.withTemporaryProcess(directory,()=>cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}));
    fs.writeFileSync(require('path').join(directory,'child-pid'),String(child.pid));child.unref();
  `);
  childPid = Number(fs.readFileSync(path.join(directory, 'child-pid')));
  t.after(() => { try { process.kill(-childPid, 'SIGKILL'); } catch {} });
  assert.ok(lifecycle.reapTemporaryCredentials().retained.includes(directory));
  process.kill(-childPid, 'SIGTERM');
  let reaped = false;
  for (let i = 0; i < 100; i++) {
    if (lifecycle.reapTemporaryCredentials().removed.includes(directory)) { reaped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(reaped, true);
});

test('normal cleanup also waits for a running child instead of deleting its credentials', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const directory = lifecycle.createTemporaryCredentials('login');
  const child = lifecycle.withTemporaryProcess(directory, () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true, stdio: 'ignore',
  }));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  assert.equal(lifecycle.removeTemporaryCredentials(directory), false);
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill(); await closed;
  assert.equal(lifecycle.removeTemporaryCredentials(directory), true);
});

test('cleanup failure cannot discard a successful token rotation', async t => {
  const { CodexAgent } = require('../dist/agents/codex');
  const agent = new CodexAgent();
  const original = Buffer.from(JSON.stringify({ tokens: {
    account_id: 'fixture-workspace', email: 'fixture@example.test', id_token: accessToken('fixture-workspace',undefined,'fixture@example.test'),
    access_token: accessToken('fixture-workspace',undefined,'fixture@example.test'), refresh_token: 'old',
  } }));
  const rotated = Buffer.from(original.toString().replaceAll('"old"', '"new"'));
  let directory;
  agent.queryLiveRpc = async dir => {
    directory = dir;
    fs.writeFileSync(path.join(dir, 'auth.json'), rotated);
    return { account: { email: 'fixture@example.test' }, rates: { rateLimits: { primary: { usedPercent: 10 } } } };
  };
  const originalRm = fs.rmSync;
  const failing = t.mock.method(fs, 'rmSync', (target, ...args) => {
    if (target === directory) throw Object.assign(new Error('busy directory'), { code: 'ENOTEMPTY' });
    return originalRm(target, ...args);
  });
  const result = await agent.queryCredential(original);
  assert.deepEqual(result.rotated, rotated);
  assert.equal(result.status.state, 'ok');
  assert.equal(result.temporaryDirectory, directory);
  assert.ok(fs.existsSync(directory));
  assert.equal(lifecycle.removeTemporaryCredentials(directory), false);
  assert.equal(lifecycle.releaseTemporaryCredentials(directory), false);
  failing.mock.restore();
  assert.equal(lifecycle.releaseTemporaryCredentials(directory), true);
});

test('an unchanged query is cleaned immediately but an unrecognized new credential is retained', async () => {
  const { CodexAgent } = require('../dist/agents/codex');
  const { CredentialChangedError } = require('../dist/credential-state');
  const agent = new CodexAgent();
  const original = Buffer.from(JSON.stringify({ tokens: {
    account_id: 'workspace', email: 'fixture@example.test', id_token: accessToken('workspace',undefined,'fixture@example.test'),
    access_token: accessToken('workspace',undefined,'fixture@example.test'), refresh_token: 'old',
  } }));
  let directory;
  agent.queryLiveRpc = async dir => { directory = dir; return { account: { email: 'fixture@example.test' } }; };
  const result = await agent.queryCredential(original);
  assert.equal(result.temporaryDirectory, undefined);
  assert.equal(fs.existsSync(directory), false);
  agent.queryLiveRpc = async dir => {
    directory = dir;
    fs.writeFileSync(path.join(dir, 'auth.json'), '{"unknown":"new-credential-format"}');
    return { account: { email: 'fixture@example.test' } };
  };
  await assert.rejects(agent.queryCredential(original), error => {
    assert.ok(error instanceof CredentialChangedError);
    assert.ok(error.message.includes(directory));
    return true;
  });
  assert.equal(lifecycle.removeTemporaryCredentials(directory), false);
  assert.ok(fs.existsSync(directory));
  lifecycle.releaseTemporaryCredentials(directory);
});
