const {test,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ags-auth-lifecycle-'));
os.homedir=()=>root;
const { readCredentialFile } = require('./vault-fixture.cjs');
const clients=require('../dist/clients');clients.runningClients=async()=>[];
const store=require('../dist/store'),accounts=require('../dist/accounts');
const {codexAgent:agent,CodexAgent,CodexQueryError,codexAuthFailure}=require('../dist/agents/codex');
const {credentialState,CredentialChangedError}=require('../dist/credential-state');
const {atomicWrite}=require('../dist/utils');
Object.defineProperty(agent,'homeDir',{value:path.join(root,'live')});
const auth=(user,version=1,dated=true)=>JSON.stringify({auth_mode:'chatgpt',...(dated?{last_refresh:`2026-11-0${version}T00:00:00Z`}:{}),tokens:{account_id:'workspace-'+user,access_token:'access-'+user+'-'+version,refresh_token:'refresh-'+user+'-'+version,id_token:'h.'+Buffer.from(JSON.stringify({sub:user,email:user+'@example.test'})).toString('base64url')+'.s'}});
const dir=name=>store.profileDir('codex',name),file=d=>path.join(d,'auth.json');
const put=(d,user,v,dated)=>atomicWrite(file(d),auth(user,v,dated));
const version=d=>JSON.parse(readCredentialFile(file(d))).tokens.refresh_token;
const success=()=>({account:{type:'chatgpt',planType:'plus'},rates:{rateLimits:{primary:{usedPercent:30,windowDurationMins:300}}}});
beforeEach(()=>{fs.rmSync(store.STORE_DIR,{recursive:true,force:true});fs.rmSync(agent.homeDir,{recursive:true,force:true});agent.queryLiveRpc=async()=>success();});
after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('changed credentials invalidate expired cache, including dashboard and automatic deadline',async()=>{
 put(agent.homeDir,'outside');put(dir('A'),'A');
 agent.queryLiveRpc=async()=>{throw new CodexQueryError('凭据失效','refresh-revoked');};
 await accounts.refreshAccount(agent,'A',true);
 const old=store.readProfileMeta('codex','A').snapshot;
 put(dir('A'),'A',2);
 const displayed=accounts.dashboard()[0].profiles.find(p=>p.name==='A');
 assert.equal(displayed.meta.snapshot.state,'unverified');assert.equal(displayed.meta.snapshot.authExpired,false);assert.ok(displayed.refreshAt<=Date.now());
 let queries=0;agent.queryLiveRpc=async()=>{queries++;return success();};
 assert.equal((await accounts.refreshAccount(agent,'A')).state,'ok');assert.equal(queries,1);
 assert.notEqual(store.readProfileMeta('codex','A').snapshot.credentialRevision,old.credentialRevision);
});

test('external same-account login clears live expired state without losing quota history',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 put(agent.homeDir,'B');await accounts.saveAccount(agent,'B');await accounts.refreshAccount(agent,'B',true);
 t.mock.timers.tick(30000);
 agent.queryLiveRpc=async()=>{throw new CodexQueryError('凭据失效','refresh-revoked');};await accounts.refreshAccount(agent,'B',true);
 put(agent.homeDir,'B',2);
 const displayed=accounts.dashboard()[0].status;
 assert.equal(displayed.authExpired,false);assert.equal(displayed.state,'unverified');assert.equal(displayed.quota.primaryWindow.usedPercent,30);
 agent.queryLiveRpc=async()=>success();assert.equal((await accounts.refreshAccount(agent,'B')).state,'ok');
 assert.equal(version(dir('B')),'refresh-B-2');
});

test('late failure from an old generation is discarded and retries the new credential once',async()=>{
 put(agent.homeDir,'outside');put(dir('C'),'C');let queries=0;
 agent.queryLiveRpc=async temp=>{queries++;if(queries===1){put(dir('C'),'C',2);throw new CodexQueryError('凭据失效','refresh-revoked');}assert.equal(version(temp),'refresh-C-2');return success();};
 assert.equal((await accounts.refreshAccount(agent,'C',true)).state,'ok');assert.equal(queries,2);assert.equal(store.readProfileMeta('codex','C').snapshot.authExpired,false);
});

test('late success and rotated tokens cannot overwrite a new login; retry is bounded',async()=>{
 put(agent.homeDir,'outside');put(dir('D'),'D');let queries=0;
 agent.queryLiveRpc=async temp=>{queries++;put(temp,'D',8);put(dir('D'),'D',queries+1);return success();};
 await assert.rejects(accounts.refreshAccount(agent,'D',true),CredentialChangedError);
 assert.equal(queries,2);assert.equal(version(dir('D')),'refresh-D-3');assert.equal(store.readProfileMeta('codex','D').snapshot,undefined);
});

test('changing to a different account during lookup never queries or caches the new account',async()=>{
 put(agent.homeDir,'E');let queries=0;
 agent.queryLiveRpc=async()=>{queries++;put(agent.homeDir,'F');return success();};
 await assert.rejects(accounts.refreshAccount(agent,undefined,true),CredentialChangedError);
 assert.equal(queries,1);assert.equal(accounts.dashboard()[0].status.state,'unverified');
});

test('a CLI response that changed workspace cannot be attached to the original account',async()=>{
 put(agent.homeDir,'outside');put(dir('workspace-source'),'workspace-source');
 agent.queryLiveRpc=async temp=>{put(temp,'unexpected-workspace');return success();};
 await assert.rejects(accounts.refreshAccount(agent,'workspace-source',true),CredentialChangedError);
 assert.equal(version(dir('workspace-source')),'refresh-workspace-source-1');assert.equal(store.readProfileMeta('codex','workspace-source').snapshot,undefined);
});

test('switching away preserves a newer saved token and same-account selection can apply it',async()=>{
 put(agent.homeDir,'G');put(dir('G'),'G',2);put(dir('H'),'H');
 await accounts.useAccount(agent,'H', { saveUnmanaged: true });assert.equal(version(dir('G')),'refresh-G-2');
 put(agent.homeDir,'G');await accounts.useAccount(agent,'G', { saveUnmanaged: true });assert.equal(version(agent.homeDir),'refresh-G-2');
});

test('unknown generation order cancels switching before changing either credential',async()=>{
 put(agent.homeDir,'I',1,false);put(dir('I'),'I',2,false);put(dir('J'),'J');
 await assert.rejects(accounts.useAccount(agent,'J', { saveUnmanaged: true }),/无法确认新旧/);
 assert.equal(version(agent.homeDir),'refresh-I-1');assert.equal(version(dir('I')),'refresh-I-2');
});

test('external login during the outgoing save cancels switching without replacing the new session',async()=>{
 put(agent.homeDir,'switch-A',2);put(dir('switch-A'),'switch-A',1);put(dir('switch-B'),'switch-B');
 const save=agent.save;
 agent.save=async function(name,source){const result=await save.call(this,name,source);put(agent.homeDir,'switch-C');return result;};
 try{await assert.rejects(accounts.useAccount(agent,'switch-B', { saveUnmanaged: true }),CredentialChangedError);}finally{agent.save=save;}
 assert.equal(version(agent.homeDir),'refresh-switch-C-1');assert.equal(version(dir('switch-B')),'refresh-switch-B-1');
});

test('switch rollback never overwrites a login that arrived after applying the target',async()=>{
 put(agent.homeDir,'rollback-A');put(dir('rollback-A'),'rollback-A');put(dir('rollback-B'),'rollback-B');
 const use=agent.use;
 agent.use=async function(name){const result=await use.call(this,name);put(agent.homeDir,'rollback-C');return result;};
 try{await assert.rejects(accounts.useAccount(agent,'rollback-B', { saveUnmanaged: true }),CredentialChangedError);}finally{agent.use=use;}
 assert.equal(version(agent.homeDir),'refresh-rollback-C-1');
});

test('email-only metadata cannot participate in current-account detection or synchronization',async()=>{
 put(agent.homeDir,'K');store.writeProfileMeta('codex','damaged',{email:'K@example.test'});put(dir('L'),'L');
 assert.equal(accounts.activeProfile(agent),undefined);await accounts.useAccount(agent,'L', { saveUnmanaged: true });
 assert.equal(fs.existsSync(file(dir('damaged'))),false);
});

test('successful rotation syncs the original generation but cannot roll back a newer alias',async()=>{
 put(agent.homeDir,'outside');put(dir('M'),'M');put(dir('M-copy'),'M');put(dir('M-newer'),'M',4);
 agent.queryLiveRpc=async temp=>{put(temp,'M',2);return success();};
 const result=await accounts.refreshAccount(agent,'M',true);
 assert.equal(version(dir('M')),'refresh-M-2');assert.equal(version(dir('M-copy')),'refresh-M-2');assert.equal(version(dir('M-newer')),'refresh-M-4');
 assert.equal(result.credentialRevision,credentialState(agent,dir('M')).revision);
});

test('cached credentials cannot start renewal after the system key becomes unavailable', async () => {
 const {setCredentialKeyProvider}=require('../dist/credential-vault');
 let unlocked=true,queries=0;
 const restore=setCredentialKeyProvider({read:()=>unlocked?Buffer.alloc(32,7):null,create:()=>assert.fail('must not replace a missing key')});
 try {
  put(agent.homeDir,'outside');put(dir('locked'),'locked');
  assert.equal(version(dir('locked')),'refresh-locked-1');
  unlocked=false;
  agent.queryLiveRpc=async()=>{queries++;return success();};
  await assert.rejects(accounts.refreshAccount(agent,'locked',true),/密钥不存在/);
  assert.equal(queries,0);assert.equal(version(dir('locked')),'refresh-locked-1');
 } finally {restore();}
});

test('a key lost during renewal retains the rotated token for recovery and startup never reaps it', async () => {
 const {setCredentialKeyProvider}=require('../dist/credential-vault');
 const {reapTemporaryCredentials,releaseTemporaryCredentials}=require('../dist/temporary-credentials');
 let unlocked=true,temporary;
 const restore=setCredentialKeyProvider({read:()=>unlocked?Buffer.alloc(32,7):null,create:()=>assert.fail('must not replace a missing key')});
 try {
  put(agent.homeDir,'outside');put(dir('lost-mid-query'),'lost-mid-query');
  agent.queryLiveRpc=async temp=>{temporary=temp;put(temp,'lost-mid-query',2);unlocked=false;return success();};
  await assert.rejects(accounts.refreshAccount(agent,'lost-mid-query',true),error=>
   /密钥不存在/.test(error.message)&&error.message.includes(temporary));
  assert.equal(version(dir('lost-mid-query')),'refresh-lost-mid-query-1');
  assert.equal(version(temporary),'refresh-lost-mid-query-2');
  const marker=path.join(temporary,'.ags-temporary-owner.json');
  const owner=JSON.parse(fs.readFileSync(marker,'utf8'));owner.pid=2147483647;
  fs.writeFileSync(marker,JSON.stringify(owner));
  assert.ok(reapTemporaryCredentials().retained.includes(temporary));
  assert.equal(version(temporary),'refresh-lost-mid-query-2');
 } finally {unlocked=true;if(temporary)releaseTemporaryCredentials(temporary);restore();}
});

test('format-only edits do not invalidate a credential cache and legacy failures get one recheck',async()=>{
 put(agent.homeDir,'outside');put(dir('N'),'N');await accounts.refreshAccount(agent,'N',true);
 atomicWrite(file(dir('N')),JSON.stringify(JSON.parse(readCredentialFile(file(dir('N')))),null,4));
 let queries=0;agent.queryLiveRpc=async()=>{queries++;return success();};await accounts.refreshAccount(agent,'N');assert.equal(queries,0);
 store.writeProfileMeta('codex','N',{snapshot:{available:true,state:'expired',authExpired:true}});
 await accounts.refreshAccount(agent,'N');assert.equal(queries,1);
});

test('credential replacement preview is invalidated by another same-account replacement',async()=>{
 put(dir('O'),'O');agent.queryLiveRpc=async()=>{throw new CodexQueryError('凭据失效','refresh-revoked');};await accounts.refreshAccount(agent,'O',true);
 const target=accounts.credentialUpdateTarget(agent,'O');put(dir('O'),'O',2);put(path.join(root,'replacement'),'O',3);
 await assert.rejects(accounts.updateAccountCredentials(target,path.join(root,'replacement')),/变化/);assert.equal(version(dir('O')),'refresh-O-2');
});

test('a workspace ID without a member identity does not merge different people',()=>{
 for(const [name,token] of [['P','one'],['Q','two']])atomicWrite(file(dir(name)),JSON.stringify({tokens:{account_id:'shared-workspace',access_token:'access',refresh_token:token}}));
 assert.notEqual(agent.identity(dir('P')).id,agent.identity(dir('Q')).id);
});

test('only explicit refresh rejection means expired; a bare 401 keeps a retryable error',async()=>{
 put(dir('R'),'R');
 for(const error of [{status:401},{message:'not authenticated'},{message:'access_token expired'}]){
  const reason=codexAuthFailure(error);agent.queryLiveRpc=async()=>{throw new CodexQueryError('认证请求未通过',reason);};
  const status=await agent.status(dir('R'));assert.equal(status.state,'error');assert.equal(status.authExpired,false);
 }
 agent.queryLiveRpc=async()=>{throw new CodexQueryError('凭据失效',codexAuthFailure({data:{error:'refresh_token_reused'}}));};
 const status=await agent.status(dir('R'));assert.equal(status.state,'expired');assert.equal(status.authFailure,'refresh-reused');
});

test('RPC null account is retryable; graceful exit preserves tokens written after its response',async()=>{
 const rpcAgent=new CodexAgent();const source=path.join(root,'rpc-source');put(source,'S');
 const bin=path.join(root,'fixture-codex');rpcAgent.findCodexBinary=()=>bin;
 function writeCli(body){fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs'),path=require('path'),rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize' && m.params.clientInfo.version!==${JSON.stringify(require('../package.json').version)})process.exit(1);${body}});`,{mode:0o700});}
 writeCli(`if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1||m.id===3)console.log(JSON.stringify({id:m.id,result:{account:null}}));`);
 const absent=await rpcAgent.status(source);assert.equal(absent.state,'error');assert.equal(absent.authFailure,'account-unavailable');
 writeCli(`if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1)process.stderr.write('ERROR Failed to refresh token: refresh_token_invalidated [private fixture]\\n');if(m.id===1||m.id===3)setTimeout(()=>console.log(JSON.stringify({id:m.id,result:{account:null}})),25);`);
 const rejected=await rpcAgent.status(source);assert.equal(rejected.state,'expired');assert.equal(rejected.authFailure,'refresh-revoked');assert.ok(!JSON.stringify(rejected).includes('private fixture'));
 const rotated=auth('S',2);
 writeCli(`if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1)console.log(JSON.stringify({id:1,result:{account:{type:'chatgpt'}}}));if(m.id===2){console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:20}}}}));process.stdin.on('end',()=>setTimeout(()=>{fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(rotated)});},120));}`);
 const status=await rpcAgent.status(source);assert.equal(status.state,'ok');assert.equal(version(source),'refresh-S-2');
});

test('RPC refreshes once after a missing login or access-token rejection and preserves the new token',async()=>{
 for(const trigger of ['missing','rejected']){
  const rpcAgent=new CodexAgent(),source=path.join(root,'rpc-recovery-'+trigger);put(source,'recover-'+trigger);
  const bin=path.join(root,'fixture-recovery-'+trigger);rpcAgent.findCodexBinary=()=>bin;
  const newAuth=auth('recover-'+trigger,2);
  fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs'),path=require('path');let refreshes=0;require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1)console.log(JSON.stringify(${trigger==='missing'?"{id:1,result:{account:null}}":"{id:1,error:{status:401,message:'unauthenticated'}}"}));if(m.id===3){if(++refreshes>1||m.params.refreshToken!==true)process.exit(2);fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(newAuth)});console.log(JSON.stringify({id:3,result:{account:{type:'chatgpt'}}}));}if(m.id===2)console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:10}}}}));});`,{mode:0o700});
  assert.equal((await rpcAgent.status(source)).state,'ok');assert.equal(version(source),'refresh-recover-'+trigger+'-2');
 }
});

test('OAuth client provenance and login ownership participate in credential revision',()=>{
 const {credentialStateFromFiles}=require('../dist/credential-state');
 const parsed=JSON.parse(auth('metadata'));
 const revision=value=>credentialStateFromFiles('codex',[['auth.json',Buffer.from(JSON.stringify(value))]]).revision;
 const original=revision(parsed);
 parsed.tokens.oauth_provenance={issuer:'https://auth.openai.com',client_id:'first-client'};
 const first=revision(parsed);assert.notEqual(first,original);
 parsed.tokens.oauth_provenance.client_id='another-client';assert.notEqual(revision(parsed),first);
 const second=revision(parsed);parsed.tokens.login_owner_id='other-login';assert.notEqual(revision(parsed),second);
});
