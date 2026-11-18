const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-import-ipc-'));
os.homedir = () => root;
const { readCredentialFile } = require('./vault-fixture.cjs');
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
after(() => fs.rmSync(root,{recursive:true,force:true}));

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
test('Codex dashboard is not blocked by an unrelated provider CLI; Claude status queries join',async()=>{
  const clients = require('../dist/clients');
  const original = clients.findClaudeBinary;
  const fake = path.join(root, 'fixture-claude');
  fs.writeFileSync(fake, `#!/bin/sh\necho '{"loggedIn":false}'\n`, { mode: 0o700 });
  let calls = 0;
  clients.findClaudeBinary = () => { calls++; return fake; };
  try {
    const dashboard=await invoke('get-status',true,'codex');
    assert.equal(dashboard[0].id,'codex');assert.equal(calls,0);
    const first=invoke('get-status',true,'claude'),second=invoke('get-status',true,'claude');
    assert.equal(calls,1);
    await Promise.all([first,second]);
    await invoke('get-status',false,'claude');assert.equal(calls,1);
  } finally {clients.findClaudeBinary=original;}
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
  const result=await invoke('commit-import',unlocked.id,[unlocked.items[0].key]);
  assert.deepEqual(result.imported,['codex/source']);
  assert.deepEqual(result.skipped,[]);
  assert.deepEqual(store.listProfiles('codex'), ['source']);
  assert.equal(codexAgent.identity(),undefined);
  assert.equal((await invoke('commit-import',unlocked.id,[unlocked.items[0].key])).ok,false);
  const again=await invoke('preview-import','backup');
  const duplicate=await invoke('unlock-import',again.id,'test-password');
  assert.deepEqual(await invoke('commit-import',duplicate.id,[duplicate.items[0].key]),{
    ok:true,imported:[],skipped:[{key:'codex/source',existing:'codex/source'}],
  });
});

test('actual import IPC previews plain credentials without password and cancel discards pending preview', async () => {
  selectedFile=path.join(root,'auth.json');
  atomicWrite(selectedFile,JSON.stringify({tokens:{access_token:'fake',refresh_token:'other-refresh',account_id:'other'}}));
  const selected=await invoke('preview-import','credentials');
  assert.equal(selected.needsPassword,undefined); assert.equal(selected.items.length,1);
  await invoke('cancel-import');
  assert.equal((await invoke('commit-import',selected.id,[selected.items[0].key])).ok,false);
  selectedFile=undefined;
  assert.equal((await invoke('preview-import','backup')).canceled,true);
});

test('truncated encrypted files report corruption rather than asking for a password again', async () => {
  await assert.rejects(backup.decryptBackup(Buffer.from('AGS1'),'test-password'),/损坏/);
});

test('credential update IPC binds the target and accepts pasted JSON or a file without duplicate import',async()=>{
  const credential=token=>JSON.stringify({tokens:{access_token:'fake',refresh_token:token,account_id:'update-target',id_token:'h.'+Buffer.from(JSON.stringify({sub:'update-member',email:'update@example.test'})).toString('base64url')+'.s'}});
  const dir=store.profileDir('codex','expired-target');
  atomicWrite(path.join(dir,'auth.json'),credential('old'));
  const expire=()=>store.writeProfileMeta('codex','expired-target',{label:'keep',snapshot:{state:'expired',authExpired:true,available:true}});
  expire();
  const pasted=await invoke('preview-credential-update','codex','expired-target',credential('new'));
  assert.equal(pasted.updating,true);assert.equal(pasted.profile,'expired-target');
  assert.equal((await invoke('commit-import',pasted.id,[pasted.items[0].key])).ok,false);
  assert.equal((await invoke('commit-credential-update',pasted.id)).ok,true);
  assert.equal(JSON.parse(readCredentialFile(path.join(dir,'auth.json'))).tokens.refresh_token,'new');
  assert.equal((await invoke('commit-credential-update',pasted.id)).ok,false);
  expire();selectedFile=path.join(root,'replacement.json');atomicWrite(selectedFile,credential('file-new'));
  const file=await invoke('preview-credential-update','codex','expired-target');
  assert.equal(file.updating,true);
  await invoke('cancel-import');assert.equal((await invoke('commit-credential-update',file.id)).ok,false);
  assert.equal(JSON.parse(readCredentialFile(path.join(dir,'auth.json'))).tokens.refresh_token,'new');
  const again=await invoke('preview-credential-update','codex','expired-target');
  await invoke('commit-credential-update',again.id);
  assert.equal(JSON.parse(readCredentialFile(path.join(dir,'auth.json'))).tokens.refresh_token,'file-new');
  assert.equal(store.readProfileMeta('codex','expired-target').label,'keep');
  assert.equal(codexAgent.identity(),undefined);
});

test('file and paste IPC share a multi-account preview and commit only selected editable names',async()=>{
  const file=path.join(root,'accounts.json');
  const credential=(name,i)=>({name,tokens:{access_token:'fake',refresh_token:'batch-'+i,account_id:'batch-'+i}});
  const document=JSON.stringify({data:{accounts:[null,credential('批量甲',0),credential('批量乙',1),credential('重复',0)]}});
  atomicWrite(file,document);
  selectedFiles=[file];
  const preview=await invoke('preview-import','credentials','codex');
  assert.deepEqual(lastDialogOptions.properties,['openFile']);
  assert.equal(preview.kind,'credentials');assert.equal(preview.items.length,4);
  assert.deepEqual(preview.items.map(x=>x.state),['error','ready','ready','duplicate']);
  assert.equal(preview.items[1].profile,'批量甲');
  assert.doesNotMatch(JSON.stringify(preview),/refresh_token|batch-0/);
  const pasted=await invoke('preview-credentials',document,'codex');
  assert.deepEqual(pasted.items.map(x=>[x.profile,x.state]),preview.items.map(x=>[x.profile,x.state]));
  const key=pasted.items[2].key;
  const result=await invoke('commit-import',pasted.id,[key],{[key]:'导入时命名'});
  assert.deepEqual(result.imported,['codex/导入时命名']);assert.equal(result.skipped.length,1);assert.equal(result.failed.length,1);
  assert.equal(store.profileExists('codex','批量甲'),false);
  selectedFiles=[];assert.equal((await invoke('preview-import','credentials','codex')).canceled,true);
  selectedFiles=[file,file];assert.equal((await invoke('preview-import','credentials','codex')).ok,false);
  selectedFiles=undefined;
});

test('Session file and paste previews recover expired accounts through the normal import IPC',async()=>{
  for(const mode of ['paste','file']) {
    const name='原账号-'+mode,accountId='recover-'+mode;
    const original={tokens:{access_token:'fixture-old',refresh_token:'fixture-old-refresh',account_id:accountId}};
    const updated={tokens:{access_token:'fixture-new',refresh_token:'fixture-new-refresh',account_id:accountId}};
    original.tokens.id_token=updated.tokens.id_token=`h.${Buffer.from(JSON.stringify({sub:'member-'+mode,email:mode+'@example.test'})).toString('base64url')}.s`;
    const profile=store.profileDir('codex',name);
    atomicWrite(path.join(profile,'auth.json'),JSON.stringify(original));
    store.writeProfileMeta('codex',name,{label:'保留昵称',snapshot:{state:'expired',authExpired:true,available:true}});
    const before=store.listProfiles('codex');
    const document=JSON.stringify({name:'来源里的名称',...updated});
    if(mode==='file'){selectedFile=path.join(root,'recovery.json');atomicWrite(selectedFile,document);}
    const preview=mode==='file'?await invoke('preview-import','credentials','codex'):await invoke('preview-credentials',document,'codex');
    assert.equal(preview.items[0].state,'update');assert.equal(preview.items[0].profile,name);
    assert.doesNotMatch(JSON.stringify(preview),/fixture-new|credentialRevision/);
    const key=preview.items[0].key;
    const result=await invoke('commit-import',preview.id,[key],{[key]:name});
    assert.equal(result.ok,true);assert.deepEqual(result.imported,[]);assert.deepEqual(result.updated,['codex/'+name]);
    assert.deepEqual(store.listProfiles('codex'),before);
    assert.deepEqual(JSON.parse(readCredentialFile(path.join(profile,'auth.json'))),updated);
    assert.equal(store.readProfileMeta('codex',name).label,'保留昵称');
    assert.equal(store.readProfileMeta('codex',name).snapshot.state,'unverified');
  }
});

test('pasted and selected JSONL use the same boundary parser without touching the active login',async()=>{
 const make=(name,i)=>JSON.stringify({name,auth_mode:'chatgpt',tokens:{access_token:'a',refresh_token:'line-'+i,account_id:'line-'+i}});
 const input=make('连续甲',0)+'\n'+make('连续乙',1);
 const pasted=await invoke('preview-credentials',input,'codex');
 assert.deepEqual(pasted.items.map(x=>x.profile),['连续甲','连续乙']);
 selectedFile=path.join(root,'records.jsonl');atomicWrite(selectedFile,input);
 const file=await invoke('preview-import','credentials','codex');
 assert.ok(lastDialogOptions.filters[0].extensions.includes('jsonl'));
 assert.deepEqual(file.items.map(x=>x.profile),['连续甲','连续乙']);
 await invoke('cancel-import');
 assert.equal(codexAgent.identity(),undefined);
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

test('actual quit lifecycle drains account work, preserves canceled drafts and rejects new writes', async () => {
  const accounts = require('../dist/accounts'), original = accounts.refreshAccount;
  const logins = [require('../dist/codex-login').codexLogin, require('../dist/antigravity-login').antigravityLogin];
  const cancels = logins.map(login => login.cancel);
  let cleanups = 0;
  logins.forEach((login, i) => { login.cancel = async () => { cleanups++; return cancels[i](); }; });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  accounts.refreshAccount = async () => { started(); await gate; return { state: 'ok' }; };
  try {
    const draft = await invoke('preview-credentials', JSON.stringify({ OPENAI_API_KEY: 'quit-draft' }), 'codex');
    const refreshing = invoke('refresh-account', 'codex');
    await running;
    assert.equal(app.quit(), true);
    assert.equal(app.quit(), true);
    assert.equal(quitCount, 0); assert.equal(confirmations.length, 0);
    assert.match((await invoke('save-profile', 'codex', 'must-not-save')).error, /准备退出/);
    assert.match((await invoke('cancel-import')).error, /准备退出/);
    assert.match((await invoke('cancel-login', 'codex')).error, /准备退出/);
    release(); await refreshing; await drain();
    assert.equal(confirmations.length, 1); assert.match(confirmations[0].detail, /待确认的导入/);
    assert.equal(quitCount, 0); assert.equal(cleanups, 0);
    const key = draft.items[0].key;
    assert.equal((await invoke('commit-import', draft.id, [key], { [key]: '退出前保留' })).ok, true);
    await invoke('preview-credentials', JSON.stringify({ OPENAI_API_KEY: 'quit-confirmed-draft' }), 'codex');
    confirmationResponse = 1;
    assert.equal(app.quit(), true);
    await drain();
    assert.equal(confirmations.length, 2); assert.equal(quitCount, 1); assert.equal(cleanups, 2);
    assert.deepEqual(quitErrors, []);
    assert.match((await invoke('save-profile', 'codex', 'must-not-save')).error, /准备退出/);
  } finally {
    release(); accounts.refreshAccount = original;
    logins.forEach((login, i) => { login.cancel = cancels[i]; });
  }
});
