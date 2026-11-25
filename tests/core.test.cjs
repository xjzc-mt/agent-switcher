const { mockIdleClients, createTestHome, readCredentialFile, jwt, accessToken } = require('./helpers/test-env.cjs');
const locks = require('../dist/file-lock');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = createTestHome('ags-tests-');
mockIdleClients();
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
const auth = (id, token = 'refresh-' + id) => JSON.stringify({ tokens: { account_id: id, access_token: accessToken(id,id,id+'@example.test'), refresh_token: token, id_token: jwt({ sub: id, email: `${id}@example.test` }) } });
const putLive = (id, token) => atomicWrite(path.join(agent.homeDir, 'auth.json'), auth(id, token));
const putProfile = (name, id) => atomicWrite(path.join(store.profileDir('codex', name), 'auth.json'), auth(id));
const readProfile = name => readCredentialFile(path.join(store.profileDir('codex', name), 'auth.json'), 'utf8');
beforeEach(() => {
  for (const dir of [store.STORE_DIR, agent.homeDir]) fs.rmSync(dir, { recursive: true, force: true });
  agent.queryLiveRpc = async home => ({ account: { email: agent.identity(home).email, planType: 'plus' }, rates: { rateLimits: { primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 2000000000 } } } });
});

test('a linked store is rejected before locking or changing permissions on its destination', {skip: process.platform === 'win32'}, async () => {
  const external = fs.mkdtempSync(path.join(root, 'unmanaged-'));
  fs.chmodSync(external, 0o750);
  fs.symlinkSync(external, store.STORE_DIR, 'dir');
  await assert.rejects(store.withStoreLock(async () => assert.fail('unexpected lock')), /符号链接/);
  assert.equal(fs.statSync(external).mode & 0o777, 0o750);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('interrupted rename keeps both profiles when the destination has been taken', () => {
  const hop = 'work.rename-' + require('node:crypto').randomUUID();
  putProfile(hop, 'original');
  fs.mkdirSync(store.profileDir('codex', 'Work'));
  const unrelated = path.join(store.STORE_DIR, 'codex', 'Work');
  const externalInode = fs.statSync(unrelated).ino;
  fs.writeFileSync(store.PENDING_RENAME_FILE, JSON.stringify({
    agentId: 'codex', oldName: 'work', newName: 'Work', hopName: hop, wasPreferred: true, hadLabel: false,
  }));
  assert.ok(store.listProfiles('codex').includes(hop));
  assert.equal(fs.statSync(unrelated).ino, externalInode);
  assert.equal(readProfile(hop), auth('original'));
  assert.equal(store.getActiveProfile('codex'), undefined);
  assert.ok(fs.readdirSync(store.STORE_DIR).some(p => p.startsWith('.retained-rename-')));
  fs.writeFileSync(store.PENDING_RENAME_FILE, JSON.stringify({ agentId: 'codex', oldName: null, newName: 'Work', hopName: hop }));
  assert.ok(store.listProfiles('codex').includes(hop));
});

test('import names agree on Unicode equivalents and a long profile can change capitalization', async () => {
  const {parseCredentialBatch, installCredentialBatch} = require('../dist/credential-import');
  const composed = 'Café', decomposed = composed.normalize('NFD');
  putProfile(composed, 'first');
  const batch = await parseCredentialBatch(Buffer.from(auth('second')), 'codex', decomposed + '.json');
  const item = batch.items[0];
  assert.equal(item.profile, decomposed + ' (2)');
  await assert.rejects(installCredentialBatch(batch, [item.key], {[item.key]: decomposed}), /名称.*使用/);
  assert.equal(readProfile(composed), auth('first'));
  const long = '栈'.repeat(72) + 'abc';
  putProfile(long, 'third');
  await assert.rejects(accounts.renameAccount(agent, long, composed.toUpperCase()), /已被使用/);
  await accounts.renameAccount(agent, long, long.toUpperCase());
  assert.ok(store.listProfiles('codex').includes(long.toUpperCase()));
  assert.equal(readProfile(long.toUpperCase()), auth('third'));
});

test('current quota plan wins over older login claims and missing plans fall back', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  putProfile('plan-fallback', 'A');
  for(const [reported,expected] of [['prolite','prolite'],['promax','promax'],['plus','plus'],['unknown','pro'],[undefined,'pro']]) {
    agent.queryLiveRpc=async()=>({account:{email:'A@example.test',planType:'pro'},rates:{rateLimits:{planType:reported,primary:{usedPercent:30}}}});
    assert.equal((await accounts.refreshAccount(agent, 'plan-fallback', true)).plan,expected);
    t.mock.timers.tick(31000);
  }
});

test('incomplete profiles fail without changing live credentials or active metadata', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'A');
  atomicWrite(path.join(store.profileDir('codex', 'partial'), 'config.toml'), 'model="other"');
  await assert.rejects(accounts.useAccount(agent, 'partial', { saveUnmanaged: true }), /认证/);
  assert.equal(agent.identity().id, 'A:A'); assert.equal(store.getActiveProfile('codex'), 'A');
});
test('saving without a login leaves the active profile unchanged', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'A');
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

test('portable profile names protect existing accounts and allow correction of legacy backups', async () => {
  putLive('A'); await accounts.saveAccount(agent, 'work');
  await assert.rejects(accounts.saveAccount(agent, 'CON'), /保留名/);
  await assert.rejects(accounts.renameAccount(agent, 'work', 'Team:A'), /账号名称/);
  assert.equal(readProfile('work'), auth('A'));
  assert.throws(() => store.validateName('lpt².txt'), /保留名/);
  if (process.platform === 'win32') {
    assert.throws(() => store.profileDir('codex', 'work.'), /以点结尾/);
    return;
  }
  fs.renameSync(store.profileDir('codex', 'work'), path.join(store.STORE_DIR, 'codex', 'work.'));
  store.writeProfileMeta('codex', 'work.', { snapshot: { state: 'expired', authExpired: true, available: true } });
  const update = await backup.previewCredentialUpdate(Buffer.from(auth('A', 'renewed')), 'codex', 'work.');
  assert.equal((await backup.installCredentialUpdate(update.parsed, update.target)).profile, 'work.');
  assert.equal(readProfile('work.'), auth('A')); // Session updates wait for verification.
  const archive = await backup.exportBackup([{ agent: 'codex', profile: 'work.' }], 'test-passphrase');
  await accounts.renameAccount(agent, 'work.', 'restored');
  assert.equal(readProfile('restored'), auth('A'));
  fs.rmSync(store.profileDir('codex', 'restored'), { recursive: true });
  const parsed = await backup.parseBackup(archive, 'test-passphrase');
  const key = parsed.items[0].key;
  await assert.rejects(backup.installBackup(parsed, [key]), /以点结尾/);
  const imports = require('../dist/credential-import');
  const preview = imports.editableBackup(parsed);
  await imports.installCredentialBatch(preview, [key], { [key]: 'team' });
  assert.equal(readProfile('team'), auth('A'));
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
test('encrypted backups normalize passphrases and reject changed ciphertext', async () => {
  putProfile("O'Reilly & team", 'A');
  const password = 'café42';
  await assert.rejects(backup.encryptBackup(Buffer.alloc(0), '12345'), /至少需要 6 个字符/);
  const data = await backup.exportBackup([{ agent: 'codex', profile: "O'Reilly & team" }], password);
  assert.equal(fs.statSync(store.STORE_DIR).mode & 0o777, 0o700);
  assert.equal(data.subarray(0, 4).toString(), 'AGS2'); assert.equal(data.includes(Buffer.from('fake-access')), false);
  const parsed = await backup.parseBackup(data, password.normalize('NFD'));
  const [entry] = parsed.items;
  assert.equal(JSON.parse(parsed.groups.get(entry.key).get('_meta.json')).email, 'A@example.test');
  const tampered = Buffer.from(data); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(importBackup(tampered, password), /损坏/);
});

test('export only accepts selections and native JSON that the same backup reader can restore', async () => {
  const profile = { agent: 'codex', profile: 'work' };
  putProfile(profile.profile, 'account');
  await assert.rejects(backup.exportBackup([profile, profile], 'test-passphrase'), /重复选择/);
  const file = path.join(store.profileDir('codex', profile.profile), 'auth.json');
  atomicWrite(file, auth('account').replace('"account_id":', '"account_id":"account","account_id":'));
  await assert.rejects(backup.exportBackup([profile], 'test-passphrase'), /重复字段/);
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
  const retired = [['claude/old/.credentials.json', 'legacy bytes'], ['claude/old/_meta.json', '{}']];
  await assert.rejects(backup.parseBackup(zip(retired)), /没有受支持的平台账号/);
  const mixed = await backup.parseBackup(zip([['codex/A/auth.json', auth('A')], ['codex/A/config.toml', 'model="old"'], ...retired]));
  assert.equal(mixed.skippedProfiles, 1);
  assert.deepEqual([...mixed.groups.keys()], ['codex/A']);
  await backup.installBackup(mixed, ['codex/A']);
  assert.ok(store.profileExists('codex', 'A')); assert.equal(fs.existsSync(path.join(store.profileDir('codex', 'A'), 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(store.STORE_DIR, 'claude')), false);
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


test('preferences migrate legacy files and preserve independent options on partial writes', async () => {
  const settings = require('../dist/settings');
  assert.deepEqual(settings.readSettings(), {showResetTimes:true,openPrivateLogin:true,liveRefreshInterval:'1m',spareRefreshInterval:'5m'});
  fs.mkdirSync(store.STORE_DIR,{recursive:true});
  fs.writeFileSync(path.join(store.STORE_DIR,'settings.json'), JSON.stringify({showResetTimes:false,priorities:['reset','week','5h'],autoRefreshInterval:'15m'}));
  assert.deepEqual(settings.readSettings(), {showResetTimes:false,openPrivateLogin:true,liveRefreshInterval:'3m',spareRefreshInterval:'15m'});
  await settings.saveSettings({showResetTimes:false,openPrivateLogin:false,liveRefreshInterval:'1m',spareRefreshInterval:'manual'});
  await settings.saveSettings({showResetTimes:true});
  const value = {showResetTimes:true,openPrivateLogin:false,liveRefreshInterval:'1m',spareRefreshInterval:'manual'};
  assert.deepEqual(settings.readSettings(),value);
  await assert.rejects(settings.saveSettings({showResetTimes:'false'}), /无效/);
  await assert.rejects(settings.saveSettings({showResetTimes:true,openPrivateLogin:'false'}), /无效/);
  assert.deepEqual(settings.readSettings(), value);
});

test('refresh deadlines honor independent intervals and query once after each reset', () => {
  const { quotaRefreshAt } = require('../dist/quota-refresh');
  const checked = 2000000000000;
  const status = {state:'ok',checkedAt:new Date(checked).toISOString()};
  const policy = require('../renderer/account-policy');
  for (const [interval, minutes, staleMinutes] of [['1m',1,5], ['3m',3,5], ['5m',5,5], ['15m',15,16], ['30m',30,31], ['manual',Infinity,30]]) {
    assert.equal(quotaRefreshAt(status,interval,checked), checked + minutes * 60000);
    assert.equal(quotaRefreshAt({...status,state:'error'},interval,checked), checked + Math.max(2,minutes) * 60000);
    const sample = { ...status, fetchedAt: status.checkedAt };
    for (const delta of [0,1]) assert.equal(policy.stale(sample,checked+staleMinutes*60000+delta,'codex',interval),delta===1);
  }
  const reset = checked+20000;
  status.quota = {primaryWindow:{usedPercent:100,resetsAt:reset/1000}};
  assert.equal(quotaRefreshAt(status,'5m',checked),reset+10000);
  assert.equal(quotaRefreshAt(status,'30m',checked),reset+10000);
  assert.equal(quotaRefreshAt(status,'manual',checked),Infinity);
  assert.equal(quotaRefreshAt(undefined,'manual',checked),Infinity);
  status.checkedAt = new Date(reset+5000).toISOString();
  assert.equal(quotaRefreshAt(status,'5m',checked),reset+35000);
  status.checkedAt = new Date(reset+10000).toISOString();
  assert.equal(quotaRefreshAt(status,'5m',checked),reset+310000);
  status.state='error'; status.refreshFailures=1;
  assert.equal(quotaRefreshAt(status,'1m'),reset+130000);
  status.refreshFailures=2;
  assert.equal(quotaRefreshAt(status,'1m'),reset+310000);
  status.refreshFailures=3;
  assert.equal(quotaRefreshAt(status,'1m'),reset+910000);
  status.state='expired'; assert.equal(quotaRefreshAt(status,'1m'),Infinity);
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

test('large AGS2 backups restore and historical AGS1 archives parse within KDF and ZIP bounds', async () => {
  const { scryptSync, randomBytes, createCipheriv } = require('node:crypto');
  const { ZipFile } = require('yazl');
  const unzipper = require('unzipper');

  // 1. 201 accounts exported with current AGS2 format can be completely restored!
  const items = [];
  for (let i = 0; i < 201; i++) {
    const name = `acct-${String(i).padStart(3, '0')}`;
    putProfile(name, `id-${i}`);
    items.push({ agent: 'codex', profile: name });
  }
  const blob201 = await backup.exportBackup(items, 'large-backup-pass');
  assert.equal(blob201.subarray(0, 4).toString(), 'AGS2');
  fs.rmSync(store.STORE_DIR, { recursive: true, force: true });
  const restored = await importBackup(blob201, 'large-backup-pass');
  assert.equal(restored.imported.length, 201);
  assert.equal(store.listProfiles('codex').length, 201);

  // AGS1 used the original scrypt defaults and authenticated only its magic header.
  const oldZipBytes = zip(items.map(({ profile }) => [`codex/${profile}/auth.json`, readProfile(profile)]));
  const magic1 = Buffer.from('AGS1'), salt = randomBytes(16), iv = randomBytes(12);
  const k1 = scryptSync('hist-pass', salt, 32);
  const c1 = createCipheriv('aes-256-gcm', k1, iv); c1.setAAD(magic1);
  const body1 = Buffer.concat([c1.update(oldZipBytes), c1.final()]);
  const oldBlob = Buffer.concat([magic1, salt, iv, c1.getAuthTag(), body1]);
  const historical = await backup.parseBackup(oldBlob, 'hist-pass');
  assert.deepEqual(historical.items.map(item => item.profile), items.map(item => item.profile));

  // 3. Unauthenticated excessive scrypt parameters in AGS2 are rejected BEFORE key derivation!
  const badCost = Buffer.concat([Buffer.from('AGS2'), Buffer.from([1, 20, 16, 8]), randomBytes(44)]);
  const t0 = Date.now();
  await assert.rejects(backup.decryptBackup(badCost, 'large-backup-pass'), /版本或参数不受支持/);
  assert.ok(Date.now() - t0 < 100, 'excessive scrypt parameters must fail immediately before deriving');

  // 4. C1 & C2: Export enforces single-file, _meta.json, uncompressed total, and final encrypted package bounds; ZIP pre-check matches unzipper on multi-disk, ZIP64, and tail comment!
  putProfile('meta-huge', 'meta-u');
  fs.writeFileSync(path.join(store.profileDir('codex', 'meta-huge'), '_meta.json'), JSON.stringify({ label: 'x'.repeat(1024 * 1024 + 50), email: 'm@example.test' }));
  await assert.rejects(backup.exportBackup([{ agent: 'codex', profile: 'meta-huge' }], 'large-backup-pass'), /文件过大/);
  fs.rmSync(store.profileDir('codex', 'meta-huge'), { recursive: true, force: true });

  // C1: Oversized uncompressed total AND final encrypted .ags > 32MB are rejected at exportBackup; any accepted export can be imported!
  fs.rmSync(store.STORE_DIR, { recursive: true, force: true });
  const overItems = [];
  for (let i = 0; i < 37; i++) {
    const name = `rnd-${i}`;
    const pad = randomBytes(700 * 1024).toString('base64');
    const dirPath = store.profileDir('codex', name);
    fs.mkdirSync(dirPath, { recursive: true });
    require('../dist/utils').atomicWrite(path.join(dirPath, 'auth.json'), Buffer.from(JSON.stringify({ tokens: { access_token: `a-${i}`, refresh_token: pad, email: `u${i}@example.test` } })));
    overItems.push({ agent: 'codex', profile: name });
  }
  await assert.rejects(backup.exportBackup(overItems, 'large-backup-pass'), /备份.*过大/);

  // Final encrypted package length > 32MB even when uncompressed sum <= 32MB is also rejected at exportBackup:
  const origAddBuffer = ZipFile.prototype.addBuffer;
  ZipFile.prototype.addBuffer = function (buf, name) { return origAddBuffer.call(this, buf, name, { compress: false }); };
  try {
    fs.rmSync(store.STORE_DIR, { recursive: true, force: true });
    const exactPkgOverflow = [];
    for (let i = 0; i < 34; i++) {
      const name = `pkg-${i}`;
      const dirPath = store.profileDir('codex', name);
      fs.mkdirSync(dirPath, { recursive: true });
      // Each account auth + _meta.json ~986,880B (< 1MB MAX_FILE); 34 * 986,880 = 33,553,920B <= 33,554,432B (32MB), but + ZIP headers + 52B AGS2 > 32MB!
      const pad = 'P'.repeat(986750);
      require('../dist/utils').atomicWrite(path.join(dirPath, 'auth.json'), Buffer.from(JSON.stringify({ tokens: { access_token: `a-${i}`, refresh_token: pad, email: 'x@y.z' } })));
      exactPkgOverflow.push({ agent: 'codex', profile: name });
    }
    await assert.rejects(backup.exportBackup(exactPkgOverflow, 'large-backup-pass'), /备份文件过大/);
  } finally { ZipFile.prototype.addBuffer = origAddBuffer; }

  fs.rmSync(store.STORE_DIR, { recursive: true, force: true });
  const baseZip = zip([['codex/zip-check/auth.json', auth('zip-check')]]);
  const cdPos = baseZip.readUInt32LE(baseZip.length - 6);
  const nameLen = baseZip.readUInt16LE(cdPos + 28);
  const zip64Extra = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  const zipWith64Extra = Buffer.concat([
    baseZip.subarray(0, cdPos + 46 + nameLen),
    zip64Extra,
    baseZip.subarray(cdPos + 46 + nameLen),
  ]);
  zipWith64Extra.writeUInt16LE(zip64Extra.length, cdPos + 30);
  zipWith64Extra.writeUInt32LE(baseZip.readUInt32LE(baseZip.length - 10) + zip64Extra.length, zipWith64Extra.length - 10);

  // C2: ZIP pre-check rejects excessive entries, diskNumber=0xffff (ZIP64 trigger in unzipper!), multi-disk, ZIP64 extra field, and fake EOCD in comment BEFORE unzipper.Open.buffer runs!
  const eocdTooMany = Buffer.alloc(22);
  eocdTooMany.writeUInt32LE(0x06054b50, 0);
  eocdTooMany.writeUInt16LE(10001, 8);
  eocdTooMany.writeUInt16LE(10001, 10);

  const zipDisk64 = Buffer.from(baseZip);
  zipDisk64.writeUInt16LE(0xffff, zipDisk64.length - 22 + 4); // diskNumber = 0xffff while totalEntries = 1!

  const zipMultiDisk = Buffer.from(baseZip);
  zipMultiDisk.writeUInt16LE(1, zipMultiDisk.length - 22 + 6); // diskStart = 1

  const fakeComment = Buffer.alloc(30, 0x41);
  fakeComment.writeUInt32LE(0x06054b50, 4); // Fake EOCD signature inside comment!
  const zipFakeComment = Buffer.concat([baseZip, fakeComment]);
  zipFakeComment.writeUInt16LE(fakeComment.length, baseZip.length - 2);

  // Valid ZIP with 160-byte comment (> unzipper's default 80-byte tailSize) must succeed cleanly!
  const cleanComment = Buffer.alloc(160, 0x42);
  const zipLongComment = Buffer.concat([baseZip, cleanComment]);
  zipLongComment.writeUInt16LE(cleanComment.length, baseZip.length - 2);
  const parsedLongComment = await backup.parseBackup(zipLongComment);
  assert.equal(parsedLongComment.items[0].profile, 'zip-check');

  const origOpenBuffer = unzipper.Open.buffer;
  let openBufferCalls = 0;
  unzipper.Open.buffer = (...args) => { openBufferCalls++; return origOpenBuffer(...args); };
  try {
    await assert.rejects(backup.parseBackup(eocdTooMany), /过多条目/);
    await assert.rejects(backup.parseBackup(zipDisk64), /分卷或 ZIP64/);
    await assert.rejects(backup.parseBackup(zipMultiDisk), /分卷或 ZIP64/);
    await assert.rejects(backup.parseBackup(zipWith64Extra), /分卷或 ZIP64/);
    await assert.rejects(backup.parseBackup(zipFakeComment), /格式无效或已损坏/);
    assert.equal(openBufferCalls, 0, 'unzipper.Open.buffer must never be called on rejected ZIP headers');
  } finally { unzipper.Open.buffer = origOpenBuffer; }
});

test('store lock serializes writers, protects a successor from a paused reaper and bounds retries', async () => {
  const { spawn } = require('node:child_process');
  const vault = require('../dist/credential-vault');
  const lockDir = path.join(store.STORE_DIR, '.lock');
  fs.rmSync(store.STORE_DIR, { recursive: true, force: true });
  fs.mkdirSync(store.STORE_DIR, { recursive: true });

  // 1. Two contenders competing on a dead legacy lock both complete mutually exclusively.
  fs.writeFileSync(lockDir, '2147483647\ndead-race');
  const order = [];
  await Promise.all([
    store.withStoreLock(async () => { order.push(1); await new Promise(r => setTimeout(r, 40)); order.push(2); }),
    store.withStoreLock(async () => { order.push(3); await new Promise(r => setTimeout(r, 40)); order.push(4); }),
  ]);
  assert.ok(JSON.stringify(order) === '[1,2,3,4]' || JSON.stringify(order) === '[3,4,1,2]');
  assert.equal(fs.existsSync(lockDir), false);

  const successor = locks.tryAcquireAtomicLock(lockDir, String(process.pid));
  assert.ok(successor);
  assert.equal(locks.releaseAtomicLock(lockDir, 'stale-owner'), false);
  assert.equal(locks.releaseAtomicLock(lockDir, successor), true);

  if (process.platform !== 'win32') {
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, '2147483647-dead-owner'), '2147483647\ndead');
    // Pause the first reaper just before unlink; this process reaps and acquires a new lock.
    const reaper = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path');
      const lock = process.argv[1], unlink = fs.unlinkSync;
      fs.unlinkSync = file => {
        if (path.dirname(file) === lock) {
          fs.writeSync(1, 'ready\\n');
          fs.readSync(0, Buffer.alloc(1), 0, 1, null);
        }
        return unlink(file);
      };
      require('./dist/file-lock').evictDeadLock(lock);
    `, lockDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    const { once } = require('node:events');
    const closed = once(reaper, 'close');
    try {
      const ready = await Promise.race([once(reaper.stdout, 'data'), closed]);
      assert.equal(String(ready[0]).trim(), 'ready');
      assert.equal(locks.evictDeadLock(lockDir), true);
      const newOwner = locks.tryAcquireAtomicLock(lockDir, String(process.pid));
      assert.ok(newOwner);
      reaper.stdin.end('g');
      assert.deepEqual(await closed, [0, null]);
      assert.deepEqual(fs.readdirSync(lockDir), [newOwner]);
      assert.equal(locks.releaseAtomicLock(lockDir, newOwner), true);
    } finally {
      if (reaper.exitCode === null && reaper.signalCode === null) reaper.kill('SIGKILL');
    }
  }

  // 5. Undeletable dead lock backs off cleanly and respects bounded deadline (never spins infinitely!).
  fs.mkdirSync(lockDir, { mode: 0o700 });
  const stuckEntry = path.join(lockDir, '2147483647-stuck');
  fs.writeFileSync(stuckEntry, '2147483647\nstuck');
  const origUnlink = fs.unlinkSync;
  let unlinkAttempts = 0;
  const realNow = Date.now;
  let fakeElapsed = 0;
  Date.now = () => realNow() + fakeElapsed;
  fs.unlinkSync = target => {
    if (target === stuckEntry) {
      unlinkAttempts++;
      fakeElapsed += 7000;
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    }
    return origUnlink(target);
  };
  try {
    await assert.rejects(store.withStoreLock(async () => {}), /仍在进行/);
    assert.ok(unlinkAttempts >= 1 && unlinkAttempts <= 5, 'must back off and exit at deadline rather than busy-spinning');
  } finally {
    fs.unlinkSync = origUnlink;
    Date.now = realNow;
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('P2 #12 & C4: corrupted pool profile does not block CLI, sync step-2 failure rolls back, and mid-rename crash recovers cleanly on restart', async () => {
  const { execFileSync, spawnSync } = require('node:child_process');

  // 1. Failed 2nd step of case-only rename ('work' -> hop -> 'Work') restores 'work' cleanly with consistent metadata & active pointer!
  putLive('rename-user');
  await accounts.saveAccount(agent, 'work');
  store.writeProfileMeta('codex', 'work', { label: 'work', email: 'rename-user@example.test' });
  const origRename = fs.renameSync;
  let renameCount = 0;
  fs.renameSync = (from, to) => {
    if (String(from).includes('.rename-') && String(to).endsWith(`${path.sep}Work`)) {
      renameCount++;
      throw new Error('simulated second rename failure');
    }
    return origRename(from, to);
  };
  try {
    await assert.rejects(accounts.renameAccount(agent, 'work', 'Work'), /second rename failure/);
  } finally { fs.renameSync = origRename; }
  assert.equal(renameCount, 1);
  assert.deepEqual(store.listProfiles('codex'), ['work']);
  assert.equal(store.getActiveProfile('codex'), 'work');
  assert.equal(store.readProfileMeta('codex', 'work').label, 'work');
  assert.equal(readProfile('work'), auth('rename-user'));

  // A second AGS process listing accounts while the writer owns the journal must leave it alone.
  const reader = `
    require('os').homedir = () => process.env.AGS_TEST_HOME;
    const store = require('./dist/store');
    store.listProfiles('codex');
    process.stdout.write(String(require('fs').existsSync(store.PENDING_RENAME_FILE)));
  `;
  const readFromChild = () => execFileSync(process.execPath, ['-e', reader], {
    env: { ...process.env, AGS_TEST_HOME: root }, encoding: 'utf8',
  });
  let observed = 0;
  fs.renameSync = (from, to) => {
    if (from === path.join(store.STORE_DIR, 'codex', 'work') || String(from).includes('.rename-') && to.endsWith(path.sep + 'Work')) {
      assert.equal(readFromChild(), 'true');
      observed++;
    }
    return origRename(from, to);
  };
  try {
    await accounts.renameAccount(agent, 'work', 'Work');
  } finally { fs.renameSync = origRename; }
  assert.equal(observed, 2);
  await accounts.renameAccount(agent, 'Work', 'work');

  // 1b. C4: Process hard-aborts (SIGKILL/exit) right between rename step 1 ('work' -> '.rename-*') and step 2 ('Work')!
  // On restart, account is deterministically accessible as 'Work' with consistent active reference, metadata, and dashboard list!
  const crashRes = spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), path = require('path'), os = require('os');
    os.homedir = () => process.env.AGS_TEST_HOME;
    require('./tests/helpers/test-env.cjs').installMockKeychain();
    const accounts = require('./dist/accounts');
    const { codexAgent } = require('./dist/agents/codex');
    const orig = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(from).includes('.rename-') && String(to).endsWith(path.sep + 'Work')) {
        process.kill(process.pid, 'SIGKILL');
      }
      return orig(from, to);
    };
    accounts.renameAccount(codexAgent, 'work', 'Work');
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, AGS_TEST_HOME: root } });
  assert.equal(crashRes.signal, 'SIGKILL');
  // Before restart reconciliation, the intermediate .rename-* directory was left on disk; now access in fresh/restarted state reconciles cleanly!
  assert.deepEqual(store.listProfiles('codex'), ['Work']);
  assert.equal(store.profileExists('codex', 'Work'), true);
  assert.equal(store.getActiveProfile('codex'), 'Work');
  assert.equal(store.readProfileMeta('codex', 'Work').label, 'Work');
  assert.equal(readProfile('Work'), auth('rename-user'));
  const codexDash = accounts.dashboard().find(a => a.id === 'codex');
  assert.equal(codexDash.active, 'Work');
  assert.deepEqual(codexDash.profiles.map(p => p.name), ['Work']);
  putProfile('team.rename-production', 'independent');
  assert.ok(store.listProfiles('codex').includes('team.rename-production'));

  // 2. Corrupted pool profile does NOT block CLI list / use / save / rm, is identified in `ags list`, and can be removed!
  putProfile('healthy-b', 'user-b');
  const badDir = store.profileDir('codex', 'broken-card');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'auth.json'), '{corrupted-plaintext');
  const invalidName = 'trailing space ';
  fs.mkdirSync(path.join(store.STORE_DIR, 'codex', invalidName));
  assert.equal(accounts.dashboard().find(a => a.id === 'codex').profiles.find(p => p.name === invalidName).meta.snapshot.state, 'error');
  // Even if broken-card has _meta.json with same email as a new account, saving new account still works!
  store.writeProfileMeta('codex', 'broken-card', { email: 'new-save@example.test' });
  putLive('new-save');
  await accounts.saveAccount(agent, 'fresh-saved');
  assert.equal(store.profileExists('codex', 'fresh-saved'), true);

  // Exercise actual CLI entry (`src/index.ts` preAction -> maintainCredentialStorage + list + rm) in a child process!
  const cliOut = execFileSync(process.execPath, [
    '-e',
    'const os=require("os");os.homedir=()=>process.env.AGS_TEST_HOME;require("./tests/helpers/test-env.cjs").installMockKeychain();require("./dist/clients").runningClients=async()=>[];require("./dist/index.js");',
    'node', 'list', 'codex',
  ], { cwd: path.join(__dirname, '..'), env: { ...process.env, AGS_TEST_HOME: root }, encoding: 'utf8' });
  assert.match(cliOut, /healthy-b/);
  assert.match(cliOut, /broken-card.*格式异常/);
  assert.match(cliOut, /trailing space .*账号名称/);

  // Removing the corrupted profile works cleanly via actual CLI `ags rm codex broken-card --yes`!
  const rmOut = execFileSync(process.execPath, [
    '-e',
    'const os=require("os");os.homedir=()=>process.env.AGS_TEST_HOME;require("./tests/helpers/test-env.cjs").installMockKeychain();require("./dist/index.js");',
    'node', 'rm', 'codex', 'broken-card', '--yes',
  ], { cwd: path.join(__dirname, '..'), env: { ...process.env, AGS_TEST_HOME: root }, encoding: 'utf8' });
  assert.match(rmOut, /已移除 1 条备份/);
  assert.equal(store.profileExists('codex', 'broken-card'), false);
});
