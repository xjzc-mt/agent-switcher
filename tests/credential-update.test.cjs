const {test,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ags-credential-update-'));
os.homedir=()=>root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const store=require('../dist/store');
const backup=require('../dist/backup');
const accounts=require('../dist/accounts');
const {codexAgent:agent}=require('../dist/agents/codex');
const utils=require('../dist/utils');
Object.defineProperty(agent,'homeDir',{value:path.join(root,'live')});
const auth=(workspace,token='old',member='person')=>Buffer.from(JSON.stringify({tokens:{account_id:workspace,access_token:'access-'+token,refresh_token:token,id_token:`h.${Buffer.from(JSON.stringify({sub:member,email:'same@example.test'})).toString('base64url')}.s`}}));
const file=name=>path.join(store.profileDir('codex',name),'auth.json');
function expired(name,id){
  utils.atomicWrite(file(name),auth(id));
  store.writeProfileMeta('codex',name,{label:name,email:'same@example.test',savedAt:'2026-01-01',quotaNote:'keep',snapshot:{state:'expired',authExpired:true,available:true,plan:'plus',checkedAt:'2026-01-02',fetchedAt:'2026-01-01',extra:'凭据失效',refreshFailures:3,quota:{primaryWindow:{usedPercent:40}}}});
}
const preview=(name,id,token='new',member)=>backup.previewCredentialUpdate(auth(id,token,member),'codex',name);
const install=p=>backup.installCredentialUpdate(p.parsed,p.target);
beforeEach(()=>{
  for(const dir of [store.STORE_DIR,agent.homeDir])fs.rmSync(dir,{recursive:true,force:true});
  agent.queryLiveRpc=async()=>({account:{planType:'plus'},rates:{rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}}});
});
after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('explicit update replaces an expired profile in place and subsequent import skips it',async()=>{
  expired('我的账号','A');
  const before=readCredentialFile(file('我的账号'));
  const p=await preview('我的账号','A');
  assert.deepEqual(readCredentialFile(file('我的账号')),before);
  assert.deepEqual(await install(p),{ok:true,agent:'codex',profile:'我的账号'});
  const duplicate=await backup.installBackup(p.parsed,p.parsed.items.map(i=>i.key));
  assert.equal(duplicate.imported.length,0);assert.equal(duplicate.skipped.length,1);
  assert.deepEqual(store.listProfiles('codex'),['我的账号']);
  assert.deepEqual(readCredentialFile(file('我的账号')),auth('A','new'));
  const meta=store.readProfileMeta('codex','我的账号');
  assert.equal(meta.label,'我的账号');assert.equal(meta.savedAt,'2026-01-01');assert.equal(meta.quotaNote,'keep');
  assert.equal(meta.snapshot.state,'unverified');assert.equal(meta.snapshot.authExpired,false);
  assert.equal(meta.snapshot.extra,undefined);assert.equal(meta.snapshot.checkedAt,undefined);
  assert.equal(meta.snapshot.fetchedAt,'2026-01-01');assert.equal(meta.snapshot.quota.primaryWindow.usedPercent,40);
  assert.equal(fs.statSync(file('我的账号')).mode&0o777,0o600);
  let queried;
  agent.queryLiveRpc=async dir=>{queried=JSON.parse(readCredentialFile(path.join(dir,'auth.json'))).tokens.refresh_token;return {account:{},rates:{rateLimits:{primary:{usedPercent:10}}}};};
  assert.equal((await accounts.refreshAccount(agent,'我的账号',true)).state,'ok');assert.equal(queried,'new');
});

test('wrong workspace, different member, malformed credentials and healthy targets cannot be replaced',async()=>{
  expired('target','B');const before=readCredentialFile(file('target'));
  await assert.rejects(preview('target','another-workspace'),/不属于/);
  await assert.rejects(preview('target','B','new','different-member'),/不属于/);
  await assert.rejects(backup.previewCredentialUpdate(Buffer.from('{}'),'codex','target'),/凭据/);
  store.writeProfileMeta('codex','target',{snapshot:{state:'ok',available:true}});
  await assert.rejects(preview('target','B'),/未标记/);
  assert.deepEqual(readCredentialFile(file('target')),before);
});

test('unresolved authentication allows replacement without treating network failures as invalid credentials',async()=>{
  for(const reason of ['account-unavailable','authentication-rejected']) {
    expired('target','B');
    store.writeProfileMeta('codex','target',{snapshot:{state:'error',available:true,authFailure:reason}});
    await install(await preview('target','B'));
    assert.deepEqual(readCredentialFile(file('target')),auth('B','new'));
  }
  for(const snapshot of [{state:'error',available:true,extra:'网络连接失败'},{state:'ok',available:true,authFailure:'account-unavailable'}]) {
    store.writeProfileMeta('codex','target',{snapshot});
    await assert.rejects(preview('target','B'),/未标记/);
  }
});

test('commit rechecks deleted, replaced and recovered targets after preview',async()=>{
  expired('target','C');const p=await preview('target','C');
  fs.rmSync(store.profileDir('codex','target'),{recursive:true});
  await assert.rejects(install(p),/不存在/);
  expired('target','D');await assert.rejects(install(p),/已变化/);
  expired('target','C');store.writeProfileMeta('codex','target',{snapshot:{state:'ok',available:true}});
  await assert.rejects(install(p),/未标记/);
  assert.deepEqual(readCredentialFile(file('target')),auth('C'));
});

test('updating a standby account never switches the live account or touches project files',async()=>{
  expired('standby','E');utils.atomicWrite(path.join(agent.homeDir,'auth.json'),auth('LIVE'));
  const config=Buffer.from('model="keep"'),projects=Buffer.from('{"projects":["keep"]}');
  utils.atomicWrite(path.join(agent.homeDir,'config.toml'),config);
  utils.atomicWrite(path.join(agent.homeDir,'.codex-global-state.json'),projects);
  store.setActiveProfile('codex','current');
  await install(await preview('standby','E'));
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('LIVE'));
  assert.equal(store.getActiveProfile('codex'),'current');
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'config.toml')),config);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'.codex-global-state.json')),projects);
});

test('updating the current expired account updates live auth and clears the old expired cache',async()=>{
  expired('current','F');utils.atomicWrite(path.join(agent.homeDir,'auth.json'),auth('F'));
  store.setActiveProfile('codex','current');
  agent.queryLiveRpc=async()=>{throw new Error('凭据失效');};
  await accounts.refreshAccount(agent,'current',true);
  await install(await preview('current','F'));
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('F','new'));
  assert.equal(accounts.dashboard()[0].status.state,'unverified');
  assert.equal(store.getActiveProfile('codex'),'current');
});

test('a failed live write rolls profile credentials and metadata back together',async()=>{
  expired('current','G');utils.atomicWrite(path.join(agent.homeDir,'auth.json'),auth('G'));
  const meta=readCredentialFile(path.join(store.profileDir('codex','current'),'_meta.json'));
  const p=await preview('current','G');
  const original=utils.replaceFiles;
  utils.replaceFiles=(dir,files)=>{if(dir===agent.homeDir)throw new Error('simulated write failure');return original(dir,files);};
  try{await assert.rejects(install(p),/write failure/);}finally{utils.replaceFiles=original;}
  assert.deepEqual(readCredentialFile(file('current')),auth('G'));
  assert.deepEqual(readCredentialFile(path.join(store.profileDir('codex','current'),'_meta.json')),meta);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('G'));
});

test('unsuccessful verification retains the explicitly updated credentials without claiming success',async()=>{
  expired('target','H');await install(await preview('target','H'));
  agent.queryLiveRpc=async()=>{throw new Error('凭据失效');};
  const result=await accounts.refreshAccount(agent,'target',true);
  assert.equal(result.state,'expired');assert.deepEqual(readCredentialFile(file('target')),auth('H','new'));
});
