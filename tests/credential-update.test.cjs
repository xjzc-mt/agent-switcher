const { mockIdleClients, createTestHome, readCredentialFile, jwt } = require('./helpers/test-env.cjs');
const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root = createTestHome('ags-credential-update-');
const clients = mockIdleClients();
const store=require('../dist/store');
const backup=require('../dist/backup');
const accounts=require('../dist/accounts');
const {codexAgent:agent}=require('../dist/agents/codex');
const utils=require('../dist/utils');
Object.defineProperty(agent,'homeDir',{value:path.join(root,'live')});

const auth=(workspace,token='old',member='person',email='same@example.test')=>Buffer.from(JSON.stringify({
  auth_mode:'chatgpt',
  tokens:{
    account_id:workspace,
    access_token:'access-'+token,
    refresh_token:token,
    id_token:jwt({sub:member,email,'https://api.openai.com/auth':{chatgpt_account_id:workspace,user_id:member}}),
  },
}));
const file=name=>path.join(store.profileDir('codex',name),'auth.json');
const stagedFile=name=>path.join(store.profileDir('codex',name),'auth.json.pending');
function expired(name,id,token='old'){
  utils.atomicWrite(file(name),auth(id,token));
  store.writeProfileMeta('codex',name,{label:name,email:'same@example.test',savedAt:'2026-01-01',quotaNote:'keep',snapshot:{state:'expired',authExpired:true,available:true,plan:'plus',checkedAt:'2026-01-02',fetchedAt:'2026-01-01',extra:'凭据失效',refreshFailures:3,quota:{primaryWindow:{usedPercent:40}}}});
}
const preview=(name,id,token='new',member)=>backup.previewCredentialUpdate(auth(id,token,member),'codex',name);
const install=p=>backup.installCredentialUpdate(p.parsed,p.target);

function mockServerVerify(workspace, member='person', rotatedToken='server-rotated', email='same@example.test') {
  return async dir => {
    const incoming = JSON.parse(readCredentialFile(path.join(dir, 'auth.json')));
    // The existing account supplies the routing selector. User claims come from the exchange.
    assert.equal(typeof incoming.tokens.id_token, 'string');
    const idClaims = utils.jwtInfo(incoming.tokens.id_token);
    assert.equal(idClaims.sub, 'ags-unverified-sentinel');
    assert.equal(idClaims.email, 'unverified@ags.invalid');
    assert.equal(incoming.tokens.email, undefined);
    assert.ok(incoming.tokens.account_id);
    utils.atomicWrite(path.join(dir, 'auth.json'), auth(workspace, rotatedToken, member, email));
    return { account: { email, planType: 'plus' }, rates: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } } };
  };
}

beforeEach(()=>{
  for(const dir of [store.STORE_DIR,agent.homeDir])fs.rmSync(dir,{recursive:true,force:true});
  agent.queryLiveRpc=mockServerVerify('A');
});

test('mere account/read email echo, same-email wrong workspace, forged id_token, and insufficient identity preserve original credentials and guide to re-login',async()=>{
  // 1. Mere account/read email echo WITHOUT server-refreshed token claims MUST NOT authorize replacement!
  expired('echo-only','WS1');
  const origEcho=readCredentialFile(file('echo-only'));
  await install(await preview('echo-only','WS1','forged-rt'));
  agent.queryLiveRpc=async()=>({account:{email:'same@example.test',planType:'plus'},rates:{rateLimits:{primary:{usedPercent:5}}}});
  const echoRes=await accounts.refreshAccount(agent,'echo-only',true);
  assert.equal(echoRes.state,'expired');
  assert.match(echoRes.extra||'',/重新登录/);
  assert.deepEqual(readCredentialFile(file('echo-only')),origEcho);
  assert.equal(fs.existsSync(stagedFile('echo-only')),false);

  // 2. Forged local id_token claiming victim sub+workspace, but actual refresh_token resolves on server to same email in ANOTHER workspace!
  expired('same-email-ws','WS-VICTIM');
  utils.atomicWrite(path.join(agent.homeDir,'auth.json'),auth('WS-VICTIM'));
  const origWs=readCredentialFile(file('same-email-ws'));
  await install(await preview('same-email-ws','WS-VICTIM','other-ws-rt'));
  agent.queryLiveRpc=mockServerVerify('WS-OTHER','person','rotated-other','same@example.test');
  const wsRes=await accounts.refreshAccount(agent,'same-email-ws',true);
  assert.equal(wsRes.state,'expired');
  assert.match(wsRes.extra||'',/重新登录/);
  assert.deepEqual(readCredentialFile(file('same-email-ws')),origWs);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),origWs);

  // 3. Forged local id_token claiming victim sub+workspace, but actual refresh_token resolves to DIFFERENT user!
  await install(await preview('same-email-ws','WS-VICTIM','attacker-rt'));
  agent.queryLiveRpc=mockServerVerify('WS-VICTIM','attacker-sub','rotated-attacker','same@example.test');
  const userRes=await accounts.refreshAccount(agent,'same-email-ws',true);
  assert.equal(userRes.state,'expired');
  assert.match(userRes.extra||'',/重新登录/);
  assert.deepEqual(readCredentialFile(file('same-email-ws')),origWs);

  // 4. Insufficient identity on target (opaque refresh_token only, no sub or email) rejects external replacement upfront!
  const opaque=Buffer.from(JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'WS-OPAQUE',access_token:'opaque-a',refresh_token:'opaque-r'}}));
  utils.atomicWrite(file('opaque-target'),opaque);
  store.writeProfileMeta('codex','opaque-target',{snapshot:{state:'expired',authExpired:true,available:true}});
  const pOpaque=await backup.previewCredentialUpdate(opaque,'codex','opaque-target');
  await assert.rejects(install(pOpaque),/重新登录/);
  assert.deepEqual(readCredentialFile(file('opaque-target')),opaque);

  // 5. sameRefreshedIdentity rejects when one side only has email and the other only has sub.
  assert.equal(agent.sameRefreshedIdentity(
    {tokens:{access_token:'a1',refresh_token:'r1',email:'only@example.test'}},
    {tokens:{access_token:'a2',refresh_token:'r2',id_token:jwt({sub:'sub-without-email'})}},
  ),false);
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

test('an unresolved authentication error permits replacement only while the error is current',async()=>{
  for(const reason of ['account-unavailable','authentication-rejected']) {
    expired('target','B');
    store.writeProfileMeta('codex','target',{snapshot:{state:'error',available:true,authFailure:reason}});
    assert.equal((await preview('target','B')).target.profile,'target');
  }
  for(const snapshot of [{state:'error',available:true,extra:'网络连接失败'},{state:'ok',available:true,authFailure:'account-unavailable'}]) {
    store.writeProfileMeta('codex','target',{snapshot});
    await assert.rejects(preview('target','B'),/未标记/);
  }
});

test('a plan-only server response survives rejection and failed replacement for the same saved login',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const name='plan-only', workspace='original-workspace';
  const card=()=>accounts.dashboard()[0].profiles.find(p=>p.name===name).meta.snapshot;
  const login=JSON.parse(auth(workspace));
  login.tokens.access_token=login.tokens.id_token;
  utils.atomicWrite(file(name),JSON.stringify(login));
  agent.queryLiveRpc=async()=>({account:{email:'same@example.test',planType:'pro'}});
  const initial=await accounts.refreshAccount(agent,name,true);
  assert.equal(initial.plan,'pro');assert.equal(initial.quota,undefined);
  t.mock.timers.tick(30000);
  const {CodexQueryError}=require('../dist/agents/codex');
  agent.queryLiveRpc=async()=>{throw new CodexQueryError('fixture rejection','authentication-rejected');};
  assert.equal((await accounts.refreshAccount(agent,name,true)).authFailure,'authentication-rejected');
  assert.equal(card().plan,'pro');
  await install(await preview(name,workspace));
  t.mock.method(agent,'queryCredential',async()=>({status:{state:'error',available:true,plan:'enterprise'}}));
  assert.equal((await accounts.refreshAccount(agent,name,true)).state,'expired');
  assert.equal(card().plan,'pro');assert.equal(card().quota,undefined);
  utils.atomicWrite(file(name),auth('other-workspace'));
  assert.equal(card().plan,undefined,'A different workspace under the same email cannot inherit the previous plan');
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
  agent.queryLiveRpc=mockServerVerify('E','person','verified-E');
  await accounts.refreshAccount(agent,'standby',true);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('LIVE'));
  assert.equal(store.getActiveProfile('codex'),'current');
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'config.toml')),config);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'.codex-global-state.json')),projects);
});

test('updating the current expired account preserves live auth while staged, then updates live auth once verified',async()=>{
  expired('current','F');utils.atomicWrite(path.join(agent.homeDir,'auth.json'),auth('F'));
  store.setActiveProfile('codex','current');
  agent.queryLiveRpc=async()=>{throw new Error('凭据失效');};
  await accounts.refreshAccount(agent,'current',true);
  await install(await preview('current','F'));
  assert.deepEqual(readCredentialFile(file('current')),auth('F'));
  assert.equal(fs.existsSync(stagedFile('current')),true);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('F'));
  agent.queryLiveRpc=mockServerVerify('F','person','verified-F');
  assert.equal((await accounts.refreshAccount(agent,'current',true)).state,'ok');
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('F','verified-F'));
  assert.deepEqual(readCredentialFile(file('current')),auth('F','verified-F'));
  assert.equal(fs.existsSync(stagedFile('current')),false);
  assert.equal(accounts.dashboard()[0].status.state,'ok');
  assert.equal(store.getActiveProfile('codex'),'current');
});

test('a failed live write during trusted replacement rolls profile credentials and metadata back together',async()=>{
  expired('current','G');utils.atomicWrite(path.join(agent.homeDir,'auth.json'),auth('G'));
  const meta=readCredentialFile(path.join(store.profileDir('codex','current'),'_meta.json'));
  const target=accounts.credentialUpdateTarget(agent,'current');
  const isolated=path.join(root,'trusted-login');
  utils.atomicWrite(path.join(isolated,'auth.json'),auth('G','new'));
  const original=utils.replaceFiles;
  utils.replaceFiles=(dir,files)=>{if(dir===agent.homeDir)throw new Error('simulated write failure');return original(dir,files);};
  try{await assert.rejects(accounts.updateAccountCredentials(target,isolated,undefined,{trusted:true}),/write failure/);}finally{utils.replaceFiles=original;}
  assert.deepEqual(readCredentialFile(file('current')),auth('G'));
  assert.deepEqual(readCredentialFile(path.join(store.profileDir('codex','current'),'_meta.json')),meta);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),auth('G'));
});

test('credential update rejects duplicate JSON keys and strips extra root fields in staged payload', async () => {
  expired('strict-target', 'S');
  const valid = JSON.parse(auth('S', 'clean-token'));
  const duplicateKey = `{"tokens":${JSON.stringify(valid.tokens)},"tokens":${JSON.stringify(valid.tokens)}}`;
  await assert.rejects(backup.previewCredentialUpdate(Buffer.from(duplicateKey), 'codex', 'strict-target'), /重复字段/);
  const fencedExtra = '```jsonc\n// update\n' + JSON.stringify({ ...valid, extraField: 'strip-me' }) + '\n```';
  const p = await backup.previewCredentialUpdate(Buffer.from(fencedExtra), 'codex', 'strict-target');
  await install(p);
  const staged = JSON.parse(readCredentialFile(stagedFile('strict-target')));
  assert.equal(staged.extraField, undefined);
  assert.equal(staged.tokens.refresh_token, 'clean-token');
});

test('busy client defers verification, post-rotation quota failure keeps its directory, and official re-login works with .pending', async () => {
  const { createLoginManager } = require('../dist/isolated-login');
  const { releaseTemporaryCredentials } = require('../dist/temporary-credentials');

  // 2. B1: Busy live client (or probe failure) defers staged verification BEFORE starting rotating RPC; spare still verifies!
  expired('live-staged', 'WS-BUSY');
  utils.atomicWrite(path.join(agent.homeDir, 'auth.json'), auth('WS-BUSY', 'old'));
  const originalMeta = store.readProfileMeta('codex', 'live-staged');
  originalMeta.snapshot.refreshConsumed = true;
  originalMeta.snapshot.consumedRefreshFingerprint = utils.fingerprint('old');
  store.writeProfileMeta('codex', 'live-staged', originalMeta);
  expired('spare-staged', 'WS-SPARE', 'old-spare');
  await install(await preview('live-staged', 'WS-BUSY', 'new-live-rt'));
  await install(await preview('spare-staged', 'WS-SPARE', 'new-spare-rt'));
  let rpcCalls = 0;
  agent.queryLiveRpc = async dir => {
    rpcCalls++;
    utils.atomicWrite(path.join(dir, 'auth.json'), auth('WS-SPARE', 'verified-spare'));
    return { account: { email: 'same@example.test' }, rates: { rateLimits: { primary: { usedPercent: 15 } } } };
  };
  const prevClients = clients.runningClients;
  try {
    clients.runningClients = async () => ['Codex'];
    const deferredLive = await accounts.refreshAccount(agent, 'live-staged', true);
    assert.equal(rpcCalls, 0, 'must not start rotating verification while live client is running');
    assert.equal(deferredLive.state, 'unverified');
    assert.match(deferredLive.extra || '', /客户端正在运行/);
    assert.equal(fs.existsSync(stagedFile('live-staged')), true, '.pending must remain staged for later verification');
    const busyCard = accounts.dashboard()[0].profiles.find(p => p.name === 'live-staged');
    assert.equal(busyCard.meta.snapshot.checkedAt, deferredLive.checkedAt);
    assert.ok(busyCard.refreshAt > Date.now());
    assert.equal(store.readProfileMeta('codex', 'live-staged').snapshot.consumedRefreshFingerprint,
      utils.fingerprint('old'), 'deferring the candidate must preserve protection for the original token');

    const spareOk = await accounts.refreshAccount(agent, 'spare-staged', true);
    assert.equal(spareOk.state, 'ok');
    assert.equal(rpcCalls, 1, 'spare account must verify independently while client is running');
  } finally { clients.runningClients = prevClients; }

  // 3. B3: With .pending still staged on 'live-staged', official isolated re-login is allowed and clears .pending!
  const dashCard = accounts.dashboard().find(a => a.id === 'codex').profiles.find(p => p.name === 'live-staged');
  assert.equal(dashCard.meta.snapshot.stagedReplacement, true);
  let fakePhase = 'waiting';
  let capturedLoginDir = '';
  const loginMgr = createLoginManager(agent, (directory, target) => {
    capturedLoginDir = directory;
    return {
      attempt: 2,
      directory,
      target,
      link: Promise.resolve('https://auth.openai.com/authorize?test=2'),
      get phase() { return fakePhase; },
      async stop() {},
    };
  });
  await loginMgr.useLink(() => {}, undefined, 'live-staged');
  utils.atomicWrite(path.join(capturedLoginDir, 'auth.json'), auth('WS-BUSY', 'official-relogin-rt'));
  fakePhase = 'complete';
  const updRes = await loginMgr.update('live-staged', 2);
  assert.equal(updRes.ok, true);
  assert.equal(store.readProfileMeta('codex', 'live-staged').stagedCheck, undefined);
  assert.equal(fs.existsSync(stagedFile('live-staged')), false, '.pending must be cleaned up on official re-login');
  assert.deepEqual(readCredentialFile(file('live-staged')), auth('WS-BUSY', 'official-relogin-rt'));
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir, 'auth.json')), auth('WS-BUSY', 'official-relogin-rt'));

  // 4. B2: Server rotates candidate token during verification, then quota request fails -> rotated temp dir is RETAINED and surfaced!
  expired('rot-fail-card', 'WS-ROT');
  await install(await preview('rot-fail-card', 'WS-ROT', 'single-use-rt'));
  let rotatedTempDir = '';
  agent.queryLiveRpc = async dir => {
    rotatedTempDir = dir;
    utils.atomicWrite(path.join(dir, 'auth.json'), auth('WS-ROT', 'rotated-only-copy'));
    throw new Error('额度接口 503');
  };
  try {
    const rotFailRes = await accounts.refreshAccount(agent, 'rot-fail-card', true);
    assert.equal(rotFailRes.state, 'expired');
    assert.ok(rotatedTempDir && fs.existsSync(rotatedTempDir), 'rotated temporary directory must be retained on quota failure');
    assert.ok((rotFailRes.extra || '').includes(rotatedTempDir), 'extra must surface recovery directory location');
    assert.deepEqual(readCredentialFile(path.join(rotatedTempDir, 'auth.json')), auth('WS-ROT', 'rotated-only-copy'));
  } finally {
    if (rotatedTempDir) releaseTemporaryCredentials(rotatedTempDir);
  }
});

test('installed Codex verifies a replacement through a loopback token exchange and usage response', async t => {
  const { CodexAgent } = require('../dist/agents/codex');
  const { releaseTemporaryCredentials } = require('../dist/temporary-credentials');
  const rpc = new CodexAgent();
  const binary = rpc.findCodexBinary();
  if (!binary || process.platform === 'win32') return t.skip('requires an installed POSIX Codex CLI');
  const workspace = 'fixture-workspace', email = 'fixture@example.test', sub = 'fixture-user';
  const freshJwt = jwt({ sub, email, exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: workspace, chatgpt_plan_type: 'plus' } });
  const exchanged = [];
  const server = require('node:http').createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      const body = [];
      for await (const part of req) body.push(part);
      exchanged.push(JSON.parse(Buffer.concat(body)).refresh_token);
      return res.end(JSON.stringify({ access_token: freshJwt, id_token: freshJwt, refresh_token: 'fixture-new' }));
    }
    if (req.url.endsWith('/accounts/check')) {
      return res.end(JSON.stringify({ accounts: [{ id: workspace, account_id: workspace, plan_type: 'plus',
        workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT' }],
        default_account_id: workspace, account_ordering: [workspace] }));
    }
    if (req.url.endsWith('/usage')) {
      if (req.headers.authorization !== 'Bearer ' + freshJwt) { res.writeHead(401); return res.end('{}'); }
      return res.end(JSON.stringify({ plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 300, reset_at: 1956000000 } } }));
    }
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const wrapper = path.join(root, 'test-codex');
  t.mock.method(rpc, 'findCodexBinary', () => wrapper);
  // Set overrides inside the fixture executable. Production strips caller-provided endpoints.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(wrapper, [
    '#!/bin/sh', 'export HOME="$CODEX_HOME"',
    'export HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1 ALL_PROXY=http://127.0.0.1:1 NO_PROXY=127.0.0.1',
    'export CODEX_REFRESH_TOKEN_URL_OVERRIDE=' + quote(base + '/token'),
    'exec ' + quote(binary) + ' "$@" -c ' + quote('chatgpt_base_url="' + base + '/backend-api"'),
  ].join('\n'), { mode: 0o700 });
  const result = await rpc.queryCredential(auth(workspace, 'fixture-candidate', sub, email), {
    verifyTarget: auth(workspace, 'fixture-expired', sub, email),
  });
  if (result.temporaryDirectory) t.after(() => releaseTemporaryCredentials(result.temporaryDirectory));
  assert.deepEqual(exchanged, ['fixture-candidate']);
  assert.equal(result.verifiedReplacement, true, result.status.extra);
  assert.equal(result.status.quota.primaryWindow.usedPercent, 5);
  assert.equal(JSON.parse(result.rotated).tokens.refresh_token, 'fixture-new');

  // The official app-server guards refresh behind a local selector. A bare imported pair
  // must discover its workspace from this exchange, then query under the discovered value.
  const bare = Buffer.from(JSON.stringify({tokens:{access_token:'opaque',refresh_token:'fixture-bare'}}));
  const filePath = file('unbound');
  utils.atomicWrite(filePath, bare);
  Object.defineProperty(rpc, 'homeDir', {value:path.join(root, 'simulated-current-login')});
  const status = await accounts.refreshAccount(rpc, 'unbound', true);
  assert.equal(status.state, 'ok', status.extra);
  assert.equal(status.account, email);
  assert.equal(status.quota.primaryWindow.usedPercent, 5);
  assert.deepEqual(exchanged, ['fixture-candidate', 'fixture-bare']);
  const saved = JSON.parse(readCredentialFile(filePath));
  assert.equal(saved.tokens.account_id, workspace);
  assert.equal(saved.tokens.refresh_token, 'fixture-new');
  assert.equal(rpc.identity(store.profileDir('codex','unbound')).id, workspace + ':' + sub);
  assert.doesNotMatch(JSON.stringify(saved), /ags-unverified|ags-refresh-disabled/);
});

test('a workspace selector alone cannot establish the workspace of the refreshed login', async t => {
  const workspace = 'expected-workspace';
  const target = auth(workspace, 'original');
  const issued = JSON.parse(auth(workspace, 'issued'));
  issued.tokens.id_token = jwt({ sub:'person', email:'same@example.test' });
  agent.queryLiveRpc = async directory => {
    utils.atomicWrite(path.join(directory, 'auth.json'), JSON.stringify(issued));
    return { rates: { rateLimits: { primary: { usedPercent: 5 } } } };
  };
  const result = await agent.queryCredential(auth(workspace, 'candidate'), { verifyTarget: target });
  if (result.temporaryDirectory) t.after(() => require('../dist/temporary-credentials').releaseTemporaryCredentials(result.temporaryDirectory));
  assert.equal(result.verifiedReplacement, false);
});

test('an official verification commits its successor and releases its home when only the live write fails', async t => {
  expired('active','STAGED');
  const before = auth('STAGED'), after = auth('STAGED','verified');
  utils.atomicWrite(path.join(agent.homeDir,'auth.json'),before);
  await install(await preview('active','STAGED','candidate'));
  const verify = mockServerVerify('STAGED','person','verified');
  let temporary;
  agent.queryLiveRpc = dir => { temporary=dir; return verify(dir); };
  const write = agent.writeCredentials.bind(agent);
  t.mock.method(agent,'writeCredentials',(dir,files)=>{
    if (dir === agent.homeDir) throw new Error('simulated live write failure');
    write(dir,files);
  });
  const status = await accounts.refreshAccount(agent,'active',true);
  assert.equal(status.state,'ok');
  assert.match(status.extra,/账号池凭据已更新.*切换/);
  assert.equal(accounts.dashboard()[0].active,undefined);
  assert.deepEqual(readCredentialFile(file('active')),after);
  assert.deepEqual(readCredentialFile(path.join(agent.homeDir,'auth.json')),before);
  assert.equal(fs.existsSync(stagedFile('active')),false);
  assert.equal(fs.existsSync(temporary),false);
});

test('a queued verification cannot consume another identity’s staged login under a reused name', async t => {
  expired('queued','A');
  expired('next','B');
  await install(await preview('next','B','candidate-B'));
  const verify = t.mock.method(agent, 'queryLiveRpc', mockServerVerify('B'));
  const originalDir = store.profileDir('codex','queued');
  let refresh;
  await store.withStoreLock(async () => {
    refresh = accounts.refreshAccount(agent,'queued',true);
    await store.withStoreLock(async () => {
      fs.rmSync(originalDir, {recursive:true});
      fs.renameSync(store.profileDir('codex','next'), originalDir);
    });
  }, agent.identity(originalDir).id);
  await assert.rejects(refresh, require('../dist/credential-state').CredentialChangedError);
  assert.equal(verify.mock.callCount(),0);
  assert.deepEqual(readCredentialFile(stagedFile('queued')),auth('B','candidate-B'));
});
