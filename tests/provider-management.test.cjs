const { createTestHome, readCredentialFile, jwt } = require('./helpers/test-env.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root = createTestHome('ags-provider-test-');
const {atomicWrite}=require('../dist/utils');
const {AntigravityAgent,detectAntigravityRuntime}=require('../dist/agents/antigravity');
const accounts=require('../dist/accounts');
const store=require('../dist/store');
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
const credentials=JSON.stringify({refresh_token:'fake-refresh',access_token:'fake-access',id_token:jwt({sub:'test-person',email:'test@example.test'})});

test('unified Antigravity ignores leftover legacy tokens while retaining imported backups',async()=>{
  const agent=new AntigravityAgent(()=> 'unified', false);
  atomicWrite(path.join(agent.homeDir,agent.authFiles[0]),credentials);
  atomicWrite(path.join(store.profileDir('agy','backup'),agent.authFiles[0]),credentials);
  assert.equal(agent.identity(),undefined);
  assert.equal(agent.identity(store.profileDir('agy','backup')).email,'test@example.test');
  assert.equal(agent.credentialStatus().available,false);
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
