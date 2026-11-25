const { createTestHome, installMockKeychain, jwt, accessToken } = require('./helpers/test-env.cjs');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = createTestHome('ags-removal-test-', { mockKeychain: false });
os.tmpdir = () => path.join(root, 'tmp');
fs.mkdirSync(os.tmpdir());
process.env.CODEX_HOME = path.join(root, 'live');
installMockKeychain();
const clients = require('../dist/clients');
clients.runningClients = async () => [];
const logout = require('../dist/client-logout');
logout.runningCodexSessions = async () => [];
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
  tokens: { account_id: workspace, access_token: accessToken(workspace, user, 'shared@example.test', generation),
    refresh_token: `refresh-${workspace}-${generation}`,
    id_token: jwt({ sub: user, email: 'shared@example.test' }) },
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

test('a named save prunes only exact backups, after credentials and metadata are durable', async () => {
  put(agent.homeDir, 'A', 1);
  for (const name of ['backup-1', 'backup-2', 'backup-3', 'backup-4']) put(dir(name), 'A', 1);
  put(dir('backup-2'), 'A', 2);
  atomicWrite(path.join(dir('backup-3'), 'auth.json.pending'), auth('A', 3));
  fs.writeFileSync(path.join(dir('backup-4'), 'notes.txt'), 'keep me');
  const rename = fs.renameSync;
  for (const failingFile of ['auth.json', '_meta.json']) {
    fs.renameSync = (from, to) => {
      if (to === path.join(dir('named'), failingFile)) throw new Error('disk write failed');
      return rename(from, to);
    };
    try { await assert.rejects(accounts.saveAccount(agent, 'named'), /disk write failed/); }
    finally { fs.renameSync = rename; }
    assert.equal(version(dir('backup-1')), 'refresh-A-1');
    assert.equal(version(dir('backup-2')), 'refresh-A-2');
  }
  await accounts.saveAccount(agent, 'named');
  assert.equal(version(dir('named')), 'refresh-A-1');
  assert.equal(fs.existsSync(dir('backup-1')), false);
  assert.equal(version(dir('backup-2')), 'refresh-A-2');
  assert.deepEqual(readBuffer(path.join(dir('backup-3'), 'auth.json.pending')), Buffer.from(auth('A', 3)));
  assert.equal(fs.readFileSync(path.join(dir('backup-4'), 'notes.txt'), 'utf8'), 'keep me');
});

test('ordinary save preserves a damaged same-name card and a pending replacement', async () => {
  put(agent.homeDir, 'A');
  const saved = file(dir('named')), pending = path.join(dir('named'), 'auth.json.pending');
  const unsupported = Buffer.from('{"tokens":{},"previous_format":"recoverable"}');
  atomicWrite(saved, unsupported);
  await assert.rejects(accounts.saveAccount(agent, 'named'), /原凭据/);
  assert.deepEqual(readBuffer(saved), unsupported);
  put(dir('named'), 'A'); atomicWrite(pending, auth('A', 2));
  await assert.rejects(accounts.saveAccount(agent, 'named'), /待验证/);
  assert.deepEqual(readBuffer(pending), Buffer.from(auth('A', 2)));
});

test('saving uses the identity and bytes captured before an external account change', async t => {
  put(agent.homeDir, 'A', 2); put(dir('named'), 'A'); put(dir('B'), 'B');
  store.setActiveProfile('codex', 'B');
  const read = agent.readCredentials.bind(agent);
  let changed = false, locked = false;
  t.mock.method(agent, 'readCredentials', (location = agent.homeDir) => {
    const captured = read(location);
    if (locked && !changed && location === agent.homeDir) {
      changed = true;
      put(agent.homeDir, 'B');
    }
    return captured;
  });
  await accounts.saveAccount(agent, 'named', () => { locked = true; });
  assert.equal(changed, true);
  assert.equal(version(dir('named')), 'refresh-A-2');
  assert.equal(version(agent.homeDir), 'refresh-B-1');
  assert.equal(store.getActiveProfile('codex'), 'B');
});

test('syncing an alias cannot read a new live account after its generation was checked', async t => {
  put(agent.homeDir, 'A', 2); put(dir('backup-1'), 'A');
  const save = agent.save.bind(agent);
  let changed = false;
  t.mock.method(agent, 'save', (name, ...args) => {
    if (name === 'backup-1') { changed = true; put(agent.homeDir, 'B'); }
    return save(name, ...args);
  });
  await accounts.saveAccount(agent, 'backup-2');
  assert.equal(changed, true);
  assert.equal(version(dir('backup-1')), 'refresh-A-2');
  assert.equal(version(dir('backup-2')), 'refresh-A-2');
  assert.equal(version(agent.homeDir), 'refresh-B-1');
});

test('an official re-login updates the pool but preserves a new live account appearing during the write', async t => {
  put(agent.homeDir, 'A'); put(dir('named'), 'A');
  store.writeProfileMeta('codex', 'named', { snapshot: { available: true, state: 'expired', authExpired: true,
    credentialRevision: credentialState(agent, dir('named')).revision } });
  const target = accounts.credentialUpdateTarget(agent, 'named');
  const login = path.join(root, 'official-login'); put(login, 'A', 2);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === file(dir('named'))) put(agent.homeDir, 'B');
  });
  await accounts.updateAccountCredentials(target, login, undefined, { trusted: true });
  assert.equal(version(dir('named')), 'refresh-A-2');
  assert.equal(version(agent.homeDir), 'refresh-B-1');
});

test('discard choice rejects a login changed during client inspection', async t => {
  put(agent.homeDir, 'A'); put(dir('B'), 'B');
  const expectedCurrentRevision = credentialState(agent).revision;
  t.mock.method(clients, 'runningClients', async () => { put(agent.homeDir, 'C'); return []; });
  await assert.rejects(accounts.useAccount(agent, 'B', { saveUnmanaged: false, expectedCurrentRevision }), /确认期间/);
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

test('deletion confirmation binds the pending credential and the exact live login approved for logout', async () => {
  put(agent.homeDir, 'A'); put(dir('A'), 'A');
  const pending = path.join(dir('A'), 'auth.json.pending');
  atomicWrite(pending, auth('A', 2));
  const first = await accounts.previewRemoveAccount(agent, 'A');
  atomicWrite(pending, auth('A', 3));
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview: first }), /范围已变化/);
  const second = await accounts.previewRemoveAccount(agent, 'A');
  onReady = () => put(agent.homeDir, 'A', 4);
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview: second, logout: true }), /当前账号已变化/);
  assert.equal(clearCalls.length, 0);
  assert.equal(version(agent.homeDir), 'refresh-A-4');
  assert.equal(version(dir('A')), 'refresh-A-1');
  assert.deepEqual(readBuffer(pending), Buffer.from(auth('A', 3)));
});

test('a preview for another caller target cannot authorize removal', async () => {
  put(dir('A'), 'A'); put(dir('B'), 'B');
  const preview = await accounts.previewRemoveAccount(agent, 'A');
  await assert.rejects(accounts.removeAccount(agent, 'B', { preview }), /范围已变化/);
  await assert.rejects(accounts.removeAccount(agent, 'A', { preview: { ...preview, agent: 'agy' } }), /范围已变化/);
  assert.deepEqual(store.listProfiles('codex'), ['A', 'B']);
});
