const { accessToken } = require('./codex-token-fixture.cjs');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-identity-tests-'));
os.homedir = () => root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const clients = require('../dist/clients');
clients.runningClients = async () => [];
const logout = require('../dist/client-logout');
logout.runningCodexSessions = async () => [];
const store = require('../dist/store');
const { codexAgent: agent } = require('../dist/agents/codex');
Object.defineProperty(agent, 'homeDir', { value: path.join(root, 'live'), configurable: true });
const accounts = require('../dist/accounts');
const { atomicWrite } = require('../dist/utils');
const auth = (workspace, refresh = `refresh-${workspace}`) => JSON.stringify({ last_refresh: refresh.startsWith('rotated-') ? '2026-11-02T00:00:00Z' : '2026-11-01T00:00:00Z', tokens: {
  account_id: workspace,
  access_token: accessToken(workspace, 'same-person', 'person@example.test', refresh),
  refresh_token: refresh,
  id_token: `header.${Buffer.from(JSON.stringify({ sub: 'same-person', email: 'person@example.test' })).toString('base64url')}.signature`,
} });
const putLive = (workspace, refresh) => atomicWrite(path.join(agent.homeDir, 'auth.json'), auth(workspace, refresh));
const profileAuth = name => JSON.parse(readCredentialFile(path.join(store.profileDir('codex', name), 'auth.json'), 'utf8'));

beforeEach(() => {
  for (const dir of [store.STORE_DIR, agent.homeDir]) fs.rmSync(dir, { recursive: true, force: true });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('stable identity takes precedence over matching or changed email', () => {
  assert.equal(accounts.isSameIdentity({ id: 'personal:user', email: 'person@example.test' }, { id: 'org:user', email: 'person@example.test' }), false);
  assert.equal(accounts.isSameIdentity({ id: 'personal:user', email: 'old@example.test' }, { id: 'personal:user', email: 'new@example.test' }), true);
  assert.equal(accounts.isSameIdentity({ email: ' PERSON@example.test ' }, { id: 'personal:user', email: 'person@example.test' }), true);
  assert.equal(accounts.isSameIdentity({ id: 'personal:user' }, { id: 'org:user' }), false);
});

test('saving and switching same-email workspaces preserves both sessions and rejects a duplicate name', async () => {
  putLive('personal');
  await accounts.saveAccount(agent, 'personal');
  await accounts.saveAccount(agent, 'personal');
  await assert.rejects(accounts.saveAccount(agent, 'personal-alias'), /已存在/);
  putLive('organization');
  assert.equal(accounts.activeProfile(agent), undefined);
  await accounts.saveAccount(agent, 'work');
  assert.equal(profileAuth('personal').tokens.account_id, 'personal');
  assert.equal(profileAuth('work').tokens.account_id, 'organization');
  assert.equal(accounts.activeProfile(agent), 'work');
  await assert.rejects(accounts.saveAccount(agent, 'personal'), /另一个账号|已存在/);
  putLive('organization', 'rotated-work');
  await accounts.useAccount(agent, 'personal', { saveUnmanaged: true });
  assert.equal(agent.identity().id, 'personal:same-person');
  assert.equal(profileAuth('work').tokens.refresh_token, 'rotated-work');
  assert.equal(profileAuth('personal').tokens.refresh_token, 'refresh-personal');
  assert.equal(store.getActiveProfile('codex'), 'personal');
});

test('refreshing a same-email standby workspace cannot synchronize into another workspace', async () => {
  putLive('personal');
  await accounts.saveAccount(agent, 'personal');
  putLive('organization');
  await accounts.saveAccount(agent, 'work');
  agent.queryLiveRpc = async dir => {
    assert.equal(agent.identity(dir).id, 'personal:same-person');
    atomicWrite(path.join(dir, 'auth.json'), auth('personal', 'rotated-personal'));
    return { account: { email: 'person@example.test' }, rates: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } } };
  };
  await accounts.refreshAccount(agent, 'personal', true);
  assert.equal(profileAuth('personal').tokens.refresh_token, 'rotated-personal');
  assert.equal(profileAuth('work').tokens.refresh_token, 'refresh-organization');
  assert.equal(agent.identity().id, 'organization:same-person');
});
test('a failing old alias cannot overwrite a healthy copy of the same account', async () => {
  putLive('another-workspace');
  const good=path.join(store.profileDir('codex','healthy'),'auth.json');
  const old=path.join(store.profileDir('codex','old-import'),'auth.json');
  atomicWrite(good,auth('personal','valid-rotated-token'));
  atomicWrite(old,auth('personal','revoked-backup-token'));
  agent.queryLiveRpc=async()=>{throw new Error('凭据失效，请重新登录');};
  assert.equal((await accounts.refreshAccount(agent,'old-import',true)).state,'expired');
  assert.equal(profileAuth('healthy').tokens.refresh_token,'valid-rotated-token');
  assert.equal(agent.identity().id,'another-workspace:same-person');
});

test('staging, rejecting a candidate and completing official re-login keep the spent token bound to the original login', async t => {
  const name = 'repair-card', alias = 'old-alias', workspace = 'repair';
  const file = path.join(store.profileDir('codex', name), 'auth.json');
  atomicWrite(file, auth(workspace));
  atomicWrite(path.join(store.profileDir('codex', alias), 'auth.json'), auth(workspace));
  putLive('other-workspace');
  const requests = [];
  t.mock.method(agent, 'queryCredential', async (bytes, options) => {
    const rt = JSON.parse(bytes).tokens.refresh_token;
    requests.push(rt);
    if (options.verifyTarget) return { status: { available: true, state: 'error', extra: 'candidate rejected' } };
    if (rt === 'new-official') return { status: { available: true, state: 'ok' } };
    return { status: { available: true, state: 'expired', authExpired: true, refreshConsumed: true, extra: 'original recovery copy' } };
  });
  const spent = await accounts.refreshAccount(agent, name, true);
  assert.equal(spent.refreshConsumed, true);
  assert.equal((await accounts.refreshAccount(agent, name, true)).extra, spent.extra);
  const before = accounts.credentialUpdateTarget(agent, name);
  const source = path.join(root, 'candidate');
  const sameToken = JSON.parse(auth(workspace));
  sameToken.tokens.access_token = 'changed-access-token';
  atomicWrite(path.join(source, 'auth.json'), JSON.stringify(sameToken));
  await assert.rejects(accounts.updateAccountCredentials(before, source), /已被消耗/);
  atomicWrite(path.join(source, 'auth.json'), auth(workspace, 'candidate'));
  await accounts.updateAccountCredentials(before, source);
  assert.equal((await accounts.refreshAccount(agent, name, true)).refreshConsumed, true);
  assert.match((await accounts.refreshAccount(agent, name, true)).extra, /original recovery copy/);

  const { createLoginManager } = require('../dist/isolated-login');
  let login;
  const manager = createLoginManager(agent, (directory, target) => {
    login = { directory, target, attempt: 1, link: Promise.resolve('https://example.test'), phase: 'waiting', async stop() {} };
    return login;
  });
  await manager.useLink(() => {}, undefined, name);
  atomicWrite(path.join(login.directory, 'auth.json'), auth(workspace, 'new-official'));
  login.phase = 'complete';
  await manager.update(name, 1);
  assert.equal((await accounts.refreshAccount(agent, name, true)).state, 'ok');
  assert.equal((await accounts.refreshAccount(agent, alias, true)).refreshConsumed, true);
  assert.deepEqual(requests, ['refresh-repair', 'candidate', 'new-official']);
});

test('the dashboard rechecks the active card registration before exposing cached live quota', async t => {
  putLive('dashboard-owner');
  await accounts.saveAccount(agent, 'owner');
  t.mock.method(agent, 'queryLiveRpc', async () => ({ account: { email: 'person@example.test' },
    rates: { rateLimits: { primary: { usedPercent: 17 } } } }));
  assert.equal((await accounts.refreshAccount(agent, 'owner', true)).state, 'ok');
  const current = () => accounts.dashboard().find(a => a.id === 'codex').status;
  assert.equal(current().quota.primaryWindow.usedPercent, 17);
  const meta = store.readProfileMeta('codex', 'owner');
  store.writeProfileMeta('codex', 'owner', { ...meta, email: 'other-owner@example.test' });
  assert.equal(current().state, 'error');
  assert.equal(current().quota, undefined);
  store.writeProfileMeta('codex', 'owner', meta);
  atomicWrite(path.join(store.profileDir('codex', 'incomplete'), 'auth.json'), '{}');
  store.writeProfileMeta('codex', 'incomplete', meta);
  const broken = accounts.dashboard().find(a => a.id === 'codex').profiles.find(p => p.name === 'incomplete');
  assert.equal(broken.meta.snapshot.state, 'error');
  assert.equal(broken.meta.snapshot.quota, undefined);
  store.writeProfileMeta('codex', 'owner', { ...meta, email: undefined });
  // A label saved after the dashboard reads this legacy card must survive the render.
  const readMeta = store.readProfileMeta;
  let savedLabel = false;
  t.mock.method(store, 'readProfileMeta', (id, name) => {
    const snapshot = readMeta(id, name);
    if (name === 'owner' && !savedLabel) {
      savedLabel = true;
      store.writeProfileMeta(id, name, { ...snapshot, label: 'concurrent edit' });
    }
    return snapshot;
  });
  const owner = accounts.dashboard()[0].profiles.find(p => p.name === 'owner');
  assert.equal(owner.meta.email, 'person@example.test');
  assert.equal(owner.meta.snapshot.quota.primaryWindow.usedPercent, 17);
  assert.equal(readMeta('codex', 'owner').label, 'concurrent edit');
});
