const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ags-provider-test-'));
os.homedir=()=>root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const {atomicWrite}=require('../dist/utils');
const {AntigravityAgent,detectAntigravityRuntime}=require('../dist/agents/antigravity');
const {ClaudeAgent,parseClaudeAuthStatus}=require('../dist/agents/claude');
const accounts=require('../dist/accounts');
const store=require('../dist/store');
const policy=require('../renderer/account-policy');
test('installed Antigravity metadata identifies both adapter generations with a binary plist', {skip:process.platform!=='darwin'}, () => {
  const contents=path.join(root,'Applications/Antigravity.app/Contents');
  fs.mkdirSync(contents,{recursive:true});
  try {
    for(const [version,expected] of [['1.9','legacy'],['2.3','unified']]) {
      const binary=require('node:child_process').execFileSync('/usr/bin/plutil',['-convert','binary1','-o','-','-'],{
        input:`<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
      });
      fs.writeFileSync(path.join(contents,'Info.plist'),binary);
      assert.equal(detectAntigravityRuntime(),expected);
    }
  } finally {fs.rmSync(path.join(root,'Applications'),{recursive:true,force:true});}
});
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const credentials=JSON.stringify({refresh_token:'fake-refresh',access_token:'fake-access',id_token:`x.${Buffer.from(JSON.stringify({sub:'test-person',email:'test@example.test'})).toString('base64url')}.x`});

test('unified Antigravity ignores leftover legacy tokens while retaining imported backups',async()=>{
  const agent=new AntigravityAgent(()=> 'unified', false);
  atomicWrite(path.join(agent.homeDir,agent.authFiles[0]),credentials);
  atomicWrite(path.join(store.profileDir('agy','backup'),agent.authFiles[0]),credentials);
  assert.equal(agent.identity(),undefined);
  assert.equal(agent.identity(store.profileDir('agy','backup')).email,'test@example.test');
  assert.equal(agent.displayStatus().available,false);
  assert.equal(agent.management().canSaveCurrent,false);
  await assert.rejects(accounts.useAccount(agent,'backup', { saveUnmanaged: true }),/共用认证/);
  await assert.rejects(accounts.saveAccount(agent,'live'),/共用认证/);
  assert.equal(readCredentialFile(path.join(agent.homeDir,agent.authFiles[0]),'utf8'),credentials);
});
test('unrecognized Antigravity runtime cannot overwrite credentials; legacy adapter stays available',()=>{
  assert.ok(new AntigravityAgent(()=> 'unknown').switchSupport());
  const legacy=new AntigravityAgent(()=> 'legacy');
  assert.equal(legacy.switchSupport(),undefined);
  assert.equal(legacy.identity().email,'test@example.test');
  assert.equal(legacy.management().canSaveCurrent,true);
  const nested={token:{refresh_token:'fixture-refresh'},id_token:JSON.parse(credentials).id_token};
  assert.deepEqual(legacy.identityFromAuth(nested),{id:'test-person',email:'test@example.test'});
});
test('Claude official status separates signed-out, subscription and non-subscription authentication',()=>{
  assert.equal(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}').state,'signed-out');
  const status=parseClaudeAuthStatus(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'claude@example.test',subscriptionType:'pro',accessToken:'must-not-return',configDirectory:'/private/path'}));
  assert.equal(status.account,'claude@example.test');assert.equal(status.plan,'pro');
  assert.equal(status.accessToken,undefined);assert.equal(status.configDirectory,undefined);
  assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key","subscriptionType":"pro"}').plan,undefined);
  assert.throws(()=>parseClaudeAuthStatus('{}'));
  assert.throws(()=>parseClaudeAuthStatus('not json'));
});
test('Claude saved file metadata does not invent quota or price tiers',()=>{
  const dir=path.join(root,'claude-backup');
  atomicWrite(path.join(dir,'.credentials.json'),JSON.stringify({email:'file@example.test',claudeAiOauth:{refreshToken:'fake-refresh',subscriptionType:'max'}}));
  const snapshot=new ClaudeAgent().credentialStatus(dir);
  assert.equal(snapshot.plan,'max');assert.equal(snapshot.state,'unverified');assert.equal(snapshot.quota,undefined);
  for(const agent of ['claude','agy'])assert.deepEqual(policy.planInfo({plan:'pro'},agent),{key:'pro',label:'Pro',tier:''});
  assert.deepEqual(policy.planInfo({plan:'max'},'claude'),{key:'max',label:'Max',tier:''});
  assert.equal(policy.planInfo({plan:'pro'},'codex').tier,'200');
});
test('provider inspection never spreads file tokens or overwrites profile history',async()=>{
  const agent=new AntigravityAgent(()=> 'unified', false);
  const dir=store.profileDir('agy','backup');
  store.writeProfileMeta('agy','backup',{email:'test@example.test',savedAt:'2026-01-01',snapshot:{available:true,state:'ok',plan:'old'}});
  const before=readCredentialFile(path.join(dir,'_meta.json'),'utf8');
  const status=await accounts.refreshAccount(agent,'backup',true);
  assert.equal(status.state,'unverified');
  assert.equal(readCredentialFile(path.join(dir,'_meta.json'),'utf8'),before);
  assert.equal(readCredentialFile(path.join(dir,agent.authFiles[0]),'utf8'),credentials);
});
