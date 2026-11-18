const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-removal-test-'));
os.homedir = () => root;
os.tmpdir = () => path.join(root, 'tmp');
fs.mkdirSync(os.tmpdir());
process.env.CODEX_HOME = path.join(root, 'live');
require('./vault-fixture.cjs');
const clients = require('../dist/clients');
clients.runningClients = async () => [];
const logout = require('../dist/client-logout');
let unsupported, onReady, clearCalls;
logout.logoutSupport = () => unsupported;
logout.assertLogoutReady = async () => {
  if (unsupported) throw new Error(unsupported);
  await onReady?.();
};
logout.clearClientCredentials = (agent, identity, revision) => {
  assert.equal(agent.identity()?.id, identity);
  assert.equal(credentialState(agent).revision, revision);
  clearCalls.push({ identity, revision });
  agent.writeCredentials(agent.homeDir, { 'auth.json': null });
};
const store = require('../dist/store');
const accounts = require('../dist/accounts');
const { codexAgent: agent } = require('../dist/agents/codex');
const { atomicWrite, readBuffer } = require('../dist/utils');
const { credentialState } = require('../dist/credential-state');
const dir = name => store.profileDir('codex', name);
const file = directory => path.join(directory, 'auth.json');
const auth = (workspace, generation = 1, user = 'member') => JSON.stringify({
  auth_mode: 'chatgpt', last_refresh: `2026-11-${String(generation).padStart(2, '0')}T00:00:00Z`,
  tokens: { account_id: workspace, access_token: `access-${workspace}-${generation}`,
    refresh_token: `refresh-${workspace}-${generation}`,
    id_token: 'header.' + Buffer.from(JSON.stringify({ sub: user, email: 'shared@example.test' })).toString('base64url') + '.signature' },
});
const put = (directory, workspace, generation, user) => atomicWrite(file(directory), auth(workspace, generation, user));
const version = directory => JSON.parse(readBuffer(file(directory))).tokens.refresh_token;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rates = { account: { type: 'chatgpt', email: 'shared@example.test' }, rates: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } } };

beforeEach(() => {
  fs.rmSync(store.STORE_DIR, { recursive: true, force: true });
  fs.rmSync(agent.homeDir, { recursive: true, force: true });
  unsupported = undefined; onReady = undefined; clearCalls = [];
  agent.queryLiveRpc = async () => { throw new Error('Unexpected real quota request'); };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('removal includes proven aliases but preserves other workspaces and users with the same email', async () => {
  put(agent.homeDir, 'personal');
  put(dir('A'), 'personal'); put(dir('backup-1'), 'personal');
  put(dir('work'), 'organization'); put(dir('other-member'), 'personal', 1, 'other-user');
  store.setActiveProfile('codex', 'A'); store.setActiveProfile('agy', 'Google A');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  assert.deepEqual(preview.profiles, ['A', 'backup-1']);
  assert.equal(preview.current, true);
  const result = await accounts.removeAccount(agent, 'A', { preview });
  assert.deepEqual(result, { ok: true, removed: ['A', 'backup-1'], loggedOut: false });
  assert.deepEqual(store.listProfiles('codex'), ['other-member', 'work']);
  assert.equal(version(agent.homeDir), 'refresh-personal-1');
  assert.equal(store.getActiveProfile('codex'), undefined);
  assert.equal(store.getActiveProfile('agy'), 'Google A');
  assert.equal(clearCalls.length, 0);
});

test('preview cannot delete a renamed account or a recreated directory with identical credentials', async () => {
  put(dir('A'), 'personal');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  await accounts.renameAccount(agent, 'A', 'renamed');
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview }), /不存在|变化/);
  assert.equal(version(dir('renamed')), 'refresh-personal-1');
  const renamed = await accounts.previewRemoveAccount(agent, 'renamed');
  const old = path.join(root, 'old-directory');
  fs.renameSync(dir('renamed'), old);
  put(dir('renamed'), 'personal');
  await assert.rejects(accounts.removeAccount(agent, 'renamed', { preview: renamed }), /变化/);
  assert.equal(version(dir('renamed')), 'refresh-personal-1');
  assert.equal(fs.existsSync(file(old)), true);
});

test('new aliases or unknown files appearing after preview require a new confirmation', async () => {
  put(dir('A'), 'personal');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  put(dir('new-copy'), 'personal');
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview }), /范围已变化/);
  const next = await accounts.previewRemoveAccount(agent, 'A');
  fs.writeFileSync(path.join(dir('A'), 'notes.txt'), 'must stay');
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview: next }), /非账号管理文件/);
  assert.equal(fs.readFileSync(path.join(dir('A'), 'notes.txt'), 'utf8'), 'must stay');
  assert.deepEqual(store.listProfiles('codex'), ['A', 'new-copy']);
});

test('symlink files and directory escapes are refused without touching their targets', async () => {
  const target = path.join(root, 'user-notes.txt'); fs.writeFileSync(target, 'keep this');
  put(dir('A'), 'personal'); fs.symlinkSync(target, path.join(dir('A'), '_meta.json'));
  await assert.rejects(accounts.previewRemoveAccount(agent, 'A'), /非账号管理文件/);
  fs.symlinkSync(root, path.join(store.STORE_DIR, 'codex', 'escape'));
  await assert.rejects(accounts.removeAccount(agent, 'escape'), /符号链接/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep this');
  assert.equal(version(dir('A')), 'refresh-personal-1');
});

test('removal waits for a rotating current-account query and preserves its new live credentials', async () => {
  put(agent.homeDir, 'rotating'); put(dir('A'), 'rotating'); put(dir('copy'), 'rotating');
  put(dir('other'), 'other');
  let started, release, queryFinished = false;
  const running = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  agent.queryLiveRpc = async temporary => {
    started(); await gate; put(temporary, 'rotating', 2); return rates;
  };
  const refresh = accounts.refreshAccount(agent, 'A', true).then(result => { queryFinished = true; return result; });
  await running;
  await accounts.renameAccount(agent, 'other', 'renamed');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  let deletionFinished = false;
  const removal = accounts.removeAccount(agent, 'A', { preview }).then(result => { deletionFinished = true; return result; });
  try {
    await pause(30);
    assert.equal(deletionFinished, false);
    assert.equal(version(agent.homeDir), 'refresh-rotating-1');
    assert.equal(store.profileExists('codex', 'A'), true);
  } finally { release(); }
  assert.equal((await refresh).state, 'ok');
  assert.deepEqual((await removal).removed, ['A', 'copy']);
  assert.equal(queryFinished, true);
  assert.equal(version(agent.homeDir), 'refresh-rotating-2');
  assert.deepEqual(store.listProfiles('codex'), ['renamed']);
  assert.equal(version(dir('renamed')), 'refresh-other-1');
});

test('deleted current account is not silently restored by switching; discard requires an explicit choice', async () => {
  put(agent.homeDir, 'A'); put(dir('A'), 'A'); put(dir('B'), 'B');
  await accounts.removeAccount(agent, 'A');
  assert.equal(accounts.needsUnmanagedChoice(agent, 'B'), true);
  await assert.rejects(accounts.useAccount(agent, 'B'), /明确选择/);
  assert.equal(version(agent.homeDir), 'refresh-A-1');
  assert.deepEqual(store.listProfiles('codex'), ['B']);
  await accounts.useAccount(agent, 'B', { saveUnmanaged: false });
  assert.equal(version(agent.homeDir), 'refresh-B-1');
  assert.deepEqual(store.listProfiles('codex'), ['B']);
});

test('explicitly saving an unmanaged account still preserves it before switching', async () => {
  put(agent.homeDir, 'A'); put(dir('B'), 'B'); put(dir('C'), 'C');
  await accounts.useAccount(agent, 'B', { saveUnmanaged: true });
  const backup = store.listProfiles('codex').find(name => name.startsWith('backup-'));
  assert.ok(backup);
  assert.equal(version(dir(backup)), 'refresh-A-1');
  assert.equal(version(agent.homeDir), 'refresh-B-1');
  assert.equal(version(dir('C')), 'refresh-C-1');
});

for (const duringInspection of [false, true]) test(`discard choice rejects login changes ${duringInspection ? 'during' : 'before'} client inspection`, async () => {
  put(agent.homeDir, 'A'); put(dir('B'), 'B');
  const expectedCurrentRevision = credentialState(agent).revision;
  const original = clients.runningClients;
  if (duringInspection) clients.runningClients = async () => { put(agent.homeDir, 'C'); return []; };
  else put(agent.homeDir, 'C');
  try {
    await assert.rejects(accounts.useAccount(agent, 'B', { saveUnmanaged: false, expectedCurrentRevision }), /确认期间/);
  } finally { clients.runningClients = original; }
  assert.equal(version(agent.homeDir), 'refresh-C-1');
  assert.deepEqual(store.listProfiles('codex'), ['B']);
});

test('logout refuses an unsupported backend and a concurrently changed current account without deleting the pool', async () => {
  put(agent.homeDir, 'A'); put(dir('A'), 'A');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  unsupported = '此存储尚不支持自动退出';
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview, logout: true }), /不支持自动退出/);
  assert.equal(version(dir('A')), 'refresh-A-1');
  unsupported = undefined;
  onReady = () => put(agent.homeDir, 'B');
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview, logout: true }), /当前账号已变化/);
  assert.equal(version(agent.homeDir), 'refresh-B-1');
  assert.equal(version(dir('A')), 'refresh-A-1');
  assert.equal(clearCalls.length, 0);
});

test('explicit logout removes only the approved credentials and pool while leaving client history intact', async () => {
  put(agent.homeDir, 'A'); put(dir('A'), 'A'); put(dir('B'), 'B');
  const history = path.join(agent.homeDir, 'history.jsonl'); fs.writeFileSync(history, 'history stays');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  const result = await accounts.removeAccount(agent, 'A', { preview, logout: true });
  assert.equal(result.loggedOut, true);
  assert.equal(readBuffer(file(agent.homeDir)), null);
  assert.deepEqual(store.listProfiles('codex'), ['B']);
  assert.equal(fs.readFileSync(history, 'utf8'), 'history stays');
  assert.equal(clearCalls.length, 1);
});

test('a preview for another caller target cannot authorize removal', async () => {
  put(dir('A'), 'A'); put(dir('B'), 'B');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  await assert.rejects(accounts.removeAccount(agent, 'B', { preview }), /范围已变化/);
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview: { ...preview, agent: 'agy' } }), /范围已变化/);
  assert.deepEqual(store.listProfiles('codex'), ['A', 'B']);
});
