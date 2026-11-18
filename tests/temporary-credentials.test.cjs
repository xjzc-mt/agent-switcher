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

test('symlink directories, replaced markers and malformed ownership never authorize cleanup', () => {
  const directory = abandoned().directory;
  const destination = path.join(sandbox, 'unrelated');
  fs.renameSync(directory, destination); fs.symlinkSync(destination, directory, 'dir');
  const linkedMarker = abandoned().directory;
  fs.unlinkSync(marker(linkedMarker)); fs.symlinkSync(marker(destination), marker(linkedMarker));
  const invalid = abandoned().directory;
  rewriteOwner(invalid, { pid: 0, path: destination });
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
    account_id: 'fixture-workspace', email: 'fixture@example.test', access_token: 'old', refresh_token: 'old',
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
    account_id: 'workspace', email: 'fixture@example.test', access_token: 'old', refresh_token: 'old',
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
