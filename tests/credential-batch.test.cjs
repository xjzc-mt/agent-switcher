const {test,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ags-batch-import-'));
os.homedir=()=>root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const store=require('../dist/store');
const batchImport=require('../dist/credential-import');
const {codexAgent}=require('../dist/agents/codex');
const {atomicWrite}=require('../dist/utils');
Object.defineProperty(codexAgent,'homeDir',{value:path.join(root,'live')});
const auth=(workspace,email=`${workspace}@example.test`,subject=workspace)=>Buffer.from(JSON.stringify({tokens:{access_token:'secret-access-fixture',refresh_token:'secret-refresh-fixture',account_id:workspace,id_token:`h.${Buffer.from(JSON.stringify({email,sub:subject})).toString('base64url')}.s`}}));
const put=(name,data)=>atomicWrite(path.join(store.profileDir('codex',name),'auth.json'),data);
const parse=(value,fileName,agent='codex')=>batchImport.parseCredentialBatch(Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)),agent,fileName);
const namesFor=(batch,rename={})=>Object.fromEntries(batch.items.filter(x=>x.state==='ready').map(x=>[x.key,rename[x.profile]||x.profile]));
const commit=(batch,names=namesFor(batch))=>batchImport.installCredentialBatch(batch,Object.keys(names),names);
beforeEach(()=>{fs.rmSync(store.STORE_DIR,{recursive:true,force:true});fs.rmSync(codexAgent.homeDir,{recursive:true,force:true});});
after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('a single document derives editable names from filename and identity, without exposing credentials',async()=>{
  const single=await parse(auth('work'),'工作主力.json');
  assert.equal(single.items[0].profile,'工作主力');
  const generic=await parse(auth('alice'),'auth (1).json');
  assert.equal(generic.items[0].profile,'alice');
  const batch=await parse([JSON.parse(auth('one','alice@example.test')),JSON.parse(auth('two','alice@other.test'))]);
  assert.deepEqual(batch.items.map(x=>x.profile),['alice','alice (2)']);
  assert.equal(new Set(batch.items.map(x=>x.key)).size,2);
  assert.doesNotMatch(JSON.stringify(batch.items),/secret-access|secret-refresh|id_token/);
});

test('existing and within-batch duplicates are previewed without renaming or replacing saved credentials',async()=>{
  const original=auth('existing');put('已保存',original);
  const batch=await parse([JSON.parse(original),JSON.parse(auth('new')),JSON.parse(auth('new')),null,JSON.parse(auth('second'))]);
  assert.deepEqual(batch.items.map(x=>x.state),['duplicate','ready','duplicate','error','ready']);
  assert.deepEqual(batch.items[0].duplicate,{key:'codex/已保存',profile:'已保存',source:'pool'});
  assert.equal(batch.items[2].duplicate.source,'batch');
  assert.equal(batch.items[2].duplicate.key,batch.items[1].key);
  const names={[batch.items[1].key]:'重命名后的主力'};
  atomicWrite(path.join(codexAgent.homeDir,'auth.json'),auth('live-A'));
  const result=await commit(batch,names);
  assert.deepEqual(result.imported,['codex/重命名后的主力']);assert.equal(result.skipped.length,2);assert.equal(result.failed.length,1);
  assert.deepEqual(store.listProfiles('codex').sort(),['已保存','重命名后的主力'].sort());
  assert.deepEqual(readCredentialFile(path.join(store.profileDir('codex','已保存'),'auth.json')),original);
  assert.equal(codexAgent.identity().id,'live-A:live-A');
});

test('email alone does not merge distinct workspaces or different members',async()=>{
  put('个人',auth('personal','same@example.test','member'));
  const batch=await parse([JSON.parse(auth('team','same@example.test','member')),JSON.parse(auth('team','same@example.test','other-member'))]);
  assert.deepEqual(batch.items.map(x=>x.state),['ready','ready']);
  assert.equal((await commit(batch)).imported.length,2);
});

test('names are validated in the main process and cannot bypass identity-based deduplication',async()=>{
  const batch=await parse([JSON.parse(auth('a')),JSON.parse(auth('b'))]);
  for(const value of ['../escape','a/b','a\\b','',null,'a\n'])await assert.rejects(commit(batch,{[batch.items[0].key]:value}),/名称/);
  await assert.rejects(commit(batch,{[batch.items[0].key]:'same',[batch.items[1].key]:'same'}),/重复/);
  await assert.rejects(batchImport.installCredentialBatch(batch,['unknown'],{unknown:'x'}),/有效/);
  await assert.rejects(batchImport.installCredentialBatch(batch,[batch.items[0].key],{}),/填写/);
  assert.deepEqual(store.listProfiles('codex'),[]);
  assert.equal((await commit(batch)).imported.length,2);
  const again=await commit(batch,{[batch.items[0].key]:'另一名称'});
  assert.deepEqual(again.imported,[]);assert.equal(again.skipped.length,1);
});

test('late name collision rolls back only this batch, then permits retry with a corrected name',async()=>{
  const batch=await parse([JSON.parse(auth('a')),JSON.parse(auth('b'))]);
  put('冲突',auth('other'));
  await assert.rejects(commit(batch,{[batch.items[0].key]:'可用',[batch.items[1].key]:'冲突'}),/已被使用/);
  assert.deepEqual(store.listProfiles('codex'),['冲突']);
  const result=await commit(batch,{[batch.items[0].key]:'可用',[batch.items[1].key]:'改好了'});
  assert.deepEqual(result.imported,['codex/可用','codex/改好了']);
});

test('duplicates introduced after preview are skipped using current pool identities',async()=>{
  const batch=await parse(auth('late'));
  put('刚保存',auth('late'));
  const result=await commit(batch);
  assert.deepEqual(result.imported,[]);assert.equal(result.skipped[0].existing,'codex/刚保存');
});

test('all-duplicate batches complete without writes, and deselected accounts stay out of the pool',async()=>{
  put('已保存',auth('one'));
  const duplicates=await parse(auth('one'));
  assert.equal((await commit(duplicates)).skipped.length,1);
  const batch=await parse([JSON.parse(auth('two')),JSON.parse(auth('three'))]);
  const result=await commit(batch,{});assert.deepEqual(result.imported,[]);
  assert.deepEqual(store.listProfiles('codex'),['已保存']);
});

const native=id=>JSON.parse(auth(id));
const document=value=>Buffer.from(JSON.stringify(value));
test('one JSON file contains independently named native, wrapped, malformed and duplicate records',async()=>{
  const batch=await parse(document([{name:'日常',...native('a')},{name:'长任务',credentials:native('b')},null,{tokens:{refresh_token:'incomplete'}},{...native('a')} ]));
  assert.deepEqual(batch.items.map(x=>x.state),['ready','ready','error','error','duplicate']);
  assert.deepEqual(batch.items.map(x=>x.sourceIndex),[1,2,3,4,5]);
  assert.deepEqual(batch.items.slice(0,2).map(x=>x.profile),['日常','长任务']);
  const result=await commit(batch,{[batch.items[0].key]:'可修改名称',[batch.items[1].key]:'长任务'});
  assert.equal(result.imported.length,2);assert.equal(result.failed.length,2);assert.equal(result.skipped.length,1);
  assert.equal(codexAgent.identity(store.profileDir('codex','可修改名称')).id,'a:a');
  assert.equal(codexAgent.identity(store.profileDir('codex','长任务')).id,'b:b');
});

test('unknown exporters: nested wrappers, JSON strings, object maps and extra metadata are accepted',async()=>{
  const batch=await parse(document({version:99,statistics:{total:3},data:{accounts:{
    '工作':{credentials:JSON.stringify(native('work')),notes:'ignored'},
    '备用':{label:'单独命名',payload:{auth_json:JSON.stringify(JSON.stringify(native('spare')))}},
    '另一个':{vendorContainer:{...native('third'),arbitraryMetadata:{secret:'discard'}}},
  }}}));
  assert.deepEqual(batch.items.map(x=>x.state),['ready','ready','ready']);
  assert.deepEqual(batch.items.map(x=>x.profile),['工作','单独命名','另一个']);
  assert.equal((await commit(batch)).imported.length,3);
  assert.doesNotMatch(JSON.stringify(batch.items),/secret-access|secret-refresh|arbitraryMetadata|discard/);
  assert.deepEqual(JSON.parse(readCredentialFile(path.join(store.profileDir('codex','另一个'),'auth.json'))),native('third'));
});

test('snake_case and camelCase flat OAuth records keep tokens intact and discard exporter fields',async()=>{
  const tokens=native('alias').tokens;
  const batch=await parse(document([{nickname:'兼容命名',accessToken:tokens.access_token,refreshToken:tokens.refresh_token,idToken:tokens.id_token,accountId:tokens.account_id,
    expiresIn:3600,remark:'discard',apiBase:'https://untrusted.example',config:{model:'discard'}}]));
  assert.equal(batch.items[0].state,'ready');
  await commit(batch);
  assert.deepEqual(JSON.parse(readCredentialFile(path.join(store.profileDir('codex','兼容命名'),'auth.json'))),{tokens});
});

test('only allowlisted auth fields persist; optional nulls and BOM do not prevent import',async()=>{
  const value={...native('clean'),OPENAI_API_KEY:null,auth_mode:'chatgpt',last_refresh:'2026-11-10T00:00:00Z',admin:true,
    config:{model:'discard'},logs:[native('old')],tokens:{...native('clean').tokens,extra_secret:'discard',email:null}};
  const batch=await parse(Buffer.from('\uFEFF'+JSON.stringify(value)));
  assert.equal(batch.items.length,1);await commit(batch);
  const saved=JSON.parse(readCredentialFile(path.join(store.profileDir('codex',batch.items[0].profile),'auth.json')));
  assert.deepEqual(saved,{tokens:native('clean').tokens,auth_mode:'chatgpt',last_refresh:value.last_refresh});
});

test('incomplete records never borrow tokens from siblings or parents, conflicting aliases are rejected',async()=>{
  const batch=await parse(document([
    {credentials:{access_token:'access-only'},refresh_token:'parent-refresh'},
    {access_token:'access-only'}, {refresh_token:'refresh-only'},
    {tokens:{...native('conflict').tokens,refreshToken:'different-generation'}},
    {tokens:native('types').tokens,OPENAI_API_KEY:'another-auth'},
    {tokens:{...native('badtype').tokens,access_token:123}},
    native('valid'),
  ]));
  assert.deepEqual(batch.items.map(x=>x.state),['error','error','error','error','error','error','ready']);
  assert.doesNotMatch(JSON.stringify(batch.items),/access-only|parent-refresh|different-generation|another-auth/);
  assert.equal((await commit(batch)).imported.length,1);
});

test('metadata and cached credential histories are not mistaken for new accounts',async()=>{
  const batch=await parse(document({logs:[native('history')],cache:native('cached'),metadata:{credentials:native('meta')},arbitraryWrapper:{accounts:[native('current')]}}));
  assert.equal(batch.items.length,1);assert.equal(batch.items[0].email,'current@example.test');
});

test('single credential compatibility, invalid names and bundle filenames fall back to identity',async()=>{
  const single=await parse(auth('single'),'我的工作.json');
  assert.equal(single.items[0].profile,'我的工作');assert.equal(single.items[0].sourceIndex,undefined);
  const batch=await parse(document({accounts:[{name:'../../escape',...native('one')},{name:123,...native('two')}]}));
  assert.deepEqual(batch.items.map(x=>x.profile),['one','two']);
  const encoded=await parse(document(JSON.stringify(native('encoded'))));
  assert.equal(encoded.items[0].state,'ready');
});

test('malformed, oversized and deeply nested documents fail safely without partial installation',async()=>{
  const {parseCredentialDocument}=require('../dist/credential-document');
  assert.throws(()=>parseCredentialDocument(Buffer.from('{"secret":"never-display" broken')),/JSON/);
  assert.throws(()=>parseCredentialDocument(Buffer.alloc(32*1024*1024+1)),/32 MB/);
  assert.throws(()=>parseCredentialDocument(Buffer.from(JSON.stringify(Array.from({length:201},()=>native('many')))),'codex'),/200/);
  let deep=native('deep');for(let i=0;i<26;i++)deep={data:deep};
  assert.throws(()=>parseCredentialDocument(Buffer.from(JSON.stringify(deep)),'codex'),/复杂/);
  const batch=await parse(document([{tokens:{...native('large').tokens,access_token:'x'.repeat(1024*1024+1)}},native('small')]));
  assert.deepEqual(batch.items.map(x=>x.state),['error','ready']);assert.match(batch.items[0].error,/1 MB/);
  assert.deepEqual(store.listProfiles('codex'),[]);
});

test('native Claude and Antigravity credential fields survive extraction; selected platform is enforced',async()=>{
  const claude=await parse(document({data:{claudeAiOauth:{accessToken:'a',refreshToken:'r',expiresAt:123,scopes:['profile'],subscriptionType:'pro',rateLimitTier:'tier',junk:'remove'},email:'claude@example.test',other:'remove'}}),undefined,'claude');
  assert.equal(claude.items[0].state,'ready');await commit(claude);
  const saved=JSON.parse(readCredentialFile(path.join(store.profileDir('claude',claude.items[0].profile),'.credentials.json')));
  assert.equal(saved.claudeAiOauth.expiresAt,123);assert.equal(saved.claudeAiOauth.junk,undefined);
  const agy=await parse(document({token:{access_token:'a',refresh_token:'r',expiry:'2026-12-01'},auth_method:'oauth',junk:'remove'}),undefined,'agy');
  assert.equal(agy.items[0].state,'ready');
  const wrong=await parse(document({claudeAiOauth:{refreshToken:'r'}}));assert.equal(wrong.items[0].state,'error');
});

test('API keys stay native; flat records with a conflicting platform and browser-only sessions are rejected',async()=>{
  const key=await parse(document({OPENAI_API_KEY:'fake-api-key',config:{model:'discard'}}));
  assert.equal(key.items[0].state,'ready');await commit(key);
  assert.deepEqual(JSON.parse(readCredentialFile(path.join(store.profileDir('codex',key.items[0].profile),'auth.json'))),{OPENAI_API_KEY:'fake-api-key'});
  const cases=await parse(document([{type:'claude',...native('foreign').tokens},{accessToken:'browser-only'},{cookie:'session-cookie',user:{email:'web@example.test'}}, {...native('valid'),last_refresh:'invalid-date'}]));
  assert.deepEqual(cases.items.map(x=>x.state),['error','error','error','ready']);
  const files=cases.parsed.groups.get(cases.items[3].key);assert.equal(JSON.parse(files.get('auth.json')).last_refresh,undefined);
});

test('concatenated native Codex records preserve OAuth source, login owner and timestamp precision on disk',async()=>{
  const first={auth_mode:'chatgpt',OPENAI_API_KEY:null,...native('source-a'),last_refresh:'2026-11-06T09:09:09.987210Z'};
  first.tokens.oauth_provenance={issuer:'https://auth.openai.com',client_id:'fixture-client',unrelated:'discard'};
  first.tokens.login_owner_id='fixture-login-owner';
  const second={auth_mode:'chatgpt',...native('source-b')};
  const batch=await parse(Buffer.from(JSON.stringify(first,null,2)+'\n'+JSON.stringify(second,null,2)),'concat.json');
  assert.deepEqual(batch.items.map(x=>x.state),['ready','ready']);
  await commit(batch);
  const saved=JSON.parse(readCredentialFile(path.join(store.profileDir('codex',batch.items[0].profile),'auth.json')));
  const {unrelated,...provenance}=first.tokens.oauth_provenance;
  assert.deepEqual(saved,{auth_mode:first.auth_mode,tokens:{...first.tokens,oauth_provenance:provenance},last_refresh:first.last_refresh});
  assert.equal(saved.tokens.refresh_token,first.tokens.refresh_token);
  assert.doesNotMatch(JSON.stringify(batch.items),/fixture-client|fixture-login-owner|secret-refresh/);
});

test('conflicting OAuth provenance, invalid login type and malformed token containers do not contaminate good records',async()=>{
 const base=native('ambiguous');
 const batch=await parse(document([
   {...base,tokens:{...base.tokens,oauth_provenance:{issuer:'https://auth.example.test',client_id:'one'},oauthProvenance:{issuer:'https://auth.example.test',clientId:'two'}}},
   {...base,auth_mode:'chatgptAuthTokens'},
   {tokens:42},
   native('good-record'),
 ]));
 assert.deepEqual(batch.items.map(x=>x.state),['error','error','error','ready']);
});

test('large JSONC documents use the worker and retain installable bytes; malformed documents fail', async () => {
  const large = { ...JSON.parse(auth('large')), logs: 'x'.repeat(300 * 1024) };
  const batch = await parse(Buffer.from(JSON.stringify(large) + '\n// fixture'), 'valid.jsonc');
  assert.deepEqual(batch.items.map(item => item.state), ['ready']);
  await commit(batch);
  assert.equal(codexAgent.identity(store.profileDir('codex', 'valid')).email, 'large@example.test');
  await assert.rejects(parse(Buffer.from(' '.repeat(300 * 1024) + '{')), /JSON/);
});
