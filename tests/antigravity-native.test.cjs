const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-native-test-'));
os.homedir = () => root;
const { readCredentialFile } = require('./vault-fixture.cjs');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const native = require('../dist/antigravity-native');
const clients = require('../dist/clients');
const { AntigravityAgent } = require('../dist/agents/antigravity');
const { saveAccount, useAccount } = require('../dist/accounts');
const { profileDir } = require('../dist/store');
const { atomicWrite } = require('../dist/utils');
const { credentialState } = require('../dist/credential-state');
const token = (email, generation = 1) => Buffer.from(JSON.stringify({ auth_method: 'consumer',
  id_token_email: email, token: { access_token: `fake-access-${email}-${generation}`, refresh_token: `fake-refresh-${email}`, expiry: new Date(1795000000000 + generation * 60000).toISOString() } }));
let live = token('a@example.test'), sessions = [], failWrite = false;
native.readNativeToken = () => live;
native.writeNativeToken = bytes => { if (failWrite) throw new Error('模拟 Keychain 写入失败'); live = bytes; };
native.sharedAntigravitySessions = async () => sessions;
clients.runningClients = async () => [];
const agent = new AntigravityAgent(() => 'unified', true);

test('native adapter uses the shared pool and switch flow for A → B → A, saving rotated B', async () => {
  await saveAccount(agent, 'A');
  atomicWrite(path.join(profileDir('agy', 'B'), agent.authFiles[0]), token('b@example.test'));
  const revisionA = credentialState(agent).revision;
  await useAccount(agent, 'B', { saveUnmanaged: true });
  assert.equal(agent.identity().email, 'b@example.test');
  assert.notEqual(credentialState(agent).revision, revisionA);
  live = token('b@example.test', 2);
  await useAccount(agent, 'A', { saveUnmanaged: true });
  assert.equal(agent.identity().email, 'a@example.test');
  assert.equal(credentialState(agent).revision, revisionA);
  assert.deepEqual(readCredentialFile(path.join(profileDir('agy', 'B'), agent.authFiles[0])), token('b@example.test', 2));
  assert.equal(fs.existsSync(path.join(agent.homeDir, agent.authFiles[0])), false);
});

test('shared sessions and write failures preserve the current native account', async () => {
  const original = live;
  sessions = [123];
  await assert.rejects(useAccount(agent, 'B', { saveUnmanaged: true }), /共用认证/);
  assert.deepEqual(live, original);
  sessions = [];
  failWrite = true;
  await assert.rejects(useAccount(agent, 'B', { saveUnmanaged: true }), /写入失败/);
  assert.deepEqual(live, original);
  failWrite = false;
});

test('legacy JWT and unified email retain the same personal identity after refresh', () => {
  const legacy = { auth_method: 'consumer', token: { refresh_token: 'fake-refresh' },
    id_token: `x.${Buffer.from(JSON.stringify({ sub: 'google-subject', email: 'b@example.test' })).toString('base64url')}.x` };
  assert.equal(agent.identityFromAuth(legacy).id, agent.identityFromAuth(JSON.parse(token('b@example.test'))).id);
  assert.doesNotThrow(() => native.parseNativeToken(Buffer.from(JSON.stringify(legacy))));
  for (const value of [{}, { auth_method: 'business', token: { refresh_token: 'fake' } },
    { auth_method: 'consumer', token: { refresh_token: 'fake' } }]) {
    const bytes = Buffer.from(JSON.stringify(value));
    assert.throws(() => native.parseNativeToken(bytes), /个人 Google/);
    assert.equal(agent.identityFromBytes(bytes), undefined);
  }
  assert.throws(() => native.parseNativeToken(Buffer.from('not-json')), /格式无效/);
});

test('quota preserves backend buckets and treats missing or disabled values as unknown', () => {
  const data = { groups: [{ name: 'Gemini', buckets: [
    { id: 'weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-11-20T00:00:00Z' },
    { id: '5h', name: 'Five hours', window: '5h', remaining_fraction: 0 },
    { id: 'unknown', name: 'Unknown' },
    { id: 'disabled', name: 'Disabled', remaining_fraction: 0, disabled: true },
  ] }] };
  const result = native.quotaFromUsage(data, 'a@example.test');
  const buckets = result.quota.buckets;
  assert.equal(buckets[0].label, 'Gemini');
  assert.deepEqual(buckets[0].windows.map(w => [w.windowMins, w.usedPercent]), [[300, 100], [10080, 25]]);
  assert.equal(buckets[0].windows[1].resetsAt, Date.parse('2026-11-20T00:00:00Z') / 1000);
  assert.equal(buckets[0].windows.length, 2);
  assert.equal(result.account, 'a@example.test');
  assert.throws(() => native.quotaFromUsage({}, 'a@example.test'), /未返回/);
});
