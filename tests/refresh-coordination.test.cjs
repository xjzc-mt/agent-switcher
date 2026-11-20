const { accessToken } = require('./codex-token-fixture.cjs');
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
const { codexAgent: agent, CodexQueryError } = require('../dist/agents/codex');
const { atomicWrite } = require('../dist/utils');
Object.defineProperty(agent, 'homeDir', { value: path.join(root, 'live') });
const success = () => ({ rates: { rateLimits: { primary: { usedPercent: 20 } } } });
function put(name, token = 'first') {
  atomicWrite(path.join(store.profileDir('codex', name), 'auth.json'), JSON.stringify({
    tokens: { account_id: 'fixture-workspace', access_token: accessToken('fixture-workspace','fixture-user'), refresh_token: token,
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
  assert.equal((await accounts.refreshAccount(agent, 'A', true)).checkedAt, first.checkedAt);
  assert.equal(queries, 1);
  t.mock.timers.tick(1);
  agent.queryLiveRpc = async () => { queries++; throw new CodexQueryError('登录已过期', 'refresh-revoked'); };
  assert.equal((await accounts.refreshAccount(agent, 'A', true)).state, 'expired');
  assert.equal(queries, 2);
  put('A', 'replacement');
  const changed = accounts.dashboard()[0].profiles.find(profile => profile.name === 'A');
  assert.equal(changed.meta.snapshot.state, 'unverified');
  assert.ok(changed.refreshAt <= Date.now());
  agent.queryLiveRpc = async () => { queries++; return success(); };
  assert.notEqual((await accounts.refreshAccount(agent, 'A', true)).credentialRevision, first.credentialRevision);
  assert.equal(queries, 3);
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

test('a switch backup and a newer same-email login refresh their own credentials and cooldowns', async t => {
  const native = require('../dist/antigravity-native');
  const cli = require('../dist/antigravity-cli');
  const { AntigravityAgent } = require('../dist/agents/antigravity');
  const agy = new AntigravityAgent(() => 'unified', true);
  const providers = accounts.ALL_AGENTS.splice(0, accounts.ALL_AGENTS.length, agy);
  t.after(() => accounts.ALL_AGENTS.splice(0, 1, ...providers));
  function token(email, login, minutes) {
    return Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: email,
      token: { access_token: 'access-' + login, refresh_token: 'refresh-' + login, expiry: new Date(Date.now() + minutes * 60000).toISOString() } }));
  }
  const email = 'backup@example.test';
  const previous = token(email, 'first', 60), current = token(email, 'second', 90);
  let live = token('other@example.test', 'other', 60), busy = false;
  t.mock.method(native, 'readNativeToken', () => live);
  t.mock.method(native, 'writeNativeToken', bytes => { live = bytes; });
  t.mock.method(native, 'sharedAntigravitySessions', async () => []);
  t.mock.method(require('../dist/clients'), 'runningClients', async () => busy ? ['Antigravity'] : []);
  await accounts.saveAccount(agy, 'Other');
  live = previous;
  assert.equal(accounts.needsUnmanagedChoice(agy, 'Other'), true);
  await accounts.useAccount(agy, 'Other', { saveUnmanaged: true });
  const backup = store.listProfiles('agy').find(name => /^backup-\d+$/.test(name));
  assert.ok(backup);
  live = current;
  await accounts.saveAccount(agy, 'Personal');
  assert.equal(accounts.activeProfile(agy), 'Personal');
  const saved = name => agy.readCredentials(store.profileDir('agy', name))[agy.authFiles[0]];
  const usage = { groups: [{ name: 'Gemini', buckets: [{ id: 'g', remaining_fraction: 0.8 }] }] };
  const reads = [], rotations = [];
  t.mock.method(cli, 'queryAccessTokenUsage', async (_email, access) => { reads.push(access); return usage; });
  const nextBackup = token(email, 'first-renewed', 240);
  t.mock.method(cli, 'queryIsolatedUsage', async bytes => {
    rotations.push(JSON.parse(bytes).token.refresh_token);
    return { data: usage, rotated: nextBackup };
  });
  busy = true;
  const first = await accounts.refreshAccount(agy, backup);
  assert.equal(first.state, 'ok');
  assert.equal(store.readProfileMeta('agy', backup).snapshot.checkedAt, first.checkedAt);
  await accounts.refreshAccount(agy, backup, true);
  await accounts.refreshAccount(agy, backup);
  assert.deepEqual(reads, ['access-first']);
  assert.deepEqual(rotations, []);

  live = token(email, 'official-renewal', 120);
  await accounts.refreshAccount(agy, 'Personal');
  assert.deepEqual(reads, ['access-first', 'access-official-renewal']);
  assert.deepEqual(saved('Personal'), live);
  assert.deepEqual(saved(backup), previous);
  const official = live;
  busy = false;
  t.mock.timers.tick(30000);
  await accounts.refreshAccount(agy, backup, true);
  assert.deepEqual(rotations, ['refresh-first']);
  assert.deepEqual(saved(backup), nextBackup);
  assert.deepEqual(saved('Personal'), official);
  assert.deepEqual(live, official);

  t.mock.timers.tick(30000);
  cli.queryIsolatedUsage = async bytes => {
    live = bytes; // The official client selects this backup while its query is still running.
    return { data: usage, rotated: token(email, 'late-result', 300) };
  };
  await assert.rejects(accounts.refreshAccount(agy, backup, true), /查询期间登录凭据已更新/);
  assert.deepEqual(live, nextBackup);
  assert.deepEqual(saved(backup), nextBackup);
  assert.deepEqual(saved('Personal'), official);

  // The renderer uses the active card's name for the current account's deadline.
  const panel = () => accounts.dashboard()[0];
  const stored = store.readProfileMeta('agy', 'Personal').snapshot;
  live = token(email, 'earlier-login', 15);
  assert.equal(panel().active, 'Personal');
  assert.ok(panel().refreshAt <= Date.now());
  await accounts.refreshAccount(agy, panel().active);
  assert.equal(reads.at(-1), 'access-earlier-login');
  const after = panel();
  assert.equal(after.status.state, 'ok');
  assert.ok(after.refreshAt > Date.now());
  await accounts.refreshAccount(agy, after.active, true);
  assert.equal(reads.filter(access => access === 'access-earlier-login').length, 1);
  assert.deepEqual(store.readProfileMeta('agy', 'Personal').snapshot, stored);
  assert.deepEqual(saved('Personal'), official);

  const undated = JSON.parse(token(email, 'undated-login', 60));
  delete undated.token.expiry;
  live = Buffer.from(JSON.stringify(undated));
  const deferred = await accounts.refreshAccount(agy, panel().active);
  assert.equal(deferred.state, 'unverified');
  assert.doesNotMatch(deferred.extra, /客户端正在运行/);
  assert.match(deferred.extra, /凭据版本不同/);
  assert.ok(panel().refreshAt > Date.now());
  assert.deepEqual(saved('Personal'), official);

  busy = true;
  const incomplete = JSON.parse(token(email, 'official-renewal', 180));
  delete incomplete.token.access_token;
  const withoutAccess = Buffer.from(JSON.stringify(incomplete));
  live = withoutAccess;
  const beforeRead = reads.length;
  assert.equal((await accounts.refreshAccount(agy, 'Personal', true)).state, 'ok');
  assert.deepEqual(reads.slice(beforeRead), ['access-official-renewal']);
  assert.deepEqual(saved('Personal'), official, 'Keep the usable bearer even though the live copy has a later expiry');
  assert.deepEqual(live, withoutAccess);

  busy = false;
  t.mock.timers.tick(30000);
  live = token(email, 'official-renewal', -5);
  let renewals = 0;
  cli.queryIsolatedUsage = async bytes => { renewals++; return { data: usage, rotated: bytes }; };
  assert.equal((await accounts.refreshAccount(agy, 'Personal', true)).state, 'ok');
  assert.equal(renewals, 1, 'A different bearer date on the same login must not permanently block renewal');

  busy = true;
  live = token('desktop@example.test', 'desktop', 60);
  const spare = JSON.parse(nextBackup);
  delete spare.token.access_token;
  atomicWrite(path.join(store.profileDir('agy', backup), agy.authFiles[0]), Buffer.from(JSON.stringify(spare)));
  t.mock.method(agy, 'auxiliaryCredentials', () => [{ identity: agy.identityFromBytes(nextBackup), files: { [agy.authFiles[0]]: nextBackup } }]);
  assert.equal((await accounts.refreshAccount(agy, backup, true)).state, 'ok');
  assert.equal(reads.at(-1), 'access-first-renewed');
  assert.equal(renewals, 1);
});
