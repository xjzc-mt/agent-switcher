const {test,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ags-import-recovery-'));
os.homedir=()=>root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const accounts=require('../dist/accounts'),store=require('../dist/store');
const backup=require('../dist/backup'),batchImport=require('../dist/credential-import');
const {codexAgent:agent}=require('../dist/agents/codex');
const {credentialState}=require('../dist/credential-state');
const {atomicWrite}=require('../dist/utils');
Object.defineProperty(agent,'homeDir',{value:path.join(root,'live')});
const auth=(id,token='new',member='person')=>Buffer.from(JSON.stringify({tokens:{account_id:id,access_token:'access-'+token,refresh_token:token,id_token:`h.${Buffer.from(JSON.stringify({sub:member,email:'same@example.test'})).toString('base64url')}.s`}}));
const file=name=>path.join(store.profileDir('codex',name),'auth.json');
function put(name,id,state='expired',token='old') {
  atomicWrite(file(name),auth(id,token));
  store.writeProfileMeta('codex',name,{label:'原昵称',quotaNote:'保留备注',savedAt:'2026-01-01',snapshot:{
    state,available:true,authExpired:state==='expired',credentialRevision:credentialState(agent,store.profileDir('codex',name)).revision,
    checkedAt:'2026-11-01',quota:{primaryWindow:{usedPercent:90}},
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

test('mixed Session import updates expired identity in place, skips healthy and batch duplicates, and adds new identities',async()=>{
  put('失效账号','expired');put('正常账号','healthy','ok');
  const live=readCredentialFile(path.join(agent.homeDir,'auth.json'));
  const healthy=readCredentialFile(file('正常账号'));
  const batch=await parse([auth('expired'),auth('healthy'),auth('expired','second-copy'),auth('new')]);
  assert.deepEqual(batch.items.map(x=>x.state),['update','duplicate','duplicate','ready']);
  assert.equal(batch.items[0].profile,'失效账号');
  assert.equal(batch.items[2].duplicate.key,batch.items[0].key);
  assert.doesNotMatch(JSON.stringify(batch.items),/access-new|refresh_token|credentialRevision/);
  await assert.rejects(batchImport.installCredentialBatch(batch,[batch.items[0].key],{[batch.items[0].key]:'改名'}),/保留原账号名称/);
  const result=await commit(batch);
  assert.deepEqual(result.updated,['codex/失效账号']);assert.equal(result.imported.length,1);assert.equal(result.skipped.length,2);
  assert.deepEqual(JSON.parse(readCredentialFile(file('失效账号'))),JSON.parse(auth('expired')));
  assert.deepEqual(readCredentialFile(file('正常账号')),healthy);
  const meta=store.readProfileMeta('codex','失效账号');
  assert.equal(meta.label,'原昵称');assert.equal(meta.quotaNote,'保留备注');assert.equal(meta.savedAt,'2026-01-01');
  assert.equal(meta.snapshot.state,'unverified');assert.equal(meta.snapshot.authExpired,false);assert.equal(meta.snapshot.checkedAt,undefined);
  assert.equal(meta.snapshot.quota.primaryWindow.usedPercent,90);
  assert.equal(store.listProfiles('codex').length,3);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),live);assert.equal(store.getActiveProfile('codex'),'current');
  const repeated=await commit(await parse([auth('expired')]));
  assert.equal(repeated.updated,undefined);assert.equal(repeated.skipped.length,1);
});

test('backup import also updates expired identities, without importing source metadata or overwriting twice',async()=>{
  put('原账号','backup');
  const parsed=await combine([['来自别人的名称',auth('backup')],['另一份',auth('backup','later-copy')]]);
  parsed.groups.get(parsed.items[0].key).set('_meta.json',Buffer.from(JSON.stringify({label:'不应该覆盖',snapshot:{state:'ok'}})));
  const result=await backup.installBackup(parsed,parsed.items.map(x=>x.key));
  assert.deepEqual(result.updated,['codex/原账号']);assert.equal(result.imported.length,0);assert.equal(result.skipped.length,1);
  assert.deepEqual(readCredentialFile(file('原账号')),auth('backup'));
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

test('deselected updates do not write, and accounts recovered after preview are skipped',async()=>{
  put('取消','unchecked');
  const unchecked=await parse([auth('unchecked')]);
  await batchImport.installCredentialBatch(unchecked,[],{});
  assert.deepEqual(readCredentialFile(file('取消')),auth('unchecked','old'));
  put('已恢复','recovered');const batch=await parse([auth('recovered')]);
  put('已恢复','recovered','ok','newer-from-login');
  const result=await commit(batch);
  assert.equal(result.skipped.length,1);assert.equal(result.updated,undefined);
  assert.deepEqual(readCredentialFile(file('已恢复')),auth('recovered','newer-from-login'));
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

test('a late import failure rolls back updated credentials, current auth, metadata and new accounts',async()=>{
  put('当前失效','rollback');atomicWrite(path.join(agent.homeDir,'auth.json'),auth('rollback','old'));
  const meta=readCredentialFile(path.join(store.profileDir('codex','当前失效'),'_meta.json'));
  const parsed=await combine([['待更新',auth('rollback')],['新增',auth('new')],['损坏',auth('bad')]]);
  parsed.groups.get('codex/损坏').set('auth.json',Buffer.from('{}'));
  await assert.rejects(backup.installBackup(parsed,parsed.items.map(x=>x.key)),/凭据/);
  assert.deepEqual(store.listProfiles('codex'),['当前失效']);
  assert.deepEqual(readCredentialFile(file('当前失效')),auth('rollback','old'));
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('rollback','old'));
  assert.deepEqual(readCredentialFile(path.join(store.profileDir('codex','当前失效'),'_meta.json')),meta);
  assert.equal(fs.readdirSync(store.STORE_DIR).some(x=>x.startsWith('.import-')),false);
});

test('updating the failed pool copy preserves different credentials already active for the same identity',async()=>{
  put('旧副本','same-user');atomicWrite(path.join(agent.homeDir,'auth.json'),auth('same-user','already-live'));
  const result=await commit(await parse([auth('same-user','imported')]));
  assert.deepEqual(result.updated,['codex/旧副本']);
  assert.deepEqual(JSON.parse(readCredentialFile(file('旧副本'))),JSON.parse(auth('same-user','imported')));
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('same-user','already-live'));
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
    assert.equal(JSON.parse(readCredentialFile(file('过期副本'))).tokens.refresh_token,'incoming');
    assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('cache-version','already-live'));
  } finally {agent.queryLiveRpc=query;}
});
