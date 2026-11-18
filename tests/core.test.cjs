const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-tests-'));
os.homedir = () => root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const clients = require('../dist/clients');
clients.runningClients = async () => [];
const store = require('../dist/store');
const { codexAgent: agent } = require('../dist/agents/codex');
Object.defineProperty(agent, 'homeDir', { value: path.join(root, 'live'), configurable: true });
const accounts = require('../dist/accounts');
const { atomicWrite } = require('../dist/utils');
const backup = require('../dist/backup');
async function importBackup(data, password) {
  const parsed = await backup.parseBackup(data, password);
  return backup.installBackup(parsed, parsed.items.map(item => item.key));
}
const auth = (id, token = 'refresh-' + id) => JSON.stringify({ tokens: { account_id: id, access_token: 'fake-access', refresh_token: token, id_token: `header.${Buffer.from(JSON.stringify({ sub: id, email: `${id}@example.test` })).toString('base64url')}.signature` } });
const putLive = (id, token) => atomicWrite(path.join(agent.homeDir, 'auth.json'), auth(id, token));
const putProfile = (name, id) => atomicWrite(path.join(store.profileDir('codex', name), 'auth.json'), auth(id));
const readProfile = name => readCredentialFile(path.join(store.profileDir('codex', name), 'auth.json'), 'utf8');
beforeEach(() => {
  for (const dir of [store.STORE_DIR, agent.homeDir]) fs.rmSync(dir, { recursive: true, force: true });
  agent.queryLiveRpc = async () => ({ account: { email: 'A@example.test', planType: 'plus' }, rates: { rateLimits: { primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 2000000000 } } } });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('current quota plan wins over older login claims and missing plans fall back', async () => {
  putLive('A');
  for(const [reported,expected] of [['prolite','prolite'],['promax','promax'],['plus','plus'],['unknown','pro'],[undefined,'pro']]) {
    agent.queryLiveRpc=async()=>({account:{email:'A@example.test',planType:'pro'},rates:{rateLimits:{planType:reported,primary:{usedPercent:30}}}});
    assert.equal((await agent.status()).plan,expected);
  }
});

test('incomplete profiles fail without changing live credentials or active metadata', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'A');
  atomicWrite(path.join(store.profileDir('codex', 'partial'), 'config.toml'), 'model="other"');
  await assert.rejects(accounts.useAccount(agent, 'partial', { saveUnmanaged: true }), /认证/);
  assert.equal(agent.identity().id, 'A:A'); assert.equal(store.getActiveProfile('codex'), 'A');
});
test('failed save leaves active state unchanged; other identity cannot overwrite a name', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'A'); putLive('B');
  await assert.rejects(accounts.saveAccount(agent, 'A'), /另一个账号/);
  fs.rmSync(path.join(agent.homeDir, 'auth.json'));
  await assert.rejects(accounts.saveAccount(agent, 'empty'), /登录凭据/);
  assert.equal(store.getActiveProfile('codex'), 'A'); assert.equal(store.profileExists('codex', 'empty'), false);
});
test('switch and isolated login preserve configuration and live account', async () => {
  putLive('A'); atomicWrite(path.join(agent.homeDir, 'config.toml'), 'model="keep"');
  const dir = await accounts.prepareLogin(agent);
  assert.notEqual(dir, agent.homeDir); assert.equal(agent.identity().id, 'A:A');
  atomicWrite(path.join(dir, 'auth.json'), auth('C'));
  await accounts.saveAccount(agent, 'C');
  assert.equal(agent.identity().id, 'A:A');
  await accounts.useAccount(agent, 'C', { saveUnmanaged: true });
  assert.equal(readCredentialFile(path.join(agent.homeDir, 'config.toml'), 'utf8'), 'model="keep"');
});
test('profile aliases share refreshed tokens and same-account switch never restores stale auth', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'one');
  await assert.rejects(accounts.saveAccount(agent, 'two'), /已存在于「one」/);
  putProfile('two', 'A');
  // Real rotations carry a generation timestamp; an undated different token
  // must no longer be assumed newer simply because it is in the live file.
  for (const d of [agent.homeDir, store.profileDir('codex','one'), store.profileDir('codex','two')]) {
    const p=path.join(d,'auth.json'), value=JSON.parse(readCredentialFile(p));value.last_refresh='2026-11-01T00:00:00Z';atomicWrite(p,JSON.stringify(value));
  }
  putLive('A', 'new-refresh');
  const liveFile=path.join(agent.homeDir,'auth.json'), updated=JSON.parse(readCredentialFile(liveFile));updated.last_refresh='2026-11-02T00:00:00Z';atomicWrite(liveFile,JSON.stringify(updated));
  await accounts.useAccount(agent, 'one', { saveUnmanaged: true });
  assert.equal(JSON.parse(readProfile('two')).tokens.refresh_token, 'new-refresh');
  assert.equal(JSON.parse(readCredentialFile(path.join(agent.homeDir, 'auth.json'))).tokens.refresh_token, 'new-refresh');
});
test('invalid profile paths and symlink directories cannot be used', async () => {
  for (const name of ['.', '..', '', 'a/b', 'a\\b', '../x']) assert.throws(() => store.profileDir('codex', name));
  assert.throws(() => store.profileDir('unknown', 'A'));
  fs.mkdirSync(path.join(store.STORE_DIR, 'codex'), { recursive: true });
  fs.symlinkSync(root, path.join(store.STORE_DIR, 'codex', 'link'));
  assert.throws(() => store.profileDir('codex', 'link'), /符号链接/);
});
test('renaming a profile preserves credentials, snapshot and active selection', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'old');
  const snapshot = { state: 'ok', available: true, fetchedAt: new Date().toISOString() };
  store.writeProfileMeta('codex', 'old', { label: 'old', snapshot });
  await accounts.renameAccount(agent, 'old', 'new');
  assert.equal(store.profileExists('codex', 'old'), false);
  assert.equal(JSON.parse(readProfile('new')).tokens.account_id, 'A');
  assert.equal(store.getActiveProfile('codex'), 'new');
  assert.deepEqual(store.readProfileMeta('codex', 'new').snapshot, snapshot);
  assert.equal(store.readProfileMeta('codex', 'new').label, 'new');
  putProfile('other', 'B');
  await assert.rejects(accounts.renameAccount(agent, 'new', 'other'), /已被使用/);
  await assert.rejects(accounts.renameAccount(agent, 'new', '../bad'), /账号名称/);
  assert.equal(store.getActiveProfile('codex'), 'new');
});
test('live credentials roll back when active metadata commit fails', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'A'); putProfile('B', 'B');
  const original = store.setActiveProfile;
  store.setActiveProfile = () => { throw new Error('simulated disk failure'); };
  try { await assert.rejects(accounts.useAccount(agent, 'B', { saveUnmanaged: true }), /disk failure/); }
  finally { store.setActiveProfile = original; }
  assert.equal(agent.identity().id, 'A:A'); assert.equal(store.getActiveProfile('codex'), 'A');
});
test('credit balance changes are retained as recent activity', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  putLive('A'); await accounts.saveAccount(agent, 'A');
  let balance = '10.00';
  agent.queryLiveRpc = async () => ({ account: { email: 'A@example.test' }, rates: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 }, credits: { balance } } } });
  await accounts.refreshAccount(agent, undefined, true);
  balance = '8.50';
  t.mock.timers.tick(30000);
  const changed = await accounts.refreshAccount(agent, undefined, true);
  assert.equal(changed.quota.credits.balance, '8.50');
  assert.equal(changed.creditActivity.previousBalance, '10.00');
  assert.equal(changed.creditActivity.currentBalance, '8.50');
  t.mock.timers.tick(30000);
  const unchanged = await accounts.refreshAccount(agent, undefined, true);
  assert.deepEqual(unchanged.creditActivity, changed.creditActivity);
});
test('credential expiry preserves historical quota and plan but stops automatic retries', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  putProfile('expired','expired');
  const previous=await accounts.refreshAccount(agent,'expired',true);
  t.mock.timers.tick(30000);
  let calls=0;agent.queryLiveRpc=async()=>{calls++;throw new Error('凭据失效，请重新登录');};
  const result=await accounts.refreshAccount(agent,'expired',true);
  assert.equal(result.state,'expired');assert.equal(result.authExpired,true);
  assert.deepEqual(result.quota,JSON.parse(JSON.stringify(previous.quota)));assert.equal(result.plan,previous.plan);assert.equal(result.fetchedAt,previous.fetchedAt);
  await accounts.refreshAccount(agent,'expired');assert.equal(calls,1);
});
test('encrypted backup roundtrip preserves existing profiles and rejects wrong passwords', async () => {
  putProfile("O'Reilly & team", 'A');
  const data = await backup.exportBackup([{ agent: 'codex', profile: "O'Reilly & team" }], 'test-passphrase');
  assert.equal(fs.statSync(store.STORE_DIR).mode & 0o777, 0o700);
  assert.equal(data.subarray(0, 4).toString(), 'AGS1'); assert.equal(data.includes(Buffer.from('fake-access')), false);
  await assert.rejects(importBackup(data, 'incorrect'), /密码/);
  const imported = await importBackup(data, 'test-passphrase');
  assert.deepEqual(imported, {imported:[],skipped:[{key:"codex/O'Reilly & team",existing:"codex/O'Reilly & team"}]});
  assert.equal(store.profileExists('codex',"O'Reilly & team-import-1"),false);
  const tampered = Buffer.from(data); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(importBackup(tampered, 'test-passphrase'), /损坏/);
});
// Small stored ZIP builder, preserving malicious paths instead of archiver normalizing them.
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name), data = Buffer.from(text);
    let crc = -1;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ -1) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += h.length + n.length + data.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
test('legacy ZIP import validates all paths and credentials before committing', async () => {
  for (const name of ['codex/A/../AB/auth.json', 'codex/./auth.json', 'unknown/A/auth.json', 'codex/A/unexpected.txt']) {
    await assert.rejects(importBackup(zip([[name, auth('A')]])));
  }
  await assert.rejects(importBackup(zip([['codex/A/auth.json', auth('A')], ['codex/B/auth.json', '{}']])));
  assert.deepEqual(store.listProfiles('codex'), []);
  await importBackup(zip([['codex/A/auth.json', auth('A')], ['codex/A/config.toml', 'model="old"']]));
  assert.ok(store.profileExists('codex', 'A')); assert.equal(fs.existsSync(path.join(store.profileDir('codex', 'A'), 'config.toml')), false);
});
test('RPC waits for initialization and reads before requesting quota', async () => {
  const { CodexAgent } = require('../dist/agents/codex');
  const rpcAgent = new CodexAgent();
  const file = path.join(root, 'fake-codex');
  fs.writeFileSync(file, `#!${process.execPath}\nconst rl = require('readline').createInterface({input:process.stdin}); let step=0; rl.on('line', line=>{ const m=JSON.parse(line); const expected=['initialize','initialized','account/read','account/rateLimits/read'][step++]; if(m.method!==expected) process.exit(2); if(m.id===0) setTimeout(()=>process.stdout.write(JSON.stringify({id:0,result:{}})+'\\n'),20); if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{account:{type:'chatgpt',email:'fixture@example.test'}}})+'\\n'); if(m.id===2) process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:12}}}})+'\\n'); });`, { mode: 0o700 });
  rpcAgent.findCodexBinary = () => file;
  const result = await rpcAgent.queryLiveRpc(root);
  assert.equal(result.rates.rateLimits.primary.usedPercent, 12);
});

test('Codex CLI is found inside the current ChatGPT app bundle', () => {
  const { CodexAgent } = require('../dist/agents/codex');
  const appDir = path.join(root, 'ChatGPT.app');
  const bundled = path.join(appDir, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(new CodexAgent().findCodexBinary([appDir]), bundled);
});

test('live quota cache is invalidated after external login changes identity', async () => {
  putLive('A'); await accounts.refreshAccount(agent, undefined, true);
  putLive('C'); let calls = 0;
  agent.queryLiveRpc = async () => { calls++; return {account:{email:'C@example.test'},rates:{rateLimits:{primary:{usedPercent:5}}}}; };
  const status = await accounts.refreshAccount(agent);
  assert.equal(calls, 1); assert.equal(status.account, 'C@example.test');
});


test('preferences migrate legacy files and preserve the private-login option on display-only writes', async () => {
  const settings = require('../dist/settings');
  assert.deepEqual(settings.readSettings(), {showResetTimes:true,openPrivateLogin:true});
  fs.mkdirSync(store.STORE_DIR,{recursive:true});
  fs.writeFileSync(path.join(store.STORE_DIR,'settings.json'), JSON.stringify({showResetTimes:false,priorities:['reset','week','5h']}));
  assert.deepEqual(settings.readSettings(), {showResetTimes:false,openPrivateLogin:true});
  await settings.saveSettings({showResetTimes:false,openPrivateLogin:false});
  await settings.saveSettings({showResetTimes:true});
  const value = {showResetTimes:true,openPrivateLogin:false};
  assert.deepEqual(settings.readSettings(),value);
  await assert.rejects(settings.saveSettings({showResetTimes:'false'}), /无效/);
  await assert.rejects(settings.saveSettings({showResetTimes:true,openPrivateLogin:'false'}), /无效/);
  assert.deepEqual(settings.readSettings(), value);
});

test('saving named profile cleans up duplicate backup-* profiles and activeProfile prefers named profiles', async () => {
  putLive('A');
  await accounts.saveAccount(agent, 'backup-1234567890');
  assert.ok(store.listProfiles('codex').includes('backup-1234567890'));

  // Saving a user-named profile with the same identity should remove backup-1234567890
  await accounts.saveAccount(agent, 'my-account');
  assert.ok(store.listProfiles('codex').includes('my-account'));
  assert.ok(!store.listProfiles('codex').includes('backup-1234567890'));
  assert.equal(accounts.activeProfile(agent), 'my-account');
});


test('refresh deadlines honor active/pool intervals and query once after each reset', () => {
  const { quotaRefreshAt } = require('../dist/quota-refresh');
  const checked = 2000000000000;
  const status = {state:'ok',checkedAt:new Date(checked).toISOString()};
  assert.equal(quotaRefreshAt(status,true,checked),checked+60000);
  assert.equal(quotaRefreshAt(status,false,checked),checked+300000);
  const reset = checked+20000;
  status.quota = {primaryWindow:{usedPercent:100,resetsAt:reset/1000}};
  assert.equal(quotaRefreshAt(status,false,checked),reset+10000);
  status.checkedAt = new Date(reset+5000).toISOString();
  assert.equal(quotaRefreshAt(status,false,checked),reset+35000);
  status.checkedAt = new Date(reset+10000).toISOString();
  assert.equal(quotaRefreshAt(status,false,checked),reset+310000);
  status.state='error'; status.refreshFailures=1;
  assert.equal(quotaRefreshAt(status,true),reset+130000);
  status.refreshFailures=2;
  assert.equal(quotaRefreshAt(status,true),reset+310000);
  status.refreshFailures=3;
  assert.equal(quotaRefreshAt(status,true),reset+910000);
  status.state='expired'; assert.equal(quotaRefreshAt(status,true),Infinity);
});

test('reset refresh bypasses ordinary cache but never invents restored quota', async () => {
  putProfile('reset','reset');
  let calls=0;
  agent.queryLiveRpc=async()=>{calls++; return {rates:{rateLimits:{primary:{usedPercent:100,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)-20}}}};};
  const first=await accounts.refreshAccount(agent,'reset',true);
  const meta=store.readProfileMeta('codex','reset'); meta.snapshot.checkedAt=new Date(Date.now()-40000).toISOString(); store.writeProfileMeta('codex','reset',meta);
  const second=await accounts.refreshAccount(agent,'reset'); assert.equal(calls,2); assert.equal(second.quota.primaryWindow.usedPercent,100);
  await accounts.refreshAccount(agent,'reset'); assert.equal(calls,2);
  assert.equal(first.quota.primaryWindow.usedPercent,100);
});
