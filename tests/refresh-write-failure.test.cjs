const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { accessToken } = require('./codex-token-fixture.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-refresh-write-'));
os.homedir = () => home;
require('./vault-fixture.cjs');
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
      require('./tests/vault-fixture.cjs');
      const { codexAgent } = require('./dist/agents/codex');
      codexAgent.queryLiveRpc = () => { throw new Error('unexpected second exchange'); };
      require('./dist/accounts').refreshAccount(codexAgent, process.argv[2], true).then(
        () => { process.exitCode = 2; }, error => process.stdout.write(error.message));
    `, home, name], { encoding: 'utf8' });
    assert.ok(output.includes(recovery));
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
