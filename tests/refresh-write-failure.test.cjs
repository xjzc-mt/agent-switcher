const { createTestHome, accessToken } = require('./helpers/test-env.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const home = createTestHome('ags-refresh-write-');
const accounts = require('../dist/accounts'), store = require('../dist/store'), utils = require('../dist/utils');
const { codexAgent: agent } = require('../dist/agents/codex');
const lifecycle = require('../dist/temporary-credentials');
const restore = new Set();
after(() => {
  for (const directory of restore) lifecycle.releaseTemporaryCredentials(directory);
  fs.rmSync(home, { recursive: true, force: true });
});
const auth = (id, rt) => {
  const bearer = accessToken(id, 'user', 'member@example.test', rt);
  return Buffer.from(JSON.stringify({ tokens: { account_id: id, id_token: bearer, access_token: bearer, refresh_token: rt } }));
};
const quota = { rates: { rateLimits: { primary: { usedPercent: 12 } } } };

test('failed quota metadata commit reports its error, rate limits retries, and later recovers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
  const name = 'metadata', dir = store.profileDir('codex', name);
  utils.atomicWrite(path.join(dir, 'auth.json'), auth(name, 'one'));
  const rpc = t.mock.method(agent, 'queryLiveRpc', async () => quota);
  const diskFault = t.mock.method(store, 'writeProfileMeta', () => { throw new Error('fixture metadata write failed'); });
  for (const force of [true, true, false]) {
    await assert.rejects(accounts.refreshAccount(agent, name, force), /fixture metadata write failed/);
  }
  assert.equal(rpc.mock.callCount(), 1);
  assert.equal(store.readProfileMeta('codex', name).snapshot, undefined);
  diskFault.mock.restore();
  t.mock.timers.tick(30000);
  assert.equal((await accounts.refreshAccount(agent, name, true)).state, 'ok');
  assert.equal(rpc.mock.callCount(), 2);
});

test('a verified access-token-only change keeps its recovery copy and permits retry after the write backoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
  const name = 'access-renewal', dir = store.profileDir('codex', name);
  const source = auth(name, 'same-refresh'), renewed = JSON.parse(source);
  renewed.tokens.access_token = accessToken(name, 'user', 'member@example.test', 'second-access');
  utils.atomicWrite(path.join(dir, 'auth.json'), source);
  let recovery;
  const rpc = t.mock.method(agent, 'queryLiveRpc', async directory => {
    if (!recovery) { recovery = directory; restore.add(directory); }
    utils.atomicWrite(path.join(directory, 'auth.json'), JSON.stringify(renewed));
    return quota;
  });
  const fault = t.mock.method(agent, 'writeCredentials', () => { throw new Error('write interrupted'); });
  await assert.rejects(accounts.refreshAccount(agent, name, true), /write interrupted/);
  assert.ok(fs.existsSync(recovery));
  fault.mock.restore();
  t.mock.timers.tick(30000);
  assert.equal((await accounts.refreshAccount(agent, name, true)).state, 'ok');
  assert.equal(rpc.mock.callCount(), 2);
});

for (const staged of [false, true]) {
  test(`uncommitted ${staged ? 'candidate' : 'ordinary'} exchange survives a new process without submitting its token again`, async t => {
    const name = staged ? 'candidate' : 'ordinary', dir = store.profileDir('codex', name);
    const file = path.join(dir, 'auth.json');
    utils.atomicWrite(file, auth(name, 'original'));
    if (staged) utils.atomicWrite(file + '.pending', auth(name, 'candidate'));
    const incoming = staged ? 'candidate' : 'original';
    let recovery;
    const rpc = t.mock.method(agent, 'queryLiveRpc', async directory => {
      recovery = directory;
      restore.add(directory);
      utils.atomicWrite(path.join(directory, 'auth.json'), auth(name, 'successor'));
      return quota;
    });
    const replace = utils.replaceFiles;
    const fault = t.mock.method(utils, 'replaceFiles', (directory, ...args) => {
      if (directory === dir) throw new Error('fixture credential write failed');
      return replace(directory, ...args);
    });
    await assert.rejects(accounts.refreshAccount(agent, name, true), error =>
      error.message.includes('fixture credential write failed') && error.message.includes(recovery));
    assert.equal(rpc.mock.callCount(), 1);
    assert.deepEqual(utils.readBuffer(file), auth(name, 'original'));
    assert.deepEqual(utils.readBuffer(path.join(recovery, 'auth.json')), auth(name, 'successor'));
    fault.mock.restore();

    const output = execFileSync(process.execPath, ['-e', `
      require('node:os').homedir = () => process.argv[1];
      require('./tests/helpers/test-env.cjs').installMockKeychain();
      const { codexAgent } = require('./dist/agents/codex');
      codexAgent.queryLiveRpc = () => { throw new Error('unexpected second exchange'); };
      require('./dist/accounts').refreshAccount(codexAgent, process.argv[2], true).then(
        status => process.stdout.write(JSON.stringify(status)), error => process.stdout.write(error.message));
    `, home, name], { encoding: 'utf8' });
    if (staged) assert.ok(output.includes(recovery));
    else {
      const waiting = JSON.parse(output);
      assert.equal(waiting.state, 'unverified');
      assert.match(waiting.extra, /仍在处理凭据/);
    }
    const marker = fs.readFileSync(path.join(recovery, '.ags-temporary-owner.json'), 'utf8');
    assert.equal(marker.includes(incoming), false);
    utils.atomicWrite(staged ? file + '.pending' : file, auth(name, 'official-fresh'));
    assert.equal((await accounts.refreshAccount(agent, name, true)).state, 'ok');
    assert.equal(rpc.mock.callCount(), 2);
  });
}

test('a rejected exchange for another workspace cannot replay through a new Session update', async t => {
  const backup = require('../dist/backup');
  const name = 'wrong-result', dir = store.profileDir('codex', name);
  const file = path.join(dir, 'auth.json'), original = auth(name, 'original'), candidate = auth(name, 'candidate');
  utils.atomicWrite(file, original);
  store.writeProfileMeta('codex', name, { snapshot: { available: true, state: 'expired', authExpired: true } });
  const submit = async () => {
    const { parsed, target } = await backup.previewCredentialUpdate(candidate, 'codex', name);
    await backup.installCredentialUpdate(parsed, target);
  };
  let recovery;
  const rpc = t.mock.method(agent, 'queryLiveRpc', async directory => {
    recovery = directory; restore.add(directory);
    utils.atomicWrite(path.join(directory, 'auth.json'), auth('another-workspace', 'other-issued'));
    return quota;
  });
  await submit();
  assert.equal((await accounts.refreshAccount(agent, name, true)).state, 'expired');
  assert.deepEqual(utils.readBuffer(file), original);
  await submit();
  await assert.rejects(accounts.refreshAccount(agent, name, true), error => error.message.includes(recovery));
  assert.equal(rpc.mock.callCount(), 1);
});

function interruptedQuota(name, output, legacy = false) {
  const seed = auth(name, 'original');
  const directory = lifecycle.createTemporaryCredentials('quota');
  restore.add(directory);
  lifecycle.markTemporaryCredentialsPending(directory, agent.identityFromBytes(seed).id, 'original', legacy ? undefined : seed);
  const owner = path.join(directory, '.ags-temporary-owner.json');
  // The fixture process exits before its PID is recorded as the former owner.
  const pid = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }));
  fs.writeFileSync(owner, JSON.stringify({ ...JSON.parse(fs.readFileSync(owner)), pid }));
  if (output) fs.writeFileSync(path.join(directory, 'auth.json'), output, { mode: 0o600 });
  return directory;
}

test('an ordinary refresh reconciles old and new stopped queries without replaying unchanged credentials', async t => {
  for (const [name, format] of [['old-identical', 'bytes'], ['new-format', 'pretty'], ['missing', 'absent']]) {
    const seed = auth(name, 'original'), file = path.join(store.profileDir('codex', name), 'auth.json');
    utils.atomicWrite(file, seed);
    const saved = format === 'bytes' ? seed : format === 'pretty' ? JSON.stringify(JSON.parse(seed), null, 2) : undefined;
    const directory = interruptedQuota(name, saved, format === 'bytes');
    const rpc = t.mock.method(agent, 'queryLiveRpc', async () => {
      assert.equal(fs.existsSync(directory), false, 'stopped, unchanged copy cleaned before the next query');
      return quota;
    });
    assert.equal((await accounts.refreshAccount(agent, name, true)).state, 'ok');
    assert.deepEqual(utils.readBuffer(file), seed);
    assert.equal(rpc.mock.callCount(), 1);
    rpc.mock.restore();
  }
});

test('switch preparation resumes a partial rotation from the updated account and syncs only its input generation', async t => {
  const name = 'resume-a', seed = auth(name, 'original'), next = auth(name, 'successor');
  const profile = key => store.profileDir('codex', key), file = key => path.join(profile(key), 'auth.json');
  const alias = 'resume-b', independent = 'resume-c', other = auth(name, 'independent');
  for (const [key, bytes] of [[name, seed], [alias, seed], [independent, other]]) utils.atomicWrite(file(key), bytes);
  const dir = interruptedQuota(name, next, true), write = agent.writeCredentials;
  const fault = t.mock.method(agent, 'writeCredentials', function (target, ...args) {
    if (target === profile(alias)) throw new Error('fixture alias busy');
    return write.call(this, target, ...args);
  });
  await assert.rejects(accounts.prepareSwitchTarget(agent, name), /fixture alias busy/);
  assert.deepEqual(utils.readBuffer(file(name)), next);
  assert.deepEqual(utils.readBuffer(file(alias)), seed);
  assert.ok(fs.existsSync(dir));
  fault.mock.restore();
  const prepared = await accounts.prepareSwitchTarget(agent, name);
  assert.deepEqual(prepared.target['auth.json'], next);
  assert.deepEqual(utils.readBuffer(file(alias)), next);
  assert.deepEqual(utils.readBuffer(file(independent)), other);
  assert.equal(fs.existsSync(dir), false);
});

test('recovery preserves a mismatched workspace and rejects an unsafe credential file before any query', async t => {
  const rpc = t.mock.method(agent, 'queryLiveRpc', () => assert.fail('unverified recovery must not reach RPC'));
  for (const name of process.platform === 'win32' ? ['workspace-conflict'] : ['workspace-conflict', 'unsafe-mode']) {
    const seed = auth(name, 'original'), file = path.join(store.profileDir('codex', name), 'auth.json');
    const mismatch = name === 'workspace-conflict', output = auth(mismatch ? 'other-workspace' : name, 'new');
    utils.atomicWrite(file, seed);
    const dir = interruptedQuota(name, output), record = path.join(dir, 'auth.json');
    if (!mismatch) fs.chmodSync(record, 0o644);
    const result = await accounts.refreshAccount(agent, name, true);
    assert.equal(result.authFailure, 'quota-recovery-required');
    assert.deepEqual(utils.readBuffer(file), seed);
    assert.deepEqual(fs.readFileSync(record), output);
    await assert.rejects(accounts.prepareSwitchTarget(agent, name));
  }
  assert.equal(rpc.mock.callCount(), 0);
});
