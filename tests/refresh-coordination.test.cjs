const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-refresh-coordination-'));
os.homedir = () => root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const store = require('../dist/store');
const accounts = require('../dist/accounts');
const { codexAgent: agent } = require('../dist/agents/codex');
const { atomicWrite } = require('../dist/utils');
Object.defineProperty(agent, 'homeDir', { value: path.join(root, 'live') });
const success = () => ({ rates: { rateLimits: { primary: { usedPercent: 20 } } } });
function put(name, token = 'first') {
  atomicWrite(path.join(store.profileDir('codex', name), 'auth.json'), JSON.stringify({
    tokens: { account_id: 'fixture-workspace', access_token: 'fake-access', refresh_token: token,
      id_token: 'h.' + Buffer.from(JSON.stringify({ sub: 'fixture-user' })).toString('base64url') + '.s' },
  }));
}
beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
  fs.rmSync(store.STORE_DIR, { recursive: true, force: true });
  agent.queryLiveRpc = async () => success();
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('manual refresh reuses a completed query for 30 seconds without extending its age', async t => {
  put('A');
  let queries = 0;
  agent.queryLiveRpc = async () => { queries++; return success(); };
  const first = await accounts.refreshAccount(agent, 'A');
  t.mock.timers.tick(29999);
  for (let i = 0; i < 3; i++) {
    assert.equal((await accounts.refreshAccount(agent, 'A', true)).checkedAt, first.checkedAt);
  }
  assert.equal(queries, 1);
  t.mock.timers.tick(1);
  await accounts.refreshAccount(agent, 'A', true);
  assert.equal(queries, 2);
});

test('failed queries retain quota history and back off; manual recovery clears failures', async t => {
  put('A');
  await accounts.refreshAccount(agent, 'A', true);
  const previous = store.readProfileMeta('codex', 'A').snapshot;
  t.mock.timers.tick(30000);
  let queries = 0;
  agent.queryLiveRpc = async () => { queries++; throw new Error('fixture network failure'); };
  const failed = await accounts.refreshAccount(agent, 'A', true);
  assert.equal(failed.state, 'error');
  assert.deepEqual(failed.quota, previous.quota); assert.equal(failed.fetchedAt, previous.fetchedAt);
  assert.equal((await accounts.refreshAccount(agent, 'A', true)).refreshFailures, 1);
  assert.equal(queries, 1);
  t.mock.timers.tick(30000);
  await accounts.refreshAccount(agent, 'A');
  assert.equal(queries, 1);
  assert.equal((await accounts.refreshAccount(agent, 'A', true)).refreshFailures, 2);
  assert.equal(queries, 2);
  t.mock.timers.tick(300000);
  assert.equal((await accounts.refreshAccount(agent, 'A')).refreshFailures, 3);
  t.mock.timers.tick(30000);
  agent.queryLiveRpc = async () => success();
  const recovered = await accounts.refreshAccount(agent, 'A', true);
  assert.equal(recovered.state, 'ok'); assert.equal(recovered.refreshFailures, undefined);
});

test('new credentials can be checked immediately after the old credential was queried', async () => {
  put('A');
  let queries = 0;
  agent.queryLiveRpc = async () => { queries++; return success(); };
  const first = await accounts.refreshAccount(agent, 'A', true);
  put('A', 'replacement');
  const second = await accounts.refreshAccount(agent, 'A', true);
  assert.equal(queries, 2);
  assert.notEqual(second.credentialRevision, first.credentialRevision);
});

test('renaming an account and restarting the backend preserve the cooldown', async () => {
  put('A');
  await accounts.refreshAccount(agent, 'A', true);
  await accounts.renameAccount(agent, 'A', 'renamed');
  const script = `
    require('node:os').homedir = () => process.argv[1];
    require('./tests/vault-fixture.cjs');
    Date.now = () => 2000000000001;
    const { codexAgent } = require('./dist/agents/codex');
    Object.defineProperty(codexAgent, 'homeDir', { value: require('node:path').join(process.argv[1], 'live') });
    codexAgent.queryLiveRpc = async () => { throw new Error('unexpected repeat query'); };
    require('./dist/accounts').refreshAccount(codexAgent, 'renamed', true).then(status => {
      require('node:assert/strict').equal(status.state, 'ok');
    }).catch(() => { process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', script, root], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
});

test('concurrent aliases and repeated requests share an isolated rotation without changing live auth or notes', async () => {
  put('A'); put('B');
  const liveFile = path.join(agent.homeDir, 'auth.json');
  atomicWrite(liveFile, JSON.stringify({ OPENAI_API_KEY: 'other-live-identity' }));
  const live = readCredentialFile(liveFile);
  store.writeProfileMeta('codex', 'B', { label: '备用', quotaNote: 'keep' });
  let queries = 0, started, release;
  const running = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  agent.queryLiveRpc = async directory => {
    queries++;
    assert.notEqual(directory, agent.homeDir); assert.notEqual(directory, store.profileDir('codex', 'A'));
    const file = path.join(directory, 'auth.json'), credentials = JSON.parse(readCredentialFile(file));
    assert.equal(credentials.tokens.refresh_token, 'first');
    started(); await gate;
    credentials.tokens.refresh_token = 'rotated'; atomicWrite(file, JSON.stringify(credentials));
    return success();
  };
  const pending = accounts.refreshAccount(agent, 'A', true);
  await running;
  const aliases = [accounts.refreshAccount(agent, 'B', true), accounts.refreshAccount(agent, 'A', true)];
  release();
  const [first, second] = await Promise.all([pending, ...aliases]);
  assert.equal(queries, 1);
  assert.equal(first.checkedAt, second.checkedAt);
  for (const name of ['A', 'B']) {
    assert.equal(JSON.parse(readCredentialFile(path.join(store.profileDir('codex', name), 'auth.json'))).tokens.refresh_token, 'rotated');
  }
  assert.deepEqual(readCredentialFile(liveFile), live);
  const meta = store.readProfileMeta('codex', 'B');
  assert.equal(meta.label, '备用'); assert.equal(meta.quotaNote, 'keep');
  assert.equal(meta.snapshot.checkedAt, first.checkedAt);
});

test('an alias with different credentials gets its own verification', async () => {
  put('A'); put('B', 'different-generation');
  let queries = 0;
  agent.queryLiveRpc = async () => { queries++; return success(); };
  await accounts.refreshAccount(agent, 'A', true);
  assert.equal(store.readProfileMeta('codex', 'B').snapshot, undefined);
  await accounts.refreshAccount(agent, 'B', true);
  assert.equal(queries, 2);
});
