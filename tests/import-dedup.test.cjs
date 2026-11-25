const { createTestHome, readCredentialFile, jwt } = require('./helpers/test-env.cjs');
const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root = createTestHome('ags-import-dedup-');
const store=require('../dist/store');
const backup=require('../dist/backup');
const {atomicWrite}=require('../dist/utils');
const auth=(workspace,subject='person',refresh='original')=>Buffer.from(JSON.stringify({tokens:{
  access_token:'fixture-access',refresh_token:refresh,account_id:workspace,
  id_token:jwt({sub:subject,email:'same@example.test'}),
}}));
const put=(name,bytes)=>atomicWrite(path.join(store.profileDir('codex',name),'auth.json'),bytes);
const combine=async entries=>{
  const parts=await Promise.all(entries.map(([name,bytes,agent='codex'])=>backup.parseCredentials(bytes,agent,name)));
  return {groups:new Map(parts.flatMap(p=>[...p.groups])),items:parts.flatMap(p=>p.items)};
};
const install=parsed=>backup.installBackup(parsed,parsed.items.map(i=>i.key));
beforeEach(()=>fs.rmSync(store.STORE_DIR,{recursive:true,force:true}));

test('mixed imports skip existing and within-backup identities without touching existing credentials',async()=>{
  const existing=auth('personal','person','live-rotated');put('已保存',existing);
  const parsed=await combine([
    ['换个名字的同一账号',auth('personal','person','old-backup')],
    ['新账号',auth('new')],['备份内重复',auth('new','person','another-token')],
  ]);
  const result=await install(parsed);
  assert.deepEqual(result,{imported:['codex/新账号'],skipped:[
    {key:'codex/换个名字的同一账号',existing:'codex/已保存'},
    {key:'codex/备份内重复',existing:'codex/新账号'},
  ]});
  assert.deepEqual(readCredentialFile(path.join(store.profileDir('codex','已保存'),'auth.json')),existing);
  assert.equal(store.listProfiles('codex').length,2);
  const repeat=await install(parsed);assert.equal(repeat.imported.length,0);assert.equal(repeat.skipped.length,3);
  assert.equal(store.listProfiles('codex').length,2);
});
test('same display name for a new identity is renamed, while duplicates added after preview are skipped',async()=>{
  put('同名',auth('first'));
  const preview=await combine([['同名',auth('new')],['预览后已存在',auth('late')]]);
  put('另一个名字',auth('late','person','newer-token'));
  assert.deepEqual(await install(preview),{imported:['codex/同名-import-1'],skipped:[{key:'codex/预览后已存在',existing:'codex/另一个名字'}]});
});
test('API keys deduplicate by key identity and remain separate across providers',async()=>{
  const api=Buffer.from(JSON.stringify({OPENAI_API_KEY:'fixture-key'}));put('API',api);
  // Force equal identity strings across providers to check namespace isolation.
  const keyIdentity=require('../dist/agents/codex').codexAgent.identity(store.profileDir('codex','API')).id;
  const agy=Buffer.from(JSON.stringify({auth_method:'consumer',id_token_email:keyIdentity,token:{refresh_token:'fixture-refresh'}}));
  const result=await install(await combine([['重复Key',api],['不同Key',Buffer.from(JSON.stringify({OPENAI_API_KEY:'another-key'}))],['另一平台',agy,'agy']]));
  assert.equal(result.imported.length,2);assert.deepEqual(result.skipped,[{key:'codex/重复Key',existing:'codex/API'}]);
});
test('case-colliding backup profile names stage separately without overwriting credentials on case-insensitive disks', async () => {
  const first = auth('case-alice', 'alice-sub', 'alice-rt');
  const second = auth('case-bob', 'bob-sub', 'bob-rt');
  const parsed = await combine([['work', first], ['Work', second]]);
  const result = await install(parsed);
  assert.deepEqual(result.imported, ['codex/work', 'codex/Work-import-1']);
  assert.deepEqual(readCredentialFile(path.join(store.profileDir('codex', 'work'), 'auth.json')), first);
  assert.deepEqual(readCredentialFile(path.join(store.profileDir('codex', 'Work-import-1'), 'auth.json')), second);
});
