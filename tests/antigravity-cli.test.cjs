const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-cli-test-'));
os.homedir = () => root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const cli = require('../dist/antigravity-cli');
const native = require('../dist/antigravity-native');
const { profileDir, writeProfileMeta, readProfileMeta } = require('../dist/store');
const { credentialState } = require('../dist/credential-state');
const { atomicWrite } = require('../dist/utils');
const token = (email, generation = 1) => Buffer.from(JSON.stringify({ auth_method:'consumer', id_token_email:email,
  token:{ access_token:`fixture-${generation}`, refresh_token:'fixture-refresh', expiry:new Date(1795000000000 + generation * 60000).toISOString() } }));
let live = token('a@example.test');
native.readNativeToken = () => live;
native.writeNativeToken = value => { live = value; };
const binary = path.join(root, '.local/bin/agy'), behaviorFile = path.join(root, 'behavior');
atomicWrite(binary, `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),cp=require('child_process');
const home=process.env.HOME,file=path.join(home,'.gemini/antigravity-cli/antigravity-oauth-token');
const realHome=path.resolve(__dirname,'../..'),mode=fs.readFileSync(path.join(realHome,'behavior'),'utf8');
// The sandbox must prevent access to the real login, even when HOME is isolated.
try { fs.readFileSync(path.join(realHome,'.gemini/probe'));process.exit(21); } catch {}
try { fs.writeFileSync(path.join(realHome,'outside'),'unexpected');process.exit(22); } catch {}
try { cp.execFileSync('/usr/bin/security',['help'],{stdio:'pipe'});process.exit(23); } catch {}
if(process.env.GEMINI_API_KEY||process.env.SSH_TTY)process.exit(24);
if(process.argv.includes('/usage')) {
 if(mode==='usage-error')process.exit(3);
 console.log(JSON.stringify({status:'SUCCESS',num_turns:0,command:{name:'usage',data:{groups:[{name:'Gemini Models',buckets:[{id:'g-5h',name:'Five hours',window:'5h',remaining_fraction:.8}]}]}}}));
 process.exit(0);
}
const rl=require('readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let poll;
rl.on('line',line=>{
 const msg=JSON.parse(line);
 if(msg.method==='initialize')send({id:msg.id,result:{protocolVersion:1}});
 if(msg.method!=='authenticate')return;
 if(mode==='invalid')return send({id:msg.id,error:{message:'invalid_grant'}});
 if(fs.existsSync(file)) {
  const auth=JSON.parse(fs.readFileSync(file));auth.token.access_token='fixture-rotated';auth.token.expiry='2027-01-01T00:00:00Z';
  fs.writeFileSync(file,JSON.stringify(auth));return send({id:msg.id,result:{_meta:{antigravity:{tier:{name:'Google AI Pro'}}}}});
 }
 cp.execFileSync('open',['https://accounts.google.com/o/oauth2/auth?state=fixture-state'],{env:process.env});
 poll=setInterval(()=>{
  const result=path.join(home,'browser-result');if(!fs.existsSync(result))return;
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(result,file);clearInterval(poll);
  send({id:msg.id,result:{}});
 },10);
});
rl.on('close',()=>clearInterval(poll));
`);
fs.chmodSync(binary, 0o700);
atomicWrite(path.join(root, '.gemini/probe'), 'current-login-must-not-be-read');
fs.writeFileSync(behaviorFile, 'normal');
// Runtime capabilities are captured when the shared agent is constructed.
// Install the fixture first so neither a missing nor an older host app selects the adapter.
const appPlist = path.join(root, 'Applications/Antigravity.app/Contents/Info.plist');
atomicWrite(appPlist, '<plist><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>');
const { antigravityAgent: agent } = require('../dist/agents/antigravity');
const { antigravityLogin: login } = require('../dist/antigravity-login');
const { refreshAccount, dashboard } = require('../dist/accounts');
afterEach(async () => { await login.cancel(); fs.writeFileSync(behaviorFile, 'normal'); });
after(() => fs.rmSync(root, { recursive:true, force:true }));
async function until(fn) {
  for (let i=0;i<300;i++) { const result=fn();if(result)return result;await new Promise(r=>setTimeout(r,10)); }
  throw new Error('Timed out');
}

test('isolated CLI renews the spare account without reading or writing live credentials', {skip:process.platform!=='darwin'}, async () => {
  const before=live, dir=profileDir('agy','B');atomicWrite(path.join(dir,agent.authFiles[0]),token('b@example.test'));
  const result=await refreshAccount(agent,'B',true);
  assert.equal(result.state,'ok');assert.equal(result.plan,'Google AI Pro');
  assert.equal(result.quota.buckets[0].windows[0].windowMins,300);
  assert.equal(JSON.parse(readCredentialFile(path.join(dir,agent.authFiles[0]))).token.access_token,'fixture-rotated');
  assert.deepEqual(live,before);assert.equal(fs.existsSync(path.join(root,'outside')),false);
  assert.equal(dashboard().find(a=>a.id==='agy').profiles.find(p=>p.name==='B').meta.snapshot.state,'ok');
  assert.equal(cli.isolatedCliPids.size,0);
});

test('direct native status commits rotation through Keychain even when usage fails', {skip:process.platform!=='darwin'}, async () => {
  const before = live;
  try {
    live = token('current@example.test');
    fs.writeFileSync(behaviorFile, 'usage-error');
    const result = await agent.status();
    assert.equal(result.state, 'error');
    assert.equal(JSON.parse(live).token.access_token, 'fixture-rotated');
    assert.equal(result.credentialRevision, credentialState(agent).revision);
    assert.equal(fs.existsSync(path.join(agent.homeDir, agent.authFiles[0])), false);
  } finally { live = before; }
});

test('rotation survives usage failure; stale completion never overwrites a newer account generation', {skip:process.platform!=='darwin'}, async () => {
  fs.writeFileSync(behaviorFile,'usage-error');
  const dir=profileDir('agy','retry'), original=token('retry@example.test');atomicWrite(path.join(dir,agent.authFiles[0]),original);
  const before=credentialState(agent,dir).revision, query=await agent.queryCredential(original);
  assert.equal(query.status.state,'error');assert.ok(query.rotated);
  atomicWrite(path.join(dir,agent.authFiles[0]),token('retry@example.test',3));
  assert.throws(()=>agent.commitQuery(dir,before,query),/凭据已更新/);
  const current=credentialState(agent,dir).revision;
  agent.commitQuery(dir,current,query);
  assert.deepEqual(readCredentialFile(path.join(dir,agent.authFiles[0])),query.rotated);
  fs.writeFileSync(behaviorFile,'invalid');
  const failed=await agent.queryCredential(original);assert.equal(failed.status.state,'expired');
  assert.equal(failed.rotated,undefined);
});

test('isolated official login can be canceled, saved, and used to update only the intended account', {skip:process.platform!=='darwin'}, async () => {
  const before=live;
  await login.useLink(url=>assert.equal(new URL(url).hostname,'accounts.google.com'));
  assert.equal(login.status().ready,false);await login.cancel();assert.deepEqual(live,before);
  let directory;
  // Capture the private directory without exposing it to the renderer.
  const originalStart=cli.startAcpLogin;
  cli.startAcpLogin=(dir,...args)=>{directory=dir;return originalStart(dir,...args);};
  try {
    await login.useLink(()=>{});
    atomicWrite(path.join(directory,'browser-result'),token('new@example.test'));
    const ready=await until(()=>{const value=login.status();return value.ready&&value;});
    await login.save('new',ready.attempt);
    assert.equal(agent.identity(profileDir('agy','new')).email,'new@example.test');
    assert.deepEqual(live,before);assert.equal(fs.existsSync(directory),false);
    const meta=readProfileMeta('agy','new');writeProfileMeta('agy','new',{...meta,snapshot:{available:true,state:'expired'}});
    await login.useLink(()=>{},undefined,'new');
    atomicWrite(path.join(directory,'browser-result'),token('wrong@example.test'));
    const wrong=await until(()=>{const value=login.status();return value.ready&&value;});
    assert.equal(wrong.matchesTarget,false);
    await assert.rejects(login.update('new',wrong.attempt),/不属于/);
    assert.equal(agent.identity(profileDir('agy','new')).email,'new@example.test');assert.deepEqual(live,before);
  } finally { cli.startAcpLogin=originalStart; }
});
