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
const store = require('../dist/store');
const { codexAgent: agent } = require('../dist/agents/codex');
Object.defineProperty(agent, 'homeDir', { value: path.join(root, 'live'), configurable: true });
const accounts = require('../dist/accounts');
const { atomicWrite } = require('../dist/utils');
const auth = (workspace, refresh = `refresh-${workspace}`) => JSON.stringify({ last_refresh: refresh.startsWith('rotated-') ? '2026-11-02T00:00:00Z' : '2026-11-01T00:00:00Z', tokens: {
  account_id: workspace,
  access_token: 'fixture-access',
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

test('same-email workspaces can be saved separately without overwriting credentials', async () => {
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
});

test('switching same-email workspaces applies the requested credentials and preserves each session', async () => {
  putLive('personal');
  await accounts.saveAccount(agent, 'personal');
  putLive('organization');
  await accounts.saveAccount(agent, 'work');
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
test('a failing old alias cannot overwrite a healthy copy of the same account', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  putLive('another-workspace');
  const good=path.join(store.profileDir('codex','healthy'),'auth.json');
  const old=path.join(store.profileDir('codex','old-import'),'auth.json');
  atomicWrite(good,auth('personal','valid-rotated-token'));
  atomicWrite(old,auth('personal','revoked-backup-token'));
  for(const message of ['凭据失效，请重新登录','额度查询失败，请稍后重试']) {
    agent.queryLiveRpc=async()=>{throw new Error(message);};
    await accounts.refreshAccount(agent,'old-import',true);
    assert.equal(profileAuth('healthy').tokens.refresh_token,'valid-rotated-token');
    assert.equal(agent.identity().id,'another-workspace:same-person');
    t.mock.timers.tick(30000);
  }
});
