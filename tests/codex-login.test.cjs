const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-browser-test-'));
os.homedir = () => root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const opened = [], copied = [], handlers = new Map();
const privateOpened = [];
let failOpen = false, privateSupported = true;
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {}, getApplicationInfoForProtocol:async()=>({path:'/Applications/Fixture Browser.app'}) },
    ipcMain: { handle: (id, fn) => handlers.set(id, fn) },
    shell: { openExternal: async url => { if (failOpen) throw new Error(url); opened.push(url); } },
    clipboard: { writeText: url => copied.push(url) },
  };
  return load.call(this, name, ...args);
};
try { require('../dist/main'); } finally { Module._load = load; }
const { codexAgent } = require('../dist/agents/codex');
const store = require('../dist/store');
const settings = require('../dist/settings');
require('../dist/private-browser').openPrivateBrowser = async (browser,url) => {
  assert.equal(browser,'/Applications/Fixture Browser.app');
  privateOpened.push(url); return privateSupported;
};
const senderFrame = {url: pathToFileURL(path.join(__dirname, '../renderer/index.html')).href};
const invoke = (channel, ...args) => handlers.get(channel)({senderFrame}, ...args);

test('login IPC routes each provider independently and respects isolated-login capability', async t => {
  const managers = { codex: require('../dist/codex-login').codexLogin, agy: require('../dist/antigravity-login').antigravityLogin };
  const agent = require('../dist/agents/antigravity').antigravityAgent, calls = [];
  t.mock.method(agent, 'management', () => ({ isolatedLogin: true }));
  for (const [id, manager] of Object.entries(managers)) {
    for (const method of ['status', 'save', 'update', 'cancel']) t.mock.method(manager, method, (...args) => { calls.push([id, method, ...args]); return { ok: true }; });
    t.mock.method(manager, 'useLink', async (deliver, ...args) => { calls.push([id, 'useLink', ...args]); await deliver('https://example.test/login'); return { ok: true }; });
  }
  for (const id of Object.keys(managers)) {
    for (const [channel, args] of [['login-status', []], ['save-profile', ['account', 7]], ['update-from-login', ['account', 7]], ['launch-login', ['copy', 7, 'account']], ['cancel-login', []]]) {
      assert.equal((await invoke(channel, id, ...args)).ok, true);
    }
    assert.deepEqual(calls.splice(0), [[id, 'status'], [id, 'save', 'account', 7], [id, 'update', 'account', 7], [id, 'useLink', 7, 'account'], [id, 'cancel']]);
  }
  assert.equal((await invoke('cancel-login')).ok, true);
  assert.deepEqual(calls.splice(0), [['codex', 'cancel'], ['agy', 'cancel']]);
  t.mock.method(agent, 'management', () => ({ isolatedLogin: false }));
  assert.match((await invoke('update-from-login', 'agy', 'account', 7)).error, /暂不支持/);
  assert.deepEqual(calls, []);
});
const cli = path.join(root, 'codex');
const behavior = path.join(root, 'behavior');
const live = path.join(root, 'live');
Object.defineProperty(codexAgent, 'homeDir', {value: live});
codexAgent.findCodexBinary = () => cli;
const credentials = email => JSON.stringify({tokens: {email, account_id: email, access_token: 'fixture-access', refresh_token: 'fixture-refresh'}});
fs.mkdirSync(live);
const original = credentials('A@example.test');
fs.writeFileSync(path.join(live, 'auth.json'), original);
fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), rl = require('readline').createInterface({input:process.stdin});
const behavior = fs.readFileSync(path.join(__dirname, 'behavior'), 'utf8');
if (behavior === 'exit') process.exit(0);
const home = process.env.CODEX_HOME, loginId = path.basename(home);
fs.appendFileSync(path.join(__dirname, 'login-homes'), home + '\\n');
if (process.cwd() !== fs.realpathSync(home) || !process.argv.includes('app-server') || !process.argv.includes('cli_auth_credentials_store="file"')) process.exit(2);
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({id:msg.id,result:{}});
  if (msg.method === 'account/login/start') {
    fs.writeFileSync(path.join(home, 'started'), '');
    if (behavior !== 'hold') send({id:msg.id,result:{type:'chatgpt',loginId,authUrl:
      (behavior === 'invalid' ? 'https://unrelated.example' : 'https://auth.openai.com') + '/oauth/authorize?state=' + loginId}});
  }
  if (msg.method === 'account/login/cancel') send({id:msg.id,result:{status:'canceled'}});
});
let pendingCredentials;
const timer = setInterval(() => {
  const file = path.join(home, 'browser-result');
  if (!fs.existsSync(file)) return;
  const result = JSON.parse(fs.readFileSync(file));
  fs.unlinkSync(file);
  if (result.credentials) {
    if (behavior === 'late-write') pendingCredentials = result.credentials;
    else fs.writeFileSync(path.join(home, 'auth.json'), result.credentials);
  }
  send({method:'account/login/completed',params:{loginId:result.foreign ? 'another-login' : loginId,success:result.success ?? !!result.credentials}});
}, 5);
rl.on('close', () => {
  clearInterval(timer);
  if (pendingCredentials) setTimeout(() => fs.writeFileSync(path.join(home, 'auth.json'), pendingCredentials), 60);
});
`, {mode: 0o700});
const dirs = () => {
  const file = path.join(root, 'login-homes');
  return fs.existsSync(file) ? readCredentialFile(file, 'utf8').trim().split('\n').filter(dir => fs.existsSync(dir)) : [];
};
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for fixture');
}
function expiredProfile(name, email) {
  const dir = store.profileDir('codex', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), credentials(email));
  store.writeProfileMeta('codex', name, { label: '原昵称', quotaNote: '保留备注', snapshot: {
    state: 'expired', available: true, authExpired: true, quota: { primaryWindow: { usedPercent: 20 } },
  } });
  return dir;
}
async function completeLogin(email, tokens = {}) {
  const auth = JSON.parse(credentials(email));
  auth.tokens.refresh_token = 'fixture-replacement';
  Object.assign(auth.tokens, tokens);
  fs.writeFileSync(path.join(dirs()[0], 'browser-result'), JSON.stringify({ credentials: JSON.stringify(auth) }));
  return until(async () => { const status = await invoke('login-status', 'codex'); return status.ready && status; });
}
afterEach(async () => {
  await invoke('cancel-login'); failOpen = false; copied.length = 0; opened.length = 0;
  privateOpened.length = 0; privateSupported = true;
  await settings.saveSettings({showResetTimes:true,openPrivateLogin:true});
  assert.deepEqual(dirs(), []);
  assert.equal(readCredentialFile(path.join(live, 'auth.json'), 'utf8'), original);
});
after(() => fs.rmSync(root, {recursive: true, force: true}));

test('login waits for credentials flushed on EOF before exposing save', async () => {
  fs.writeFileSync(behavior, 'late-write');
  assert.equal((await invoke('launch-login', 'codex', 'copy')).ok, true);
  const ready = await completeLogin('late-write@example.test');
  assert.equal((await invoke('save-profile', 'codex', 'late-write', ready.attempt)).ok, true);
  assert.equal(codexAgent.identity(store.profileDir('codex', 'late-write')).email, 'late-write@example.test');
});

test('login reports spawn failure and early exit, then permits retry', async t => {
  const find = t.mock.method(codexAgent, 'findCodexBinary', () => path.join(root, 'missing-cli'));
  assert.match((await invoke('launch-login', 'codex', 'copy')).error, /无法启动 Codex CLI/);
  find.mock.restore();
  fs.writeFileSync(behavior, 'exit');
  assert.match((await invoke('launch-login', 'codex', 'copy')).error, /登录已结束/);
  fs.writeFileSync(behavior, 'normal');
  assert.equal((await invoke('launch-login', 'codex', 'copy')).ok, true);
});

test('private login, ordinary login and copying share one attempt; preference and unsupported browsers fall back to copy', async () => {
  fs.writeFileSync(behavior,'normal');
  assert.match((await invoke('launch-login','codex','private')).message,/已打开无痕/);
  assert.equal(copied.length,0); assert.equal(opened.length,0);
  assert.equal((await invoke('launch-login','codex','open')).ok,true);
  assert.equal(privateOpened[0],opened[0]);
  privateSupported = false;
  assert.match((await invoke('launch-login','codex','private')).message,/未能自动打开.*已复制/);
  assert.equal(copied[0],opened[0]);
  await settings.saveSettings({showResetTimes:true,openPrivateLogin:false});
  assert.match((await invoke('launch-login','codex','private')).message,/链接已复制/);
  assert.equal(privateOpened.length,2);
  assert.equal(copied[1],opened[0]);
  assert.equal(dirs().length,1);
  const ready=await completeLogin('private-login@example.test');
  assert.equal((await invoke('save-profile','codex','private-login',ready.attempt)).ok,true);
});

test('temporary cleanup failure preserves a committed save and its recoverable directory', async () => {
  fs.writeFileSync(behavior,'normal');
  for (const mode of ['new','recover','update']) {
    const name='cleanup-'+mode, email=name+'@example.test';
    if(mode!=='new')expiredProfile(name,email);
    await invoke('launch-login','codex','copy',undefined,mode==='update'?name:undefined);
    const ready=await completeLogin(email), dir=dirs()[0];
    const originalRm=fs.rmSync;
    let injected=0;
    fs.rmSync=function(target,...args) {
      if(target===dir){injected++;throw Object.assign(new Error('Directory not empty'),{code:'ENOTEMPTY'});}
      return originalRm.call(this,target,...args);
    };
    try {
      const result=await invoke(mode==='update'?'update-from-login':'save-profile','codex',name,ready.attempt);
      assert.equal(result.ok,true);
      assert.equal(injected,1);
      assert.equal(codexAgent.identity(store.profileDir('codex',name)).email,email);
      assert.equal((await invoke('login-status','codex')).isolated,false);
      assert.ok(fs.existsSync(dir));
    } finally { fs.rmSync=originalRm; }
    assert.equal(require('../dist/temporary-credentials').removeTemporaryCredentials(dir),true);
  }
});

test('cancel detaches a busy registered directory without affecting the next login', async () => {
  fs.writeFileSync(behavior,'normal');
  await invoke('launch-login','codex','copy');
  const oldDir=dirs()[0], originalRm=fs.rmSync;
  fs.rmSync=function(target,...args) {
    if(target===oldDir)throw Object.assign(new Error('Directory not empty'),{code:'ENOTEMPTY'});
    return originalRm.call(this,target,...args);
  };
  try {
    assert.equal((await invoke('cancel-login','codex')).ok,true);
    assert.equal((await invoke('launch-login','codex','copy')).ok,true);
    const nextDir=dirs().find(dir=>dir!==oldDir);
    assert.ok(nextDir);
    fs.rmSync=originalRm;
    assert.equal(require('../dist/temporary-credentials').removeTemporaryCredentials(oldDir),true);
    assert.ok(fs.existsSync(nextDir));
    assert.equal((await invoke('login-status','codex')).isolated,true);
  } finally { fs.rmSync=originalRm; }
});

test('ten sequential Codex logins share one link per account, save each identity, and leave A active', async () => {
  fs.writeFileSync(behavior, 'normal');
  assert.equal((await invoke('save-profile', 'codex', 'A')).ok, true);
  let previousAttempt;
  for (let i = 1; i <= 10; i++) {
    const name = 'account-' + i, email = name + '@example.test';
    assert.equal((await invoke('launch-login', 'codex', 'copy')).ok, true);
    assert.equal(opened.length, i - 1);
    assert.equal((await invoke('launch-login', 'codex')).ok, true);
    assert.equal(copied.at(-1), opened.at(-1));
    assert.equal(dirs().length, 1);
    const pending = await invoke('login-status', 'codex');
    assert.equal(pending.ready, false);
    assert.equal((await invoke('save-profile', 'codex', name, pending.attempt)).ok, false);
    const file = path.join(dirs()[0], 'browser-result');
    if (i === 1) {
      fs.writeFileSync(file, JSON.stringify({foreign:true, credentials:credentials(email)}));
      await until(() => !fs.existsSync(file));
      assert.equal((await invoke('login-status', 'codex')).ready, false);
    }
    fs.writeFileSync(file, JSON.stringify({credentials: credentials(email)}));
    const ready = await until(async () => { const s = await invoke('login-status', 'codex'); return s.ready && s; });
    assert.equal(ready.email, email);
    if (i === 1) {
      assert.match((await invoke('launch-login', 'codex', 'copy')).message, /登录已完成/);
      assert.equal(copied.length, 1);
      assert.equal((await invoke('login-status', 'codex')).email, email);
    }
    if (previousAttempt) assert.equal((await invoke('save-profile', 'codex', name, previousAttempt)).ok, false);
    assert.equal((await invoke('save-profile', 'codex', name, ready.attempt)).ok, true);
    assert.equal(codexAgent.identity(store.profileDir('codex', name)).email, email);
    assert.equal(store.getActiveProfile('codex'), 'A');
    assert.deepEqual(dirs(), []);
    previousAttempt = ready.attempt;
  }
  assert.equal(new Set(copied).size, 10);
});

test('cancel during startup never opens a browser or copies a late link', async () => {
  fs.writeFileSync(behavior, 'hold');
  const starting = invoke('launch-login', 'codex', 'copy');
  await until(() => dirs().some(d => fs.existsSync(path.join(d, 'started'))));
  await invoke('cancel-login', 'codex');
  assert.deepEqual(await starting, {canceled:true});
  assert.equal(copied.length + opened.length, 0);
  assert.equal((await invoke('login-status', 'codex')).email, 'A@example.test');
});

test('a failed browser launch retains the link for copying; rejected links and failed callbacks can be retried', async () => {
  fs.writeFileSync(behavior, 'invalid');
  assert.match((await invoke('launch-login', 'codex')).error, /链接无效/);
  assert.equal(opened.length, 0);
  fs.writeFileSync(behavior, 'normal'); failOpen = true;
  const failedOpen = await invoke('launch-login', 'codex');
  assert.match(failedOpen.error, /无法打开默认浏览器/);
  assert.ok(!JSON.stringify(failedOpen).includes('state='));
  const home = dirs()[0];
  assert.equal((await invoke('launch-login', 'codex', 'copy')).ok, true);
  assert.deepEqual(dirs(), [home]);
  fs.writeFileSync(path.join(home, 'browser-result'), '{}');
  await until(async () => (await invoke('login-status', 'codex')).errorMessage);
  assert.equal((await invoke('launch-login', 'codex', 'copy')).ok, true);
  assert.notEqual(copied[0], copied[1]);
  assert.ok(!fs.existsSync(home));
  fs.writeFileSync(path.join(dirs()[0], 'browser-result'), JSON.stringify({success:true}));
  await until(async () => (await invoke('login-status', 'codex')).errorMessage?.includes('未取得可保存的凭据'));
  assert.equal((await invoke('launch-login', 'codex', 'copy')).ok, true);
});

test('relogin updates the bound account in place while preserving A and rejecting another account', async () => {
  fs.writeFileSync(behavior, 'normal');
  const dir = expiredProfile('expired-B', 'expired-B@example.test');
  const before = readCredentialFile(path.join(dir, 'auth.json'));
  const profiles = store.listProfiles('codex');
  assert.equal((await invoke('launch-login', 'codex', 'open', undefined, 'expired-B')).ok, true);
  assert.equal((await invoke('launch-login', 'codex', 'copy', undefined, 'expired-B')).ok, true);
  assert.equal(opened.at(-1), copied.at(-1));
  const wrong = await completeLogin('another-account@example.test');
  assert.equal(wrong.matchesTarget, false);
  assert.equal((await invoke('update-from-login', 'codex', 'expired-B', wrong.attempt)).ok, false);
  assert.equal((await invoke('save-profile', 'codex', 'unintended-new-account', wrong.attempt)).ok, false);
  assert.deepEqual(readCredentialFile(path.join(dir, 'auth.json')), before);

  assert.equal((await invoke('launch-login', 'codex', 'copy', wrong.attempt, 'expired-B')).ok, true);
  const ready = await completeLogin('expired-B@example.test');
  assert.equal(ready.matchesTarget, true);
  assert.equal(ready.updateProfile, 'expired-B');
  assert.equal((await invoke('update-from-login', 'codex', 'expired-B', wrong.attempt)).ok, false);
  assert.equal((await invoke('update-from-login', 'codex', 'another-profile', ready.attempt)).ok, false);
  assert.equal((await invoke('update-from-login', 'codex', 'expired-B', ready.attempt)).ok, true);
  assert.deepEqual(store.listProfiles('codex'), profiles);
  assert.equal(JSON.parse(readCredentialFile(path.join(dir, 'auth.json'))).tokens.refresh_token, 'fixture-replacement');
  const meta = store.readProfileMeta('codex', 'expired-B');
  assert.equal(meta.label, '原昵称'); assert.equal(meta.quotaNote, '保留备注');
  assert.equal(meta.snapshot.state, 'unverified'); assert.equal(meta.snapshot.authExpired, false);
  assert.equal(meta.snapshot.quota.primaryWindow.usedPercent, 20);
  assert.deepEqual(dirs(), []);
  assert.equal((await invoke('update-from-login', 'codex', 'expired-B', ready.attempt)).ok, false);
});

test('a relogin cannot replace an account changed or recovered while the browser was open', async () => {
  fs.writeFileSync(behavior, 'normal');
  for (const change of ['replaced', 'removed', 'recovered']) {
    const name = 'update-' + change, email = name + '@example.test';
    const dir = expiredProfile(name, email);
    await invoke('launch-login', 'codex', 'copy', undefined, name);
    const ready = await completeLogin(email);
    if (change === 'removed') fs.rmSync(dir, { recursive: true });
    if (change === 'replaced') {
      const auth = JSON.parse(credentials(email));
      auth.tokens.refresh_token = 'external-newer-credential';
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
    }
    if (change === 'recovered') store.writeProfileMeta('codex', name, { snapshot: { state: 'ok', available: true } });
    const before = fs.existsSync(dir) ? readCredentialFile(path.join(dir, 'auth.json')) : null;
    assert.equal((await invoke('update-from-login', 'codex', name, ready.attempt)).ok, false);
    assert.deepEqual(fs.existsSync(dir) ? readCredentialFile(path.join(dir, 'auth.json')) : null, before);
    await invoke('cancel-login', 'codex');
  }
});

test('relogin matching checks workspace and member identity, not just the email', async () => {
  fs.writeFileSync(behavior, 'normal');
  const email = 'same-email@example.test';
  const dir = expiredProfile('workspace-target', email);
  const idToken = member => `h.${Buffer.from(JSON.stringify({sub: member, email})).toString('base64url')}.s`;
  const auth = JSON.parse(credentials(email));
  Object.assign(auth.tokens, {account_id: 'workspace-one', id_token: idToken('member-one')});
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
  const before = readCredentialFile(path.join(dir, 'auth.json'));
  let attempt;
  for (const [workspace, member] of [['workspace-two', 'member-one'], ['workspace-one', 'member-two']]) {
    assert.equal((await invoke('launch-login', 'codex', 'copy', attempt, 'workspace-target')).ok, true);
    const status = await completeLogin(email, {account_id: workspace, id_token: idToken(member)});
    assert.equal(status.email, email);
    assert.equal(status.matchesTarget, false);
    assert.equal((await invoke('update-from-login', 'codex', 'workspace-target', status.attempt)).ok, false);
    assert.deepEqual(readCredentialFile(path.join(dir, 'auth.json')), before);
    attempt = status.attempt;
  }
  await invoke('launch-login', 'codex', 'copy', attempt, 'workspace-target');
  const matched = await completeLogin(email, {account_id: 'workspace-one', id_token: idToken('member-one')});
  assert.equal(matched.matchesTarget, true);
  assert.equal((await invoke('update-from-login', 'codex', 'workspace-target', matched.attempt)).ok, true);
});

test('canceling a relogin waiting for the storage lock prevents the credential update', async () => {
  fs.writeFileSync(behavior, 'normal');
  const dir = expiredProfile('cancel-update', 'cancel-update@example.test');
  await invoke('launch-login', 'codex', 'copy', undefined, 'cancel-update');
  const ready = await completeLogin('cancel-update@example.test');
  const before = readCredentialFile(path.join(dir, 'auth.json'));
  let entered, release;
  const locked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = store.withStoreLock(async () => { entered(); await gate; });
  await locked;
  const update = invoke('update-from-login', 'codex', 'cancel-update', ready.attempt);
  await new Promise(resolve => setImmediate(resolve));
  const canceled = invoke('cancel-login', 'codex');
  release();
  await holding;
  assert.equal((await update).ok, false);
  await canceled;
  assert.deepEqual(readCredentialFile(path.join(dir, 'auth.json')), before);
});

test('changing the update target starts a separate login and cannot reuse a completed attempt', async () => {
  fs.writeFileSync(behavior, 'normal');
  expiredProfile('target-one', 'target-one@example.test');
  const secondDir = expiredProfile('target-two', 'target-two@example.test');
  const before = readCredentialFile(path.join(secondDir, 'auth.json'));
  await invoke('launch-login', 'codex', 'copy', undefined, 'target-one');
  const ready = await completeLogin('target-one@example.test');
  const previous = dirs()[0];
  await invoke('launch-login', 'codex', 'copy', undefined, 'target-two');
  assert.ok(!fs.existsSync(previous));
  assert.equal((await invoke('login-status', 'codex')).ready, false);
  assert.equal((await invoke('update-from-login', 'codex', 'target-two', ready.attempt)).ok, false);
  assert.deepEqual(readCredentialFile(path.join(secondDir, 'auth.json')), before);
});

test('Add Account login repairs an expired existing account instead of rejecting or duplicating it', async () => {
  fs.writeFileSync(behavior, 'normal');
  const dir = expiredProfile('existing-in-add', 'existing-in-add@example.test');
  const before = store.listProfiles('codex');
  assert.equal((await invoke('launch-login', 'codex', 'copy')).ok, true);
  const status = await completeLogin('existing-in-add@example.test');
  assert.equal(status.existingProfile, 'existing-in-add');
  assert.equal(status.existingProfileUpdatable, true);
  const result = await invoke('save-profile', 'codex', 'different-input-name', status.attempt);
  assert.equal(result.ok, true);assert.equal(result.updated, true);assert.equal(result.profile, 'existing-in-add');
  assert.deepEqual(store.listProfiles('codex'), before);
  assert.equal(store.readProfileMeta('codex', 'existing-in-add').label, '原昵称');
  assert.equal(JSON.parse(readCredentialFile(path.join(dir, 'auth.json'))).tokens.refresh_token, 'fixture-replacement');
});

test('canceling Add Account while save waits for the lock cannot update an expired account', async () => {
  fs.writeFileSync(behavior, 'normal');
  const dir = expiredProfile('cancel-add-recovery', 'cancel-add-recovery@example.test');
  await invoke('launch-login', 'codex', 'copy');
  const ready = await completeLogin('cancel-add-recovery@example.test');
  const before = readCredentialFile(path.join(dir, 'auth.json'));
  let entered, release;
  const locked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = store.withStoreLock(async () => { entered(); await gate; });
  await locked;
  const save = invoke('save-profile', 'codex', 'cancel-add-recovery', ready.attempt);
  await new Promise(resolve => setImmediate(resolve));
  const canceled = invoke('cancel-login', 'codex');
  release();await holding;
  assert.equal((await save).ok, false);await canceled;
  assert.deepEqual(readCredentialFile(path.join(dir, 'auth.json')), before);
});
