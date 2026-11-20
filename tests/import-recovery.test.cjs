const { accessToken } = require('./codex-token-fixture.cjs');
const {test,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ags-import-recovery-'));
os.homedir=()=>root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const clients=require('../dist/clients');clients.runningClients=async()=>[];
const logout=require('../dist/client-logout');logout.runningCodexSessions=async()=>[];
const accounts=require('../dist/accounts'),store=require('../dist/store');
const backup=require('../dist/backup'),batchImport=require('../dist/credential-import');
const {codexAgent:agent}=require('../dist/agents/codex');
const {credentialState}=require('../dist/credential-state');
const {atomicWrite}=require('../dist/utils');
const vault = require('../dist/credential-vault');
Object.defineProperty(agent,'homeDir',{value:path.join(root,'live')});
const auth=(id,token='new',member='person')=>Buffer.from(JSON.stringify({tokens:{account_id:id,access_token:accessToken(id,member,'same@example.test',token),refresh_token:token,id_token:`h.${Buffer.from(JSON.stringify({sub:member,email:'same@example.test','https://api.openai.com/auth':{chatgpt_account_id:id,user_id:member}})).toString('base64url')}.s`}}));
const file=name=>path.join(store.profileDir('codex',name),'auth.json');
const staged=name=>path.join(store.profileDir('codex',name),'auth.json.pending');
function put(name,id,state='expired',token='old') {
  atomicWrite(file(name),auth(id,token));
  store.writeProfileMeta('codex',name,{label:'原昵称',quotaNote:'保留备注',savedAt:'2026-01-01',snapshot:{
    state,available:true,authExpired:state==='expired',credentialRevision:credentialState(agent,store.profileDir('codex',name)).revision,
    checkedAt:'2026-11-01',fetchedAt:'2026-10-31',quota:{primaryWindow:{usedPercent:90}},
  }});
}
const parse=values=>batchImport.parseCredentialBatch(Buffer.from(JSON.stringify(values.map(bytes=>JSON.parse(bytes)))), 'codex');
const commit=batch=>{
  const names=Object.fromEntries(batch.items.filter(x=>['ready','update'].includes(x.state)).map(x=>[x.key,x.profile]));
  return batchImport.installCredentialBatch(batch,Object.keys(names),names);
};
async function combine(entries) {
  const parts=await Promise.all(entries.map(([name,bytes])=>backup.parseCredentials(bytes,'codex',name)));
  return {items:parts.flatMap(p=>p.items),groups:new Map(parts.flatMap(p=>[...p.groups]))};
}
beforeEach(()=>{
  accounts.cancelLogin();
  fs.rmSync(store.STORE_DIR,{recursive:true,force:true});
  fs.rmSync(agent.homeDir,{recursive:true,force:true});
  atomicWrite(path.join(agent.homeDir,'auth.json'),auth('unrelated-current','live'));
  store.setActiveProfile('codex','current');
});
after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('a mixed 64-account import reads the vault key only at batch boundaries', async () => {
  const key = Buffer.alloc(32, 7);
  let reads = 0;
  const restore = vault.setCredentialKeyProvider({ read: () => { reads++; return key; } });
  try {
    const entries = [];
    for (let i = 0; i < 64; i++) {
      const id = `batch-${i}`;
      if (i % 2) put(id, id);
      entries.push([id, auth(id)]);
    }
    const parsed = await combine(entries);
    reads = 0;
    const result = await backup.installBackup(parsed, parsed.items.map(item => item.key));
    assert.equal(reads, 3);
    assert.equal(result.imported.length, 32);
    assert.equal(result.updated.length, 32);
    for (const [index, [id, bytes]] of entries.entries()) {
      const installed = index % 2 ? staged(id) : file(id);
      assert.ok(fs.readFileSync(installed).toString('ascii', 0, 17).startsWith('AGS-CREDENTIALS-1'));
      assert.deepEqual(JSON.parse(readCredentialFile(installed)), JSON.parse(bytes));
    }
  } finally { restore(); }
});

test('losing or replacing the batch key before or during installation restores all originals', async () => {
  put('existing', 'existing');
  const live = path.join(agent.homeDir, 'auth.json');
  const originalLive = auth('existing', 'old');
  atomicWrite(live, originalLive);
  const meta = path.join(store.profileDir('codex', 'existing'), '_meta.json');
  const original = fs.readFileSync(file('existing')), originalMeta = fs.readFileSync(meta);
  const parsed = await combine([['candidate', auth('existing')], ['added', auth('added')]]);
  for (const [failAt, replacement] of [[2, null], [3, Buffer.alloc(32, 8)]]) {
    let reads = 0;
    const restore = vault.setCredentialKeyProvider({ read: () => {
      if (++reads !== failAt) return Buffer.alloc(32, 7);
      assert.equal(fs.existsSync(staged('existing')), failAt === 3);
      assert.equal(fs.existsSync(file('added')), failAt === 3);
      return replacement;
    } });
    try {
      await assert.rejects(backup.installBackup(parsed, parsed.items.map(item => item.key)), /密钥/);
      assert.deepEqual(fs.readFileSync(file('existing')), original);
      assert.deepEqual(fs.readFileSync(meta), originalMeta);
      assert.deepEqual(readCredentialFile(live), originalLive);
      assert.ok(!fs.existsSync(staged('existing')) && !fs.existsSync(file('added')));
      assert.ok(!fs.readdirSync(store.STORE_DIR).some(name => name.startsWith('.import-')));
    } finally { restore(); }
  }
});

test('an open import cannot authorize unrelated writes and its writer expires after closing', async () => {
  const staging = fs.mkdtempSync(path.join(store.STORE_DIR, '.import-'));
  let key = Buffer.alloc(32, 7);
  const restore = vault.setCredentialKeyProvider({ read: () => key });
  const candidate = path.join(staging, 'codex', '0', 'auth.json');
  try {
    const writer = await vault.createImportCredentialWriter(staging);
    atomicWrite(candidate, auth('candidate'), writer);
    key = Buffer.alloc(32, 9);
    assert.throws(() => atomicWrite(file('other'), auth('other')), /密钥/);
    assert.throws(() => atomicWrite(file('other'), auth('other'), writer), /范围/);
    const scoped = writer.forReplacement(store.profileDir('codex', 'selected'));
    assert.throws(() => atomicWrite(staged('other'), auth('other'), scoped), /范围/);
    await assert.rejects(writer.verifySystemKey(), /密钥/);
    writer.close();
    assert.throws(() => atomicWrite(candidate, auth('candidate', 'again'), writer), /范围/);
    assert.equal(fs.existsSync(file('other')), false);
  } finally { restore(); }
});

test('a corrupted encrypted staging file prevents the batch from publishing any account', async t => {
  const parsed = await combine([['a', auth('first')], ['b', auth('second')]]);
  const write = fs.writeFileSync;
  let corrupted = false;
  t.mock.method(fs, 'writeFileSync', (dest, data, ...args) => {
    if (typeof dest === 'string' && dest.includes('.import-') && dest.includes(path.join('1', 'auth.json.')) && dest.endsWith('.tmp')) {
      data = Buffer.from(data);
      data[data.length - 1] ^= 1;
      corrupted = true;
    }
    return write(dest, data, ...args);
  });
  await assert.rejects(backup.installBackup(parsed, parsed.items.map(item => item.key)), /校验失败/);
  assert.ok(corrupted);
  assert.deepEqual(store.listProfiles('codex'), []);
  assert.ok(!fs.readdirSync(store.STORE_DIR).some(name => name.startsWith('.import-')));
});

test('mixed Session import updates expired identity in place, skips healthy and batch duplicates, and adds new identities',async()=>{
  put('失效账号','expired');put('正常账号','healthy','ok');
  const live=readCredentialFile(path.join(agent.homeDir,'auth.json'));
  const healthy=readCredentialFile(file('正常账号'));
  const batch=await parse([auth('expired'),auth('healthy'),auth('expired','second-copy'),auth('new')]);
  assert.deepEqual(batch.items.map(x=>x.state),['update','duplicate','duplicate','ready']);
  assert.equal(batch.items[0].profile,'失效账号');
  assert.equal(batch.items[1].duplicate.source,'pool');
  assert.equal(batch.items[2].duplicate.source,'batch');
  assert.equal(batch.items[2].duplicate.key,batch.items[0].key);
  assert.doesNotMatch(JSON.stringify(batch.items),/access-new|refresh_token|credentialRevision/);
  await assert.rejects(batchImport.installCredentialBatch(batch,[batch.items[0].key],{[batch.items[0].key]:'改名'}),/保留原账号名称/);
  const result=await commit(batch);
  assert.deepEqual(result.updated,['codex/失效账号']);assert.equal(result.imported.length,1);assert.equal(result.skipped.length,2);
  // External import stages into .pending while preserving original auth.json until verified!
  assert.deepEqual(JSON.parse(readCredentialFile(file('失效账号'))),JSON.parse(auth('expired','old')));
  assert.deepEqual(JSON.parse(readCredentialFile(staged('失效账号'))),JSON.parse(auth('expired')));
  assert.deepEqual(readCredentialFile(file('正常账号')),healthy);
  const meta=store.readProfileMeta('codex','失效账号');
  assert.equal(meta.label,'原昵称');assert.equal(meta.quotaNote,'保留备注');assert.equal(meta.savedAt,'2026-01-01');
  assert.equal(meta.snapshot.state,'unverified');assert.equal(meta.snapshot.authExpired,false);assert.equal(meta.snapshot.checkedAt,undefined);
  assert.equal(meta.snapshot.quota.primaryWindow.usedPercent,90);
  assert.equal(meta.snapshot.fetchedAt,'2026-10-31');
  assert.equal(store.listProfiles('codex').length,3);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),live);assert.equal(store.getActiveProfile('codex'),'current');
  const repeated=await commit(await parse([auth('expired')]));
  assert.equal(repeated.updated,undefined);assert.equal(repeated.skipped.length,1);
});

test('backup import also stages expired identities, without importing source metadata or overwriting twice',async()=>{
  put('原账号','backup');
  const parsed=await combine([['来自别人的名称',auth('backup')],['另一份',auth('backup','later-copy')]]);
  parsed.groups.get(parsed.items[0].key).set('_meta.json',Buffer.from(JSON.stringify({label:'不应该覆盖',snapshot:{state:'ok'}})));
  const result=await backup.installBackup(parsed,parsed.items.map(x=>x.key));
  assert.deepEqual(result.updated,['codex/原账号']);assert.equal(result.imported.length,0);assert.equal(result.skipped.length,1);
  assert.deepEqual(readCredentialFile(file('原账号')),auth('backup','old'));
  assert.deepEqual(readCredentialFile(staged('原账号')),auth('backup'));
  assert.equal(store.readProfileMeta('codex','原账号').label,'原昵称');
  assert.equal(store.readProfileMeta('codex','原账号').snapshot.state,'unverified');
});

test('only authentication failures qualify; low quota, transient errors and stale failure snapshots stay untouched',async()=>{
  put('普通错误','network','error');put('额度耗尽','empty','ok');put('历史失效','changed');
  atomicWrite(file('历史失效'),auth('changed','already-new'));
  const batch=await parse([auth('network'),auth('empty'),auth('changed')]);
  assert.deepEqual(batch.items.map(x=>x.state),['duplicate','duplicate','duplicate']);
  assert.equal((await commit(batch)).skipped.length,3);
  assert.deepEqual(readCredentialFile(file('历史失效')),auth('changed','already-new'));
});

test('matching email alone never updates a different workspace or member',async()=>{
  put('个人','personal');
  const batch=await parse([auth('team'),auth('personal','new','another-member')]);
  assert.deepEqual(batch.items.map(x=>x.state),['ready','ready']);
  assert.equal((await commit(batch)).imported.length,2);
  assert.deepEqual(readCredentialFile(file('个人')),auth('personal','old'));
});

test('only a selected update from the preview can stage a replacement',async()=>{
  put('取消','unchecked');
  const unchecked=await parse([auth('unchecked')]);
  await batchImport.installCredentialBatch(unchecked,[],{});
  assert.deepEqual(readCredentialFile(file('取消')),auth('unchecked','old'));
  put('已恢复','recovered');const batch=await parse([auth('recovered')]);
  put('已恢复','recovered','ok','newer-from-login');
  const result=await commit(batch);
  assert.equal(result.skipped.length,1);assert.equal(result.updated,undefined);
  assert.deepEqual(readCredentialFile(file('已恢复')),auth('recovered','newer-from-login'));
  const newAccount=await parse([auth('appeared-later')]);
  assert.equal(newAccount.items[0].state,'ready');
  put('刚出现','appeared-later');
  const late=await commit(newAccount);
  assert.equal(late.skipped.length,1);
  assert.deepEqual(readCredentialFile(file('刚出现')),auth('appeared-later','old'));
  assert.equal(fs.existsSync(staged('刚出现')),false);
});

test('changed, replaced or removed update targets cannot be overwritten or recreated by a stale preview',async()=>{
  for(const change of ['credentials','identity','deleted']) {
    const name='target-'+change;put(name,change);
    const batch=await parse([auth(change)]);
    if(change==='credentials')put(name,change,'expired','different-generation');
    if(change==='identity')put(name,'another-identity');
    if(change==='deleted')fs.rmSync(store.profileDir('codex',name),{recursive:true});
    const before=fs.existsSync(file(name))?readCredentialFile(file(name)):null;
    await assert.rejects(commit(batch),/已变化/);
    assert.deepEqual(fs.existsSync(file(name))?readCredentialFile(file(name)):null,before);
  }
});

test('saving a separate local login recovers an expired profile under its original name',async()=>{
  put('自己的账号','local');
  const isolated=await accounts.prepareLogin(agent);atomicWrite(path.join(isolated,'auth.json'),auth('local'));
  const status=accounts.loginStatus(agent);
  assert.equal(status.existingProfile,'自己的账号');assert.equal(status.existingProfileUpdatable,true);
  const result=await accounts.saveAccount(agent,'另一个名称');
  assert.equal(result.profile,'自己的账号');assert.equal(result.updated,true);
  assert.deepEqual(store.listProfiles('codex'),['自己的账号']);
  assert.deepEqual(readCredentialFile(file('自己的账号')),auth('local'));
  assert.equal(fs.existsSync(isolated),false);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('unrelated-current','live'));
  assert.equal(store.getActiveProfile('codex'),'current');
});

test('healthy live cache for another credential version does not block recovery of the expired pool copy',async()=>{
  put('过期副本','cache-version');atomicWrite(path.join(agent.homeDir,'auth.json'),auth('cache-version','already-live'));
  const query=agent.queryLiveRpc;
  agent.queryLiveRpc=async()=>({account:{planType:'plus'},rates:{rateLimits:{primary:{usedPercent:12}}}});
  try {
    assert.equal((await accounts.refreshAccount(agent,undefined,true)).state,'ok');
    assert.equal(store.readProfileMeta('codex','过期副本').snapshot.state,'expired');
    const batch=await parse([auth('cache-version','incoming')]);
    assert.equal(batch.items[0].state,'update');
    assert.deepEqual((await commit(batch)).updated,['codex/过期副本']);
    assert.deepEqual(readCredentialFile(file('过期副本')),auth('cache-version','old'));
    assert.equal(JSON.parse(readCredentialFile(staged('过期副本'))).tokens.refresh_token,'incoming');
    assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('cache-version','already-live'));
    agent.queryLiveRpc=async dir=>{atomicWrite(path.join(dir,'auth.json'),auth('cache-version','incoming-verified'));return {account:{planType:'plus'},rates:{rateLimits:{primary:{usedPercent:12}}}};};
    assert.equal((await accounts.refreshAccount(agent,'过期副本',true)).state,'ok');
    assert.equal(JSON.parse(readCredentialFile(file('过期副本'))).tokens.refresh_token,'incoming-verified');
    assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('cache-version','already-live'));
  } finally {agent.queryLiveRpc=query;}
});
