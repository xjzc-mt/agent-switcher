const { createTestHome, readCredentialFile, jwt } = require('./helpers/test-env.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root = createTestHome('ags-provider-test-');
const {atomicWrite}=require('../dist/utils');
const {AntigravityAgent,detectAntigravityRuntime}=require('../dist/agents/antigravity');
const accounts=require('../dist/accounts');
const store=require('../dist/store');
test('macOS desktop generation enables local management before the optional CLI', {skip:process.platform!=='darwin'}, t => {
  const cli = require('../dist/antigravity-cli');
  t.mock.method(cli, 'resolveAntigravityCli', () => undefined);
  const agent = new AntigravityAgent(detectAntigravityRuntime, undefined, () => ({ state: 'missing' }));
  const contents=path.join(root,'Applications/Antigravity.app/Contents');
  fs.mkdirSync(contents,{recursive:true});
  try {
    for(const [version,expected] of [['1.9','legacy'],['2.3','unified']]) {
      const binary=require('node:child_process').execFileSync('/usr/bin/plutil',['-convert','binary1','-o','-','-'],{
        input:`<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
      });
      fs.writeFileSync(path.join(contents,'Info.plist'),binary);
      agent.recheckCapabilities();
      assert.equal(detectAntigravityRuntime(),expected);
      assert.equal(agent.management().storage,expected==='legacy'?'file':'keychain');
      assert.equal(agent.management().canSaveCurrent,true);
      assert.equal(agent.management().quota,false);
    }
  } finally {fs.rmSync(path.join(root,'Applications'),{recursive:true,force:true});}
});
test('Windows can identify unified credentials without loading a blob or assuming a legacy desktop file is unified', t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  let desktopVersion;
  t.mock.method(require('../dist/windows-desktop'), 'windowsAntigravityVersion', () => desktopVersion);
  t.mock.method(require('../dist/antigravity-cli'), 'resolveAntigravityCli', () => undefined);
  const win = require('../dist/antigravity-windows');
  let present = true;
  t.mock.method(win, 'hasWindowsAntigravityCredential', () => present);
  t.mock.method(win, 'readWindowsCredential', () => assert.fail('runtime probe read a credential blob'));
  assert.equal(detectAntigravityRuntime(), 'unified');
  present = false;
  const desktop = path.join(root, '.gemini', 'jetski-standalone-oauth-token');
  fs.mkdirSync(path.dirname(desktop), {recursive: true});
  fs.writeFileSync(desktop, JSON.stringify({ refresh_token: 'old-file' }));
  assert.equal(detectAntigravityRuntime(), 'unknown');
  fs.writeFileSync(desktop, JSON.stringify({ auth_method: 'consumer', token: { refresh_token: 'fixture' } }));
  assert.equal(detectAntigravityRuntime(), 'unified');
  desktopVersion = '1.9.0';
  const legacy = new AntigravityAgent();
  assert.equal(legacy.identity(), undefined);
  assert.equal(legacy.credentialStatus().state, 'unsupported');
  fs.unlinkSync(desktop);
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
  const unsupported = { message: agent.switchSupport() };
  await assert.rejects(accounts.useAccount(agent,'backup', { saveUnmanaged: true }),unsupported);
  await assert.rejects(accounts.saveAccount(agent,'live'),unsupported);
  assert.equal(readCredentialFile(path.join(agent.homeDir,agent.authFiles[0]),'utf8'),credentials);
});
test('unrecognized Antigravity runtime cannot overwrite credentials; legacy adapter stays available',()=>{
  assert.ok(new AntigravityAgent(()=> 'unknown').switchSupport());
  const legacy=new AntigravityAgent(()=> 'legacy'), fileSwitching = process.platform !== 'win32';
  assert.equal(!legacy.switchSupport(),fileSwitching);
  assert.equal(legacy.identity()?.email,fileSwitching ? 'test@example.test' : undefined);
  assert.equal(legacy.management().canSaveCurrent,fileSwitching);
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
