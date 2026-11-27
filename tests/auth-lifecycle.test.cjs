const { mockIdleClients, createTestHome, readCredentialFile, jwt, accessToken } = require('./helpers/test-env.cjs');
const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root = createTestHome('ags-auth-lifecycle-');
const clients = mockIdleClients();
const store=require('../dist/store'),accounts=require('../dist/accounts');
const {codexAgent:agent,CodexAgent,CodexQueryError,codexAuthFailure}=require('../dist/agents/codex');
const {credentialState,CredentialChangedError}=require('../dist/credential-state');
const {atomicWrite}=require('../dist/utils');
Object.defineProperty(agent,'homeDir',{value:path.join(root,'live')});
const auth=(user,version=1,dated=true)=>JSON.stringify({auth_mode:'chatgpt',...(dated?{last_refresh:`2026-11-0${version}T00:00:00Z`}:{}),tokens:{account_id:'workspace-'+user,access_token:accessToken('workspace-'+user,user,user+'@example.test',version),refresh_token:'refresh-'+user+'-'+version,id_token:jwt({sub:user,email:user+'@example.test'})}});
const dir=name=>store.profileDir('codex',name),file=d=>path.join(d,'auth.json');
const put=(d,user,v,dated)=>atomicWrite(file(d),auth(user,v,dated));
const version=d=>JSON.parse(readCredentialFile(file(d))).tokens.refresh_token;
const success=()=>({account:{type:'chatgpt',planType:'plus'},rates:{rateLimits:{primary:{usedPercent:30,windowDurationMins:300}}}});
beforeEach(()=>{fs.rmSync(store.STORE_DIR,{recursive:true,force:true});fs.rmSync(agent.homeDir,{recursive:true,force:true});agent.queryLiveRpc=async()=>success();});

test('an email conflict backs off on both the dashboard and backend until registration is corrected', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  put(agent.homeDir, 'registered-check');
  await accounts.saveAccount(agent, 'registered-check');
  const name = 'registered-check';
  let queries = 0;
  agent.queryLiveRpc = async () => { queries++; return success(); };
  const meta = () => store.readProfileMeta('codex', name);
  const view = () => accounts.dashboard()[0];
  await accounts.refreshAccount(agent, name, true);
  queries = 0;
  store.writeProfileMeta('codex', name, { ...meta(), email: 'other@example.test' });
  const first = await accounts.refreshAccount(agent, name);
  assert.equal(first.state, 'error');
  assert.equal(queries, 0);
  assert.equal(view().refreshAt, Date.now() + 120000);
  assert.equal(view().profiles.find(p => p.name === name).refreshAt, view().refreshAt);
  t.mock.timers.tick(2000);
  assert.equal((await accounts.refreshAccount(agent, name)).checkedAt, first.checkedAt);
  assert.equal(view().status.quota, undefined);
  assert.equal(first.account, 'other@example.test');
  assert.equal(first.quota, undefined);
  put(agent.homeDir, name, 2);
  assert.equal((await accounts.refreshAccount(agent, name)).state, 'error');
  assert.equal(queries, 0);
  assert.equal(version(dir(name)), 'refresh-registered-check-1');
  assert.equal(version(agent.homeDir), 'refresh-registered-check-2');
  store.writeProfileMeta('codex', name, { ...meta(), email: 'registered-check@example.test' });
  assert.ok(view().refreshAt <= Date.now());
  assert.equal((await accounts.refreshAccount(agent, name)).state, 'ok');
  assert.equal(queries, 1);
});

test('a damaged candidate stops automatic checks for that profile until the file is repaired', async () => {
  put(agent.homeDir, 'outside');
  put(dir('damaged-candidate'), 'staged-file');
  const candidate = file(dir('damaged-candidate')) + '.pending';
  fs.mkdirSync(candidate);
  store.writeProfileMeta('codex', 'damaged-candidate', { snapshot: { state:'ok', available:true, plan:'plus' } });
  const card = () => accounts.dashboard()[0].profiles.find(p => p.name === 'damaged-candidate');
  assert.equal(card().refreshAt, Infinity);
  assert.equal(card().meta.snapshot.plan, 'plus');
  let queries = 0;
  agent.queryLiveRpc = async () => { queries++; return success(); };
  await assert.rejects(async () => accounts.refreshAccount(agent, 'damaged-candidate', true), /普通文件/);
  assert.equal(queries, 0);
  fs.rmdirSync(candidate);
  assert.ok(card().refreshAt <= Date.now());
  assert.equal((await accounts.refreshAccount(agent, 'damaged-candidate')).state, 'ok');
  assert.equal(queries, 1);
});

test('a newer current generation committed by another process supplies the dashboard deadline', async () => {
  const name = 'external-commit', card = () => accounts.dashboard()[0];
  put(agent.homeDir, name);
  await accounts.saveAccount(agent, name);
  const older = await accounts.refreshAccount(agent, name, true);
  put(agent.homeDir, name, 2);
  const script = `
    require('node:os').homedir = () => process.argv[1];
    require('./tests/helpers/test-env.cjs').installMockKeychain();
    const {codexAgent} = require('./dist/agents/codex');
    Object.defineProperty(codexAgent, 'homeDir', {value: require('node:path').join(process.argv[1], 'live')});
    codexAgent.queryLiveRpc = async () => ({rates:{rateLimits:{primary:{usedPercent:7}}}});
    require('./dist/accounts').refreshAccount(codexAgent, process.argv[2], true)
      .then(result => process.stdout.write(JSON.stringify(result))).catch(() => {process.exitCode=1;});
  `;
  const output = require('node:child_process').execFileSync(process.execPath, ['-e', script, root, name], {encoding:'utf8'});
  const fresh = JSON.parse(output);
  assert.notEqual(fresh.credentialRevision, older.credentialRevision);
  assert.equal(card().status.quota.primaryWindow.usedPercent, 7);
  assert.equal(card().status.checkedAt, fresh.checkedAt);
  assert.ok(card().refreshAt > Date.now());
});

test('external same-account login clears live expired state without losing quota history',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 put(agent.homeDir,'B');await accounts.saveAccount(agent,'B');await accounts.refreshAccount(agent,'B',true);
 t.mock.timers.tick(30000);
 agent.queryLiveRpc=async()=>{throw new CodexQueryError('凭据失效','refresh-revoked');};await accounts.refreshAccount(agent,'B',true);
 put(agent.homeDir,'B',2);
 const view=accounts.dashboard()[0], displayed=view.status;
 assert.ok(view.refreshAt<=Date.now());
 assert.equal(displayed.authExpired,false);assert.equal(displayed.state,'unverified');assert.equal(displayed.quota.primaryWindow.usedPercent,30);
 agent.queryLiveRpc=async()=>success();assert.equal((await accounts.refreshAccount(agent,'B')).state,'ok');
 assert.equal(version(dir('B')),'refresh-B-2');
});

test('late failure from an old generation is discarded and retries the new credential once',async()=>{
 put(agent.homeDir,'outside');put(dir('C'),'C');let queries=0;
 agent.queryLiveRpc=async temp=>{queries++;if(queries===1){put(dir('C'),'C',2);throw new CodexQueryError('凭据失效','refresh-revoked');}assert.equal(version(temp),'refresh-C-2');return success();};
 assert.equal((await accounts.refreshAccount(agent,'C',true)).state,'ok');assert.equal(queries,2);assert.equal(store.readProfileMeta('codex','C').snapshot.authExpired,false);
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
 const result=await accounts.refreshAccount(agent,'workspace-source',true);
 assert.equal(result.refreshConsumed,true);assert.equal(result.quota,undefined);
 assert.equal(version(dir('workspace-source')),'refresh-workspace-source-1');
 assert.equal(store.readProfileMeta('codex','workspace-source').snapshot.state,'expired');
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

test('only explicit refresh rejection means expired; a bare 401 keeps a retryable error',async t=>{
  for(const [error, reason] of [
    [{message:'Your refresh token has been revoked. Please log in again.'}, 'refresh-revoked'],
    [{message:'Your refresh token has expired.'}, 'refresh-expired'],
    [{data:{error:'invalid_grant'}}, 'refresh-invalid'],
    [{message:'Failed to refresh token: connection timed out'}, undefined],
    [{message:'Request 4012 failed'}, undefined],
  ]) assert.equal(codexAuthFailure(error), reason, JSON.stringify(error));
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 put(dir('R'),'R');
 agent.queryLiveRpc=async()=>{throw new CodexQueryError('认证请求未通过',codexAuthFailure({data:{statusCode:401}}));};
 const retry=await accounts.refreshAccount(agent,'R',true);assert.equal(retry.state,'error');assert.equal(retry.authExpired,false);
 agent.queryLiveRpc=async()=>{throw new CodexQueryError('凭据失效',codexAuthFailure({message:'Unauthorized',data:{error:{code:'refresh_token_reused'}}}));};
 t.mock.timers.tick(31000);
 const status=await accounts.refreshAccount(agent,'R',true);assert.equal(status.state,'expired');assert.equal(status.authFailure,'refresh-reused');
});

test('RPC null account is retryable; graceful exit preserves tokens written after its response',async()=>{
 const rpcAgent=new CodexAgent();
 const refresh=profile=>{put(dir(profile),'S');return accounts.refreshAccount(rpcAgent,profile,true);};
 const bin=path.join(root,'fixture-codex');rpcAgent.findCodexBinary=()=>bin;
 function writeCli(body){fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs'),path=require('path'),rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize' && m.params.clientInfo.version!==${JSON.stringify(require('../package.json').version)})process.exit(1);${body}});`,{mode:0o700});}
 writeCli(`if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1||m.id===3)console.log(JSON.stringify({id:m.id,result:{account:null}}));`);
 const absent=await refresh('not-signed-in');assert.equal(absent.state,'error');assert.equal(absent.authFailure,'account-unavailable');
 writeCli(`if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1)process.stderr.write('ERROR Failed to refresh token: refresh_token_invalidated [private fixture]\\n');if(m.id===1||m.id===3)setTimeout(()=>console.log(JSON.stringify({id:m.id,result:{account:null}})),25);`);
 const rejected=await refresh('revoked');assert.equal(rejected.state,'expired');assert.equal(rejected.authFailure,'refresh-revoked');assert.ok(!JSON.stringify(rejected).includes('private fixture'));
 const rotated=auth('S',2);
 writeCli(`if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1)console.log(JSON.stringify({id:1,result:{account:{type:'chatgpt'}}}));if(m.id===2){console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:20}}}}));process.stdin.on('end',()=>setTimeout(()=>{fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(rotated)});},120));}`);
 const status=await refresh('rotated');assert.equal(status.state,'ok');assert.equal(version(dir('rotated')),'refresh-S-2');
});

test('a rejected fresh bearer upgrades once in a new RPC home; an expiring bearer can renew immediately', async t => {
 for (const [trigger, seconds] of [['missing',3600], ['rejected',3600], ['official-refresh-error',3600], ['expiring',45]]) {
  const rpcAgent = new CodexAgent(), user = 'recover-'+trigger, source = dir(user);
  const tokens = JSON.parse(auth(user)).tokens;
  tokens.access_token = accessToken(tokens.account_id, user, user+'@example.test', 1, Math.floor(Date.now()/1000)+seconds);
  atomicWrite(file(source), JSON.stringify({tokens}));
  const calls = [];
  let renewals = 0;
  rpcAgent.findCodexBinary = () => 'fixture';
  const transport = t.mock.method(require('../dist/codex-process'), 'startCodexProcess', (_bin, home, handlers) => {
    const owner = JSON.parse(fs.readFileSync(path.join(home,'.ags-temporary-owner.json')));
    const grant = JSON.parse(fs.readFileSync(file(home))).tokens.refresh_token;
    calls.push([grant,!!owner.pendingCommit,!!owner.inputDigest]);
    return { send({id,params}) {
      if (id === undefined) return;
      let response = { result:{} };
      if (id === 1) response = trigger === 'missing' ? { result:{account:null} } : { error:trigger === 'official-refresh-error'
        ? { code:-32603, message:'Your access token could not be refreshed. Please log out and sign in again.' } : { data:{code:'token_revoked'} } };
      if (id === 3) {
        renewals++;
        assert.equal(grant,tokens.refresh_token); assert.equal(params.refreshToken,true);
        fs.writeFileSync(file(home),auth(user,2)); response = { result:{account:{type:'chatgpt'}} };
      }
      if (id === 2) response = { result:{rateLimits:{primary:{usedPercent:10}}} };
      queueMicrotask(() => handlers.onMessage({ id,...response }));
    }, stop() { queueMicrotask(handlers.onClose); } };
  });
  const status = await accounts.refreshAccount(rpcAgent,user,true);
  transport.mock.restore();
  assert.equal(renewals,1,trigger);
  assert.equal(status.state,'ok'); assert.equal(status.quota.primaryWindow.usedPercent,10);
  assert.equal(version(source),'refresh-'+user+'-2');
  const rotation = [tokens.refresh_token,true,true];
  assert.deepEqual(calls, seconds>60 ? [['ags-refresh-disabled',false,false],rotation] : [rotation]);
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

test('malformed JWT payloads cannot provide account identity', () => {
  const { jwtInfo } = require('../dist/utils');

  assert.deepEqual(jwtInfo(jwt(null)), {});
  assert.deepEqual(jwtInfo(jwt({ email: {}, sub: 'member', exp: 123 })), { sub: 'member', exp: 123 });
});

test('live refresh avoids forcing refreshToken rotation while desktop client is running', async () => {
  const rpcAgent = new CodexAgent();
  const liveHome = path.join(root, 'live-running');
  Object.defineProperty(rpcAgent, 'homeDir', { value: liveHome });
  put(liveHome, 'running-user');
  const bin = path.join(root, 'fixture-no-rotate');
  rpcAgent.findCodexBinary = () => bin;
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===0)console.log(JSON.stringify({id:0,result:{}}));if(m.id===1)console.log(JSON.stringify({id:1,error:{status:401,message:'unauthenticated'}}));if(m.id===3)process.exit(99);});`, { mode: 0o700 });
  const prev = clients.runningClients;
  clients.runningClients = async () => ['Codex'];
  try {
    const result = await accounts.refreshAccount(rpcAgent, undefined, true);
    assert.equal(result.state, 'error');
    assert.equal(result.authExpired, false);
    assert.match(result.extra, /客户端正在运行/);
  } finally { clients.runningClients = prev; }
});

test('a busy Codex client owns live renewal while a spare account can still rotate', async t => {
  const name = 'running-user';
  function officialLogin(generation, secondsLeft) {
    const payload = JSON.parse(auth(name, generation));
    const expires = Math.floor(Date.now() / 1000) + secondsLeft;
    payload.tokens.access_token = accessToken('workspace-' + name, name, name + '@example.test', generation, expires);
    atomicWrite(file(agent.homeDir), JSON.stringify(payload));
  }
  officialLogin(1, -60);
  await accounts.saveAccount(agent, 'live-card');
  const running = t.mock.method(clients, 'runningClients', async () => { throw new Error('ps failed'); });
  const rpc = t.mock.method(agent, 'queryLiveRpc');
  const writeReady = t.mock.method(require('../dist/credential-vault'), 'assertCredentialWriteReady');
  const deferred = await accounts.refreshAccount(agent, 'live-card', true);
  assert.equal(rpc.mock.callCount(), 0);
  assert.match(deferred.extra, /客户端正在运行/);
  assert.equal(version(agent.homeDir), 'refresh-running-user-1');

  officialLogin(2, 3600);
  running.mock.mockImplementation(async () => ['Codex']);
  rpc.mock.mockImplementation(async (temp, allowRefresh) => {
    assert.equal(allowRefresh, false);
    assert.equal(version(temp), 'ags-refresh-disabled');
    assert.throws(() => fs.writeFileSync(file(temp), '{}'));
    return success();
  });
  assert.equal((await accounts.refreshAccount(agent, 'live-card', true)).state, 'ok');
  assert.equal(version(dir('live-card')), 'refresh-running-user-2');
  assert.equal(version(agent.homeDir), 'refresh-running-user-2');
  assert.equal(writeReady.mock.callCount(), 0);

  put(dir('spare-card'), 'spare-user');
  rpc.mock.mockImplementation(async temp => {
    assert.deepEqual(writeReady.mock.calls.map(call => call.arguments[0]), [file(dir('spare-card'))]);
    put(temp, 'spare-user', 2);
    return success();
  });
  assert.equal((await accounts.refreshAccount(agent, 'spare-card', true)).state, 'ok');
  assert.equal(version(dir('spare-card')), 'refresh-spare-user-2');
});

test('active Codex account upgrading from email to sub syncs pool card & same-version alias, keeps active status, and preserves other workspaces/generations', async () => {
  const emailOnly = (ws, rt, lastRefresh = '2026-11-01T00:00:00Z') => JSON.stringify({
    last_refresh: lastRefresh,
    tokens: { account_id: ws, email: 'Upgrade@Example.test', access_token: 'opaque-' + rt, refresh_token: rt },
  });
  atomicWrite(file(agent.homeDir), emailOnly('ws-main', 'rt-old'));
  assert.equal(agent.identity().id, 'ws-main:upgrade@example.test');
  await accounts.saveAccount(agent, 'active-card');
  // Same generation alias, changed generation copy, and different workspace with same email:
  atomicWrite(file(dir('same-gen-alias')), emailOnly('ws-main', 'rt-old'));
  atomicWrite(file(dir('changed-copy')), emailOnly('ws-main', 'rt-other-gen', '2026-11-09T00:00:00Z'));
  atomicWrite(file(dir('other-workspace')), emailOnly('ws-other', 'rt-other-ws'));
  put(dir('switch-away'), 'switch-away', 1);

  assert.equal(accounts.activeProfile(agent), 'active-card');
  agent.queryLiveRpc = async temp => {
    atomicWrite(file(temp), JSON.stringify({
      last_refresh: '2026-11-02T00:00:00Z',
      tokens: {
        account_id: 'ws-main', access_token: accessToken('ws-main','sub-upgraded-1','upgrade@example.test'), refresh_token: 'rt-upgraded',
        id_token: jwt({ sub: 'sub-upgraded-1', email: 'upgrade@example.test' }),
      },
    }));
    return success();
  };

  const refreshed = await accounts.refreshAccount(agent, 'active-card', true);
  assert.equal(refreshed.state, 'ok');
  // Live, original card, and same-generation alias all hold upgraded sub + new token!
  assert.equal(version(agent.homeDir), 'rt-upgraded');
  assert.equal(version(dir('active-card')), 'rt-upgraded');
  assert.equal(version(dir('same-gen-alias')), 'rt-upgraded');
  assert.equal(agent.identity(dir('active-card')).id, 'ws-main:sub-upgraded-1');
  assert.equal(accounts.activeProfile(agent), 'active-card');
  assert.equal(accounts.dashboard()[0].active, 'active-card');
  // Other workspace and concurrently changed generation stay untouched!
  assert.equal(version(dir('changed-copy')), 'rt-other-gen');
  assert.equal(version(dir('other-workspace')), 'rt-other-ws');

  // Switch away to another account and switch back to active-card cleanly!
  await accounts.useAccount(agent, 'switch-away');
  assert.equal(accounts.activeProfile(agent), 'switch-away');
  await accounts.useAccount(agent, 'active-card');
  assert.equal(accounts.activeProfile(agent), 'active-card');
  assert.equal(version(agent.homeDir), 'rt-upgraded');
});

test('retry recovery keeps the original result or error and removes only a proven successor', async t => {
  const { releaseTemporaryCredentials } = require('../dist/temporary-credentials');
  put(agent.homeDir, 'outside');
  const run = (name, retry, cachedVersion) => {
    const retained = [];
    t.after(() => retained.forEach(releaseTemporaryCredentials));
    put(dir(name), name, 1);
    agent.queryLiveRpc = async temp => {
      retained.push(temp);
      if (retained.length === 2) return retry(temp);
      put(temp, name, 9);
      put(dir(name), name, cachedVersion || 2);
      if (cachedVersion) {
        store.writeProfileMeta('codex', name, { snapshot: {
          available: true, state: 'ok', checkedAt: new Date().toISOString(), credentialRevision: credentialState(agent, dir(name)).revision,
        } });
      }
      return success();
    };
    return { result: accounts.refreshAccount(agent, name), retained };
  };

  const renewed = run('retry-clean', temp => {
    put(temp, 'retry-clean', 3);
    return success();
  });
  assert.equal((await renewed.result).state, 'ok');
  assert.equal(version(dir('retry-clean')), 'refresh-retry-clean-3');
  assert.equal(fs.existsSync(renewed.retained[0]), false);

  const failed = run('retry-expired', () => { throw new CodexQueryError('凭据失效', 'refresh-revoked'); });
  const status = await failed.result;
  assert.equal(status.state, 'expired');
  assert.match(status.extra, /凭据失效/);
  assert.ok(status.extra.includes(failed.retained[0]));
  assert.ok(fs.existsSync(failed.retained[0]));

  const conflict = run('retry-conflict', temp => {
    put(temp, 'retry-conflict', 8);
    put(dir('retry-conflict'), 'retry-conflict', 3);
    return success();
  });
  await assert.rejects(conflict.result, err =>
    err instanceof CredentialChangedError && conflict.retained.length === 2 &&
    conflict.retained.every(temp => fs.existsSync(temp) && err.message.includes(temp)));
  assert.equal(version(dir('retry-conflict')), 'refresh-retry-conflict-3');
  assert.equal(store.readProfileMeta('codex', 'retry-conflict').snapshot, undefined);

  // Only the exact successor on disk permits cleanup after a cache hit.
  for (const version of [2, 9]) {
    const cached = run('cached-' + version, () => assert.fail('unexpected second query'), version);
    const final = await cached.result;
    assert.equal(final.state, 'ok');
    assert.equal(fs.existsSync(cached.retained[0]), version !== 9);
    assert.equal(!!final.extra?.includes(cached.retained[0]), version !== 9);
  }
});

test('a different identity representation sharing a client refresh token is queried read-only', async t => {
  put(agent.homeDir, 'alias-user');
  const alias = JSON.parse(auth('alias-user'));
  delete alias.tokens.id_token;
  alias.tokens.email = 'alias-user@example.test';
  atomicWrite(file(dir('alias')), JSON.stringify(alias));
  t.mock.method(clients, 'runningClients', async () => ['Codex']);
  agent.queryLiveRpc = async (temp, allowRefresh) => {
    assert.equal(allowRefresh, false);
    assert.equal(version(temp), 'ags-refresh-disabled');
    return success();
  };
  assert.equal((await accounts.refreshAccount(agent, 'alias', true)).state, 'ok');
});

test('credential shared by an Antigravity auxiliary source defers isolated authentication', async t => {
  const { AntigravityAgent } = require('../dist/agents/antigravity');
  const agy = new AntigravityAgent(() => 'unified', true, () => ({ state: 'ready' }));
  const credential = user => Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: user + '@example.test',
    token: { access_token: 'fixture-access', refresh_token: 'fixture-' + user } }));
  const file = agy.authFiles[0], primary = credential('desktop'), cli = credential('cli');
  t.mock.method(agy, 'readCredentials', directory => ({ [file]: directory && directory !== agy.homeDir ? cli : primary }));
  t.mock.method(agy, 'auxiliaryCredentials', () => [{ identity: agy.identityFromBytes(cli), files: { [file]: cli } }]);
  t.mock.method(clients, 'runningClients', async () => ['Antigravity']);
  atomicWrite(path.join(store.profileDir('agy', 'cli'), file), cli);
  let calls = 0;
  t.mock.method(agy, 'queryCredential', async (_, options) => {
    calls++;
    assert.equal(options.allowRefresh, false);
    return { status: { available: true, state: 'unverified' } };
  });
  assert.equal((await accounts.refreshAccount(agy, 'cli', true)).state, 'unverified');
  assert.equal(calls, 1);
});

test('cosmetic auth file rewrite during retry preserves a previous uncommitted refresh', async t => {
  put(agent.homeDir, 'outside');
  put(dir('cosmetic'), 'cosmetic');
  let recovery;
  agent.queryLiveRpc = async temp => {
    if (!recovery) {
      recovery = temp;
      put(temp, 'cosmetic', 9);
      put(dir('cosmetic'), 'cosmetic', 2);
    } else {
      const sameTokens = JSON.parse(readCredentialFile(file(temp)));
      atomicWrite(file(temp), JSON.stringify(sameTokens, null, 2));
    }
    return success();
  };
  t.after(() => { if (recovery) require('../dist/temporary-credentials').releaseTemporaryCredentials(recovery); });
  const status = await accounts.refreshAccount(agent, 'cosmetic', true);
  assert.equal(status.state, 'ok');
  assert.equal(version(recovery), 'refresh-cosmetic-9');
  assert.ok(status.extra.includes(recovery));
});
