const { mockKeychainCommands, createTestHome, installMockKeychain, readCredentialFile, jwt, accessToken } = require('./helpers/test-env.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const root = createTestHome('ags-import-ipc-', { mockKeychain: false });
const { readNativeToken: realReadNative, writeNativeToken: realWriteNative } = require('../dist/antigravity-native');
installMockKeychain();
const channels = new Map();
const appEvents = new Map(), openedUrls = [], confirmations = [], quitErrors = [];
let quitCount = 0, confirmationResponse = 0;
const app = {
  requestSingleInstanceLock: () => true, isReady: () => true,
  on: (event, listener) => appEvents.set(event, listener), whenReady: () => new Promise(() => {}),
  quit() {
    let prevented = false;
    appEvents.get('before-quit')?.({ preventDefault: () => { prevented = true; } });
    if (!prevented) quitCount++;
    return prevented;
  },
};
let selectedFile,selectedFiles,lastDialogOptions,copiedText;
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app,
    ipcMain: { handle: (channel, callback) => channels.set(channel, callback) },
    clipboard: { writeText: text => { copiedText = text; } },
    shell: { openExternal: async url => { openedUrls.push(url); } },
    dialog: {
      showOpenDialog: async (_window,options) => {lastDialogOptions=options;const files=selectedFiles|| (selectedFile?[selectedFile]:[]);return {filePaths:files,canceled:!files.length};},
      showMessageBox: async (...args) => { confirmations.push(args.at(-1)); return { response: confirmationResponse }; },
      showErrorBox: (title, message) => { quitErrors.push({ title, message }); },
    },
  };
  return load.call(this, name, ...args);
};
try { require('../dist/main'); } finally { Module._load = load; }
const invoke = (channel, ...args) => channels.get(channel)({senderFrame:{url:pathToFileURL(path.join(__dirname,'../renderer/index.html')).href}}, ...args);
const backup = require('../dist/backup');
const store = require('../dist/store');
const { codexAgent } = require('../dist/agents/codex');
Object.defineProperty(codexAgent,'homeDir',{value:path.join(root,'live')});
const { atomicWrite } = require('../dist/utils');

test('unsupported account switching is rejected before inspecting or quitting running clients',async()=>{
  const agent=require('../dist/accounts').resolveAgent('agy');
  const clients=require('../dist/clients');
  const previousSupport=agent.switchSupport,previousRunning=clients.runningClients;
  let inspected=0;
  agent.switchSupport=()=> '官方共用认证不支持文件切换';
  clients.runningClients=async()=>{inspected++;return ['Antigravity'];};
  try {
    const result=await invoke('use-profile','agy','unused');
    assert.equal(result.ok,false);assert.match(result.error,/共用认证/);assert.equal(inspected,0);
  } finally {agent.switchSupport=previousSupport;clients.runningClients=previousRunning;}
});
test('Desktop-only Antigravity restores backups; GUI use-profile invalidates stale confirmation when CLI changes B->C or marker active state flips during final async session check', { skip: process.platform !== 'darwin' }, async t => {
  const native = require('../dist/antigravity-native');
  const clients = require('../dist/clients');
  const accounts = require('../dist/accounts');
  const agyAgent = accounts.resolveAgent('agy');
  const prevReadNative = native.readNativeToken;
  const prevWriteNative = native.writeNativeToken;
  const prevRunning = clients.runningClients;
  const prevShared = native.sharedAntigravitySessions;
  const prevSwitchSupport = agyAgent.switchSupport;
  const prevNativeEnabled = agyAgent.nativeEnabled;
  const gemini = path.join(root, '.gemini');
  const cliPath = path.join(gemini, 'antigravity-cli/antigravity-oauth-token');
  const desktopPath = path.join(gemini, native.NATIVE_TOKEN_FILE);
  const desktopMarker = path.join(gemini, 'cache/antigravity-keyring-unavailable');
  const makeTok = (email, gen = 1) => Buffer.from(JSON.stringify({
    auth_method: 'consumer',
    id_token_email: email,
    token: { access_token: `a-${email}-${gen}`, refresh_token: `r-${email}-${gen}`, expiry: new Date(1795000000000 + gen * 60000).toISOString() },
  }));
  const keychain = mockKeychainCommands(makeTok('kc-a@example.test', 1));
  keychain.state.verifyRetiredPayload = true;
  native.readNativeToken = realReadNative;
  native.writeNativeToken = realWriteNative;
  clients.runningClients = async () => [];
  agyAgent.nativeEnabled = true;
  agyAgent.switchSupport = () => undefined;
  try {
    fs.rmSync(gemini, { recursive: true, force: true });
    let cliState = 'missing';
    t.mock.method(agyAgent, 'cliStatus', () => ({ state: cliState }));
    assert.equal(agyAgent.management().quota, false);
    const launch = t.mock.method(clients, 'openClients', async names => assert.deepEqual(names, ['Antigravity']));
    const login = await invoke('login-status', 'agy');
    assert.equal(login.email, 'kc-a@example.test');
    assert.equal((await invoke('save-profile', 'agy', 'AGY-A')).ok, true);
    cliState = 'ready';
    t.mock.method(require('../dist/antigravity-cli'), 'startAcpLogin', () => {
      cliState = 'outdated';
      const refused = Promise.reject(new Error('fixture: unsupported acp'));
      return { link: refused, complete: refused, stop: async () => {} };
    });
    assert.match((await invoke('launch-login', 'agy')).error, /unsupported acp/);
    assert.equal((await invoke('launch-login', 'agy')).ok, true);
    assert.equal(launch.mock.callCount(), 1);
    launch.mock.restore();
    atomicWrite(path.join(store.profileDir('agy', 'AGY-TARGET'), agyAgent.authFiles[0]), makeTok('target@example.test', 1));

    const target = store.profileDir('agy', 'AGY-TARGET');
    store.writeProfileMeta('agy', 'AGY-A', { email: 'kc-a@example.test', snapshot: { available: true, plan: 'Google AI Pro' } });
    selectedFile = path.join(root, 'desktop-only.ags');
    atomicWrite(selectedFile, await backup.exportBackup([{ agent:'agy', profile:'AGY-TARGET' }], 'fixture-pass'));
    fs.rmSync(target, { recursive:true });
    const selected = await invoke('preview-import', 'backup');
    const unlocked = await invoke('unlock-import', selected.id, 'fixture-pass');
    const restoredBackup = await invoke('commit-import', unlocked.id, [unlocked.items[0].key]);
    assert.deepEqual(restoredBackup.imported, ['agy/AGY-TARGET']);
    const savedStatus = accounts.dashboard().find(agent => agent.id === 'agy');
    assert.equal(savedStatus.active, 'AGY-A');
    assert.equal(savedStatus.status.plan, 'Google AI Pro');
    assert.equal(savedStatus.profiles.find(p => p.name === 'AGY-TARGET').meta.email, 'target@example.test');
    const newerDesktop = t.mock.method(agyAgent, 'desktopLogin', () => makeTok('kc-a@example.test', 2));
    const local = (await invoke('get-status')).find(agent => agent.id === 'agy');
    assert.equal(local.active, 'AGY-A');
    assert.equal(local.status.plan, 'Google AI Pro');
    assert.equal(local.status.quota, undefined);
    newerDesktop.mock.restore();

    const big = Buffer.from(JSON.stringify({ ...JSON.parse(makeTok('long@example.test')), id_token: 'x'.repeat(8000) }));
    atomicWrite(path.join(store.profileDir('agy', 'AGY-LONG'), agyAgent.authFiles[0]), big);
    for (const running of [[], ['Antigravity']]) {
      clients.runningClients = async () => running;
      const before = confirmations.length, oldItem = keychain.state.stored;
      confirmationResponse = 0;
      assert.deepEqual(await invoke('use-profile', 'agy', 'AGY-LONG'), { canceled: true });
      assert.equal(confirmations.length, before + 1);
      const question = confirmations.at(-1);
      assert.equal(question.defaultId, 0);
      assert.match(question.buttons.join(' '), running.length ? /退出并切换/ : /使用文件并切换/);
      assert.match(question.detail, /文件/);
      assert.match(question.detail, /0600/);
      assert.equal(keychain.state.stored, oldItem);
      assert.equal(fs.existsSync(cliPath), false);
      assert.equal(fs.existsSync(desktopPath), false);
    }
    const desktopActions = [];
    let running = true;
    clients.runningClients = async () => running ? ['Antigravity'] : [];
    t.mock.method(clients, 'quitClients', async () => { running = false; desktopActions.push('quit'); });
    t.mock.method(clients, 'openClients', async () => { running = true; desktopActions.push('open'); });
    native.sharedAntigravitySessions = async () => [];
    const nativeDialogs = confirmations.length;
    let interrupted = true;
    t.mock.method(agyAgent, 'hasInterruptedSwitch', () => interrupted);
    t.mock.method(agyAgent, 'recoverInterruptedSwitch', async () => { interrupted = false; });
    const traySwitch = decision => invoke('use-profile', 'agy', 'AGY-LONG', 'tray', decision);
    const initial = (await traySwitch()).confirmation;
    assert.deepEqual(initial, { token: initial.token, clients: ['Antigravity'], interrupted: true, unmanaged: false, migration: false });
    assert.equal(interrupted, true);
    assert.deepEqual(desktopActions, []);
    const unmanaged = makeTok('unsaved@example.test');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, unmanaged);
    // The CLI login changed after showing the question. The old consent cannot quit the desktop or recover.
    const renewed = (await traySwitch({ token: initial.token })).confirmation;
    assert.notEqual(renewed.token, initial.token);
    assert.equal(interrupted, true);
    assert.deepEqual(desktopActions, []);
    const next = (await traySwitch({ token: renewed.token })).confirmation;
    assert.deepEqual(next, { token: next.token, clients: ['Antigravity'], interrupted: false, unmanaged: true, migration: true });
    assert.deepEqual(desktopActions, ['quit', 'open']);
    assert.deepEqual(fs.readFileSync(cliPath), unmanaged);
    const poolBefore = store.listProfiles('agy');
    const replay = (await traySwitch({ token: renewed.token, saveUnmanaged: false })).confirmation;
    assert.notEqual(replay.token, next.token);
    assert.deepEqual(desktopActions, ['quit', 'open']);
    assert.deepEqual(store.listProfiles('agy'), poolBefore);
    desktopActions.length = 0;
    const applied = await traySwitch({ token: replay.token, saveUnmanaged: true });
    assert.equal(confirmations.length, nativeDialogs);
    assert.equal(applied.ok, true, applied.error);
    assert.deepEqual(desktopActions, ['quit', 'open']);
    assert.equal(keychain.state.stored, null);
    assert.deepEqual(fs.readFileSync(cliPath), big);
    assert.deepEqual(fs.readFileSync(desktopPath), big);
    clients.runningClients = async () => [];
    const restored = await invoke('use-profile', 'agy', 'AGY-A');
    assert.equal(restored.ok, true, restored.error);
    const activeItem = keychain.state.stored;
    let inventories = 0;
    // The desktop starts during the transaction, after preflight and its initial process inventory.
    clients.runningClients = async () => ++inventories >= 3 ? ['Antigravity'] : [];
    const reopened = await invoke('use-profile', 'agy', 'AGY-TARGET', 'tray');
    assert.match(reopened.error, /重新打开/);
    assert.equal(keychain.state.stored, activeItem);
    clients.runningClients = async () => [];
    assert.equal((await invoke('use-profile', 'agy', 'AGY-TARGET', 'tray')).ok, true);
    assert.equal((await invoke('use-profile', 'agy', 'AGY-A', 'tray')).ok, true);
    assert.equal(confirmations.length, nativeDialogs);

    // Case 1: CLI holds unmanaged B when user confirms discard (response=1), then during final async sharedAntigravitySessions(), CLI changes B -> C!
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    const tokB = makeTok('cli-b@example.test', 1), tokC = makeTok('cli-c@example.test', 1);
    fs.writeFileSync(cliPath, tokB);
    confirmationResponse = 1; // "不保存并切换"
    native.sharedAntigravitySessions = async () => {
      // Simulate official CLI logging into C right during the last async check before writeNativeToken!
      fs.writeFileSync(cliPath, tokC);
      return [];
    };
    const r1 = await invoke('use-profile', 'agy', 'AGY-TARGET');
    assert.equal(r1.ok, false);
    assert.match(r1.error || '', /确认期间|已变化/);
    assert.deepEqual(fs.readFileSync(cliPath), tokC, 'new CLI login C must not be deleted by stale confirmation');
    assert.equal(keychain.state.stored, 'go-keyring-base64:' + makeTok('kc-a@example.test', 1).toString('base64'));

    // User can now re-confirm cleanly on C:
    native.sharedAntigravitySessions = async () => [];
    confirmationResponse = 2; // "保存后切换"
    const r1Retry = await invoke('use-profile', 'agy', 'AGY-TARGET');
    assert.equal(r1Retry.ok, true);
    assert.equal(fs.existsSync(cliPath), false);
    assert.equal(store.listProfiles('agy').some(p => agyAgent.identity(store.profileDir('agy', p))?.email === 'cli-c@example.test'), true);

    // Case 2: Desktop marker flips from expired (>1h) to active (<1h) via mtime touch ONLY during final async check!
    keychain.state.stored = 'go-keyring-base64:' + makeTok('kc-a@example.test', 1).toString('base64');
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.mkdirSync(path.dirname(desktopMarker), { recursive: true });
    const deskTok = makeTok('cli-c@example.test', 1); // already in pool, so needsUnmanagedChoice is false!
    fs.writeFileSync(desktopPath, deskTok);
    fs.writeFileSync(desktopMarker, '');
    const expiredTs = (Date.now() - 7200_000) / 1000;
    fs.utimesSync(desktopMarker, expiredTs, expiredTs); // marker expired -> active identity is kc-a
    native.sharedAntigravitySessions = async () => {
      const freshTs = Date.now() / 1000;
      fs.utimesSync(desktopMarker, freshTs, freshTs); // marker now active -> flips active identity without changing file bytes!
      return [];
    };
    const r2 = await invoke('use-profile', 'agy', 'AGY-TARGET');
    assert.equal(r2.ok, false);
    assert.match(r2.error || '', /确认期间|已变化/);
    assert.deepEqual(fs.readFileSync(desktopPath), deskTok);
    assert.equal(fs.existsSync(desktopMarker), true);
  } finally {
    confirmations.length = 0;
    confirmationResponse = 0;
    fs.rmSync(gemini, { recursive: true, force: true });
    fs.rmSync(path.join(store.STORE_DIR, 'agy'), { recursive: true, force: true });
    keychain.restore();
    native.readNativeToken = prevReadNative;
    native.writeNativeToken = prevWriteNative;
    clients.runningClients = prevRunning;
    native.sharedAntigravitySessions = prevShared;
    agyAgent.switchSupport = prevSwitchSupport;
    agyAgent.nativeEnabled = prevNativeEnabled;
  }
});
test('actual import IPC selects encrypted file before password, supports retry and commits only selection', async () => {
  const profiles = ['source', 'unselected'];
  for (const name of profiles) atomicWrite(path.join(store.profileDir('codex', name), 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-' + name }));
  selectedFile=path.join(root,'fixture.ags');
  atomicWrite(selectedFile,await backup.exportBackup(profiles.map(profile => ({agent:'codex',profile})), 'test-password'));
  for (const name of profiles) fs.rmSync(store.profileDir('codex', name), {recursive:true});
  const selected=await invoke('preview-import','backup');
  assert.equal(selected.needsPassword,true); assert.equal(selected.fileName,'fixture.ags');
  assert.equal(selected.items,undefined); assert.equal(selected.ok,undefined);
  assert.deepEqual(store.listProfiles('codex'),[]);
  const wrong=await invoke('unlock-import',selected.id,'wrong-password');
  assert.equal(wrong.ok,false); assert.match(wrong.error,/密码不正确/);
  const unlocked=await invoke('unlock-import',selected.id,'test-password');
  assert.deepEqual(unlocked.items.map(item => item.profile), profiles);
  assert.deepEqual(store.listProfiles('codex'),[]);
  assert.equal((await invoke('commit-import', unlocked.id, ['codex/missing'])).ok, false);
  assert.deepEqual(store.listProfiles('codex'),[]);
  selectedFiles=[];
  try {
    for (const args of [['preview-import','credentials','codex'], ['preview-import','backup'], ['preview-credential-update','codex','source']]) {
      assert.deepEqual(await invoke(...args), {canceled:true});
    }
  } finally { selectedFiles=undefined; }
  const result=await invoke('commit-import',unlocked.id,[unlocked.items[0].key]);
  assert.deepEqual(result.imported,['codex/source']);
  assert.deepEqual(result.skipped,[]);
  assert.deepEqual(store.listProfiles('codex'), ['source']);
  assert.equal(codexAgent.identity(),undefined);
  assert.equal((await invoke('commit-import',unlocked.id,[unlocked.items[0].key])).ok,false);
});

test('truncated encrypted files report corruption rather than asking for a password again', async () => {
  await assert.rejects(backup.decryptBackup(Buffer.from('AGS1'),'test-password'),/损坏/);
});

test('credential update IPC cancels file previews and binds pasted candidates to a single update commit',async()=>{
  const clients=require('../dist/clients');clients.runningClients=async()=>[];
  const logout=require('../dist/client-logout');logout.runningCodexSessions=async()=>[];
  const credential=token=>JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake',refresh_token:token,account_id:'update-target',id_token:jwt({sub:'update-member',email:'update@example.test','https://api.openai.com/auth':{chatgpt_account_id:'update-target',user_id:'update-member'}})}});
  const dir=store.profileDir('codex','expired-target');
  atomicWrite(path.join(dir,'auth.json'),credential('old'));
  store.writeProfileMeta('codex','expired-target',{snapshot:{state:'expired',authExpired:true,available:true}});
  selectedFile=path.join(root,'replacement.json');
  atomicWrite(selectedFile,credential('file-new'));
  const file=await invoke('preview-credential-update','codex','expired-target');
  assert.equal(file.updating,true);
  await invoke('cancel-import');
  assert.equal((await invoke('commit-credential-update',file.id)).ok,false);
  const pasted=await invoke('preview-credential-update','codex','expired-target',credential('new'));
  assert.equal(pasted.updating,true);assert.equal(pasted.profile,'expired-target');
  assert.equal((await invoke('commit-import',pasted.id,[pasted.items[0].key])).ok,false);
  assert.equal((await invoke('commit-credential-update',pasted.id)).ok,true);
  // Staged in .pending, original auth.json untouched until verified!
  assert.equal(JSON.parse(readCredentialFile(path.join(dir,'auth.json'))).tokens.refresh_token,'old');
  assert.equal(JSON.parse(readCredentialFile(path.join(dir,'auth.json.pending'))).tokens.refresh_token,'new');
  assert.equal((await invoke('commit-credential-update',pasted.id)).ok,false);
});

test('file and paste IPC share a multi-account preview and commit only selected editable names',async()=>{
  const file=path.join(root,'accounts.jsonl');
  const credential=(name,i)=>({name,tokens:{access_token:'fake',refresh_token:'batch-'+i,account_id:'batch-'+i}});
  const expired=credential('原名',2);
  expired.tokens.id_token=jwt({sub:'batch-member',email:'batch@example.test'});
  const saved=path.join(store.profileDir('codex','原名'),'auth.json');
  atomicWrite(saved,JSON.stringify({tokens:{...expired.tokens,refresh_token:'previous'}}));
  store.writeProfileMeta('codex','原名',{snapshot:{state:'expired',authExpired:true,available:true}});
  const document=[{tokens:{refresh_token:'incomplete'}},credential('批量甲',0),credential('批量乙',1),credential('重复',0),expired]
    .map(value=>JSON.stringify(value)).join('\n');
  atomicWrite(file,document);
  selectedFiles=[file];
  const preview=await invoke('preview-import','credentials','codex');
  assert.deepEqual(lastDialogOptions.properties,['openFile']);
  assert.ok(lastDialogOptions.filters[0].extensions.includes('jsonl'));
  assert.equal(preview.kind,'credentials');
  assert.deepEqual(preview.items.map(x=>x.state),['error','ready','ready','duplicate','update']);
  assert.equal(preview.items[1].profile,'批量甲');
  assert.equal(preview.items[0].sourceIndex,1);
  assert.doesNotMatch(JSON.stringify(preview),/refresh_token|batch-0/);
  const pasted=await invoke('preview-credentials',document,'codex');
  assert.deepEqual(pasted.items.map(x=>[x.profile,x.state]),preview.items.map(x=>[x.profile,x.state]));
  assert.equal((await invoke('commit-import',preview.id,[preview.items[1].key])).ok,false);
  const key=pasted.items[2].key;
  const update=pasted.items[4];
  const result=await invoke('commit-import',pasted.id,[key,update.key],{[key]:'导入时命名',[update.key]:update.profile});
  assert.deepEqual(result.updated,['codex/原名']);
  assert.equal(JSON.parse(readCredentialFile(saved)).tokens.refresh_token,'previous');
  assert.equal(JSON.parse(readCredentialFile(saved+'.pending')).tokens.refresh_token,expired.tokens.refresh_token);
  assert.deepEqual(result.imported,['codex/导入时命名']);assert.equal(result.skipped.length,1);assert.equal(result.failed.length,1);
  assert.equal(store.profileExists('codex','批量甲'),false);
  assert.equal(codexAgent.identity(),undefined);
  selectedFiles=[];assert.equal((await invoke('preview-import','credentials','codex')).canceled,true);
  selectedFiles=[file,file];assert.equal((await invoke('preview-import','credentials','codex')).ok,false);
  selectedFiles=undefined;
});

test('canceling during an asynchronous backup read keeps the pending import cleared', async () => {
  const file = path.join(root, 'cancel-preview.json');
  atomicWrite(file, JSON.stringify({ OPENAI_API_KEY: 'fixture-cancel-preview' }));
  selectedFiles = [file];
  const original = fs.promises.readFile;
  let started, release;
  const reading = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fs.promises.readFile = async (...args) => {
    if (args[0] === file) { started(); await gate; }
    return original(...args);
  };
  try {
    const preview = invoke('preview-import', 'backup');
    await reading;
    await invoke('cancel-import');
    release();
    assert.deepEqual(await preview, { canceled: true });
  } finally {
    release();
    fs.promises.readFile = original;
    selectedFiles = undefined;
  }
});


test('logout IPC preserves the removal error when checking the closed client also fails', async t => {
  const accounts = require('../dist/accounts');
  const clients = require('../dist/clients');
  const preview = { agent: 'codex', profile: 'original', profiles: ['original'], identity: 'old',
    current: true, signature: 'same' };
  t.mock.method(accounts, 'previewRemoveAccount', async () => preview);
  t.mock.method(clients, 'runningClients', async () => ['Codex']);
  t.mock.method(clients, 'quitClients', async () => {});
  t.mock.method(accounts, 'removeAccount', async () => { throw new Error('移除失败，已保留账号'); });
  t.mock.method(codexAgent, 'identity', () => { throw new Error('登录暂时不可读'); });
  const previousResponse = confirmationResponse, previousCount = confirmations.length;
  confirmationResponse = 1;
  try {
    const { id } = await invoke('preview-delete-profile', 'codex', 'original');
    const result = await invoke('delete-profile', 'codex', 'original', { previewId: id, logout: true });
    assert.deepEqual(result, { ok: false, error: '移除失败，已保留账号' });
  } finally {
    confirmationResponse = previousResponse;
    confirmations.length = previousCount;
  }
});

test('deletion IPC binds a short-lived preview to the exact target and refuses replay', async () => {
  for (const name of ['delete-A', 'delete-copy', 'delete-B']) {
    atomicWrite(path.join(store.profileDir('codex', name), 'auth.json'), JSON.stringify({ OPENAI_API_KEY: name === 'delete-B' ? 'fixture-key-B' : 'fixture-key-A' }));
  }
  const preview = await invoke('preview-delete-profile', 'codex', 'delete-A');
  assert.deepEqual(preview.profiles, ['delete-A', 'delete-copy']);
  assert.doesNotMatch(JSON.stringify(preview), /fixture-key|identity|signature|liveRevision/);
  assert.equal((await invoke('delete-profile', 'codex', 'delete-B', { previewId: preview.id, logout: false })).ok, false);
  assert.equal((await invoke('delete-profile', 'codex', 'delete-A')).ok, false);
  const result = await invoke('delete-profile', 'codex', 'delete-A', { previewId: preview.id, logout: false });
  assert.deepEqual(result.removed, ['delete-A', 'delete-copy']);
  assert.equal(store.profileExists('codex', 'delete-B'), true);
  assert.equal((await invoke('delete-profile', 'codex', 'delete-A', { previewId: preview.id, logout: false })).ok, false);
});

test('large deletion selections retain each confirmation and reject changes to its original scope', async t => {
  const accounts = require('../dist/accounts');
  const put = (name, key) => atomicWrite(path.join(store.profileDir('codex', name), 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key }));
  const first = 'selected-first', changed = 'selected-changed';
  put(first, 'large-selection-first'); put(changed, 'large-selection-changed');
  const original = accounts.previewRemoveAccount;
  t.mock.method(accounts, 'previewRemoveAccount', (agent, name) => name.startsWith('simulated-')
    ? Promise.resolve({ agent: agent.id, profile: name, profiles: [name], current: false, signature: name })
    : original(agent, name));
  const preview = name => invoke('preview-delete-profile', 'codex', name);
  const remove = (name, id) => invoke('delete-profile', 'codex', name, { previewId: id, logout: false });
  const previous = await preview(first), selected = await preview(first), other = await preview(changed);
  for (let i = 0; i < 203; i++) await preview(`simulated-${i}`);
  assert.equal((await remove(first, previous.id)).ok, false);
  assert.deepEqual((await remove(first, selected.id)).removed, [first]);
  put('new-alias', 'large-selection-changed');
  assert.equal((await remove(changed, other.id)).ok, false);
  assert.ok(store.profileExists('codex', changed));
  assert.ok(store.profileExists('codex', 'new-alias'));
});

test('cleanup IPC copies only a generic instruction without inspecting or changing accounts', async () => {
  const before = store.listProfiles('codex');
  const accounts = require('../dist/accounts');
  const identity = codexAgent.identity;
  codexAgent.identity = () => { throw new Error('Cleanup copy must not inspect credentials'); };
  try { assert.deepEqual(await invoke('copy-cleanup-prompt'), { ok: true }); }
  finally { codexAgent.identity = identity; }
  assert.match(copiedText, /先只读检查/);
  assert.match(copiedText, /不能作为删除依据/);
  assert.doesNotMatch(copiedText, /fixture-key|example\.test/);
  assert.deepEqual(store.listProfiles('codex'), before);
});

test('project IPC always opens the fixed project URL and obsolete actions are absent', async () => {
  const project = 'https://github.com/xjzc-mt/agent-switcher';
  assert.deepEqual(await invoke('open-project-page'), { ok: true });
  for (const page of ['release', 'releases', 'https://example.test', '../settings', 'file:///tmp/test']) {
    assert.deepEqual(await invoke('open-project-page', page, { url: page }), { ok: true });
  }
  assert.deepEqual(openedUrls, Array(6).fill(project));
  assert.equal(channels.has('copy-project-link'), false);
  assert.equal(channels.has('ignore-app-update'), false);
});

test('actual quit lifecycle quits promptly during slow network lookup, but drains active writes/rotation commits, preserves drafts and rejects new writes', async () => {
  const logins = [require('../dist/codex-login').codexLogin, require('../dist/antigravity-login').antigravityLogin];
  const cancels = logins.map(login => login.cancel);
  let cleanups = 0;
  logins.forEach((login, i) => { login.cancel = async () => { cleanups++; return cancels[i](); }; });
  let releaseLookup, lookupStarted, releaseCommit, commitEntered;
  const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
  const lookupRunning = new Promise(resolve => { lookupStarted = resolve; });
  const commitGate = new Promise(resolve => { releaseCommit = resolve; });
  const commitRunning = new Promise(resolve => { commitEntered = resolve; });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  const origQuery = codexAgent.queryLiveRpc;
  const origCommit = codexAgent.commitQuery.bind(codexAgent);
  const quitProfile = store.profileDir('codex', 'quit-test-card');
  atomicWrite(path.join(quitProfile, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: 'ws-q', access_token: accessToken('ws-q','uq','uq@example.test',1), refresh_token: 'rt1', id_token: jwt({ sub: 'uq', email: 'uq@example.test' }) },
  }));
  try {
    // Phase 1: Slow ordinary network lookup does NOT block Cmd+Q confirmation/quit!
    codexAgent.queryLiveRpc = async () => { lookupStarted(); await lookupGate; return { rates: { rateLimits: { primary: { usedPercent: 5 } } } }; };
    const draft = await invoke('preview-credentials', JSON.stringify({ OPENAI_API_KEY: 'quit-draft' }), 'codex');
    const slowLookup = invoke('refresh-account', 'codex', 'quit-test-card', true);
    await lookupRunning;
    confirmationResponse = 0; // cancel quit at draft prompt — reached IMMEDIATELY without waiting for lookupGate!
    assert.equal(app.quit(), true);
    await drain();
    assert.equal(confirmations.length, 1, 'Cmd+Q must reach confirmation promptly without waiting on slow network lookup');
    assert.match(confirmations[0].detail, /待确认的导入/);
    assert.equal(quitCount, 0);
    releaseLookup();
    await slowLookup;

    // Phase 2: Once a query has rotated a token and entered the commit critical section, Cmd+Q DOES wait until safe persistence completes!
    const rotateProfile = store.profileDir('codex', 'quit-rotate-card');
    atomicWrite(path.join(rotateProfile, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { account_id: 'ws-q2', access_token: accessToken('ws-q2','uq2','uq2@example.test',1), refresh_token: 'rt1', id_token: jwt({ sub: 'uq2', email: 'uq2@example.test' }) },
    }));
    const key = draft.items[0].key;
    assert.equal((await invoke('commit-import', draft.id, [key], { [key]: '退出前保留' })).ok, true);
    await invoke('preview-credentials', JSON.stringify({ OPENAI_API_KEY: 'quit-confirmed-draft' }), 'codex');
    codexAgent.queryLiveRpc = async temp => {
      atomicWrite(path.join(temp, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { account_id: 'ws-q2', access_token: accessToken('ws-q2','uq2','uq2@example.test',2), refresh_token: 'rt2-rotated', id_token: jwt({ sub: 'uq2', email: 'uq2@example.test' }) },
      }));
      return { rates: { rateLimits: { primary: { usedPercent: 10 } } } };
    };
    const origQueryCredential = codexAgent.queryCredential;
    const origWithLock = store.withStoreLock;
    let blockNextCommitLock = false;
    codexAgent.queryCredential = async function (...a) {
      const res = await origQueryCredential.apply(this, a);
      blockNextCommitLock = true;
      return res;
    };
    store.withStoreLock = async (work, id) => {
      if (blockNextCommitLock && id === undefined) {
        blockNextCommitLock = false;
        commitEntered();
        await commitGate;
      }
      return origWithLock(work, id);
    };
    const rotatingRefresh = invoke('refresh-account', 'codex', 'quit-rotate-card', true);
    await commitRunning;
    confirmationResponse = 1;
    assert.equal(app.quit(), true);
    assert.equal(app.quit(), true);
    await drain();
    assert.equal(quitCount, 0, 'Cmd+Q must wait for post-rotation commit critical section');
    assert.equal(confirmations.length, 1);
    assert.match((await invoke('save-profile', 'codex', 'must-not-save')).error, /准备退出/);
    assert.match((await invoke('cancel-import')).error, /准备退出/);
    assert.match((await invoke('cancel-login', 'codex')).error, /准备退出/);
    releaseCommit();
    await rotatingRefresh;
    for (let i = 0; i < 10 && quitCount === 0; i++) await drain();
    assert.equal(JSON.parse(readCredentialFile(path.join(rotateProfile, 'auth.json'))).tokens.refresh_token, 'rt2-rotated');
    assert.equal(confirmations.length, 2); assert.equal(quitCount, 1); assert.equal(cleanups, 2);
    assert.deepEqual(quitErrors, []);
    assert.match((await invoke('save-profile', 'codex', 'must-not-save')).error, /准备退出/);
    codexAgent.queryCredential = origQueryCredential;
    store.withStoreLock = origWithLock;
  } finally {
    releaseLookup?.(); releaseCommit?.();
    codexAgent.queryLiveRpc = origQuery;
    codexAgent.commitQuery = origCommit;
    logins.forEach((login, i) => { login.cancel = cancels[i]; });
  }
});
