const { mockIdleClients, createTestHome, readCredentialFile, accessToken } = require('./helpers/test-env.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = createTestHome('ags-codex-query-identity-');
const {CodexAgent, CodexQueryError} = require('../dist/agents/codex');
const {CredentialChangedError} = require('../dist/credential-state');
const {releaseTemporaryCredentials} = require('../dist/temporary-credentials');
const {atomicWrite} = require('../dist/utils');
const accounts = require('../dist/accounts'), store = require('../dist/store');
const clients = mockIdleClients();

const workspace = 'team', sub = 'member', email = 'member@example.test';
const auth = (tokens) => Buffer.from(JSON.stringify({auth_mode:'chatgpt', tokens}));
const signed = (refresh, user = sub, mail = email, ws = workspace) => auth({
  account_id:ws, id_token:accessToken(ws,user,mail), access_token:accessToken(ws,user,mail,refresh), refresh_token:refresh,
});
const live = (mail = email) => ({account:{type:'chatgpt',email:mail},rates:{rateLimits:{primary:{usedPercent:14}}}});
const profile = (name) => path.join(store.profileDir('codex',name),'auth.json');
function fixtureAgent(name) {
  const agent = new CodexAgent();
  Object.defineProperty(agent,'homeDir',{value:path.join(root,name+'-current')});
  return agent;
}

test('only rejection of a real renewal expires the Codex login', async t => {
  const agent = fixtureAgent('rpc-grant'), original = signed('saved-grant');
  t.mock.method(agent,'findCodexBinary',() => 'fixture');
  let scenario, requests, grant;
  const denied = 'Your access token could not be refreshed. Please log out and sign in again.';
  t.mock.method(require('../dist/codex-process'),'startCodexProcess',(_bin,home,handlers) => {
    grant = JSON.parse(fs.readFileSync(path.join(home,'auth.json'))).tokens.refresh_token;
    return {
      send({id}) {
        if (id === undefined) return;
        requests.push(id);
        let response = { result:{} };
        if (id === 1) response = { error:{code:-32603,message:denied} };
        if (id === 3) response = scenario === 'quota-401' ? { result:{account:{type:'chatgpt',email}} }
          : scenario === 'stderr' ? { result:{account:null} } : { error:{message:'Encountered invalidated oauth token for user'} };
        if (id === 2) response = { error:{status:401} };
        if (id === 3 && scenario === 'disconnected') return queueMicrotask(() => handlers.onError('connection'));
        queueMicrotask(() => handlers.onMessage({id,...response}));
      },
      stop() {
        if (['stderr','disconnected','quota-401'].includes(scenario)) {
          handlers.onStderr(Buffer.from('Failed to refresh token sta'));
          handlers.onStderr(Buffer.from('tus=401 private-response'));
        }
        queueMicrotask(handlers.onClose);
      },
    };
  });
  for (scenario of ['held','internal','explicit','stderr','disconnected','quota-401']) {
    requests = [];
    const force = !['held','internal'].includes(scenario);
    const {status} = await agent.queryCredential(original,{allowRefresh:scenario !== 'held',renewRejectedBearer:force});
    const expired = scenario !== 'held' && scenario !== 'quota-401';
    assert.equal(grant, scenario === 'held' ? 'ags-refresh-disabled' : 'saved-grant');
    assert.deepEqual(requests, scenario === 'quota-401' ? [0,3,2] : [0,force ? 3 : 1]);
    assert.equal(status.authExpired,expired); assert.equal(status.state,expired ? 'expired' : 'error');
    assert.equal(require('../renderer/account-policy.js').needsCredentialUpdate(status),expired);
    if (expired) assert.equal(status.extra,'登录凭据已失效，请点击「更新凭据」重新登录');
    if (scenario === 'held') assert.match(status.extra,/客户端.*续期/);
  }
});

test('fresh access uses a read-only nonpending copy and rechecks the login before retrying a rejection', async t => {
  let busy = false;
  t.mock.method(clients, 'runningClients', async () => busy ? ['Codex'] : []);
  for (const outcome of ['ok', 'outage', 'client-started', 'pool-changed']) {
    busy = false;
    const agent = fixtureAgent(outcome), file = profile(outcome), user = JSON.parse(signed(outcome));
    user.tokens.access_token = accessToken(workspace,sub,email,outcome,Math.floor(Date.now()/1000)+3600);
    const input = Buffer.from(JSON.stringify(user)), successor = signed(outcome+'-new');
    atomicWrite(file, input);
    if (outcome === 'client-started') atomicWrite(path.join(agent.homeDir,'auth.json'), input);
    const homes = [];
    agent.queryLiveRpc = async (dir, allow) => {
      homes.push(dir);
      const authFile = path.join(dir,'auth.json');
      assert.equal(allow, false);
      assert.equal(JSON.parse(fs.readFileSync(authFile)).tokens.refresh_token,'ags-refresh-disabled');
      assert.ok(!JSON.parse(fs.readFileSync(path.join(dir,'.ags-temporary-owner.json'))).pendingCommit);
      if (process.platform !== 'win32') assert.equal(fs.statSync(authFile).mode & 0o777,0o400);
      if (outcome === 'ok') return live();
      if (outcome === 'outage') throw new Error('fixture rate service unavailable');
      if (outcome === 'pool-changed') atomicWrite(file, successor);
      busy = outcome === 'client-started';
      throw new CodexQueryError('fixture bearer rejected', 'authentication-rejected');
    };
    const result = accounts.refreshAccount(agent,outcome,true);
    if (outcome === 'pool-changed') await assert.rejects(result, CredentialChangedError);
    else assert.equal((await result).state, outcome === 'ok' ? 'ok' : 'error');
    assert.equal(homes.length,1);
    assert.equal(fs.existsSync(homes[0]),false);
    assert.deepEqual(readCredentialFile(file), outcome === 'pool-changed' ? successor : input);
  }
});

test('Windows file login honors effective storage and keeps unidentified live credentials separate from saved accounts', async t => {
  const {windowsCodexFileIssue} = require('../dist/codex-file-auth');
  const agent = fixtureAgent('windows-policy');
  const envKeys = ['ProgramData','OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_FEDERATION_RULE_ID','OPENAI_IDENTITY_TOKEN_FILE'];
  const previous = envKeys.map(k => process.env[k]);
  t.after(() => envKeys.forEach((k,i) => previous[i] === undefined ? delete process.env[k] : process.env[k] = previous[i]));
  envKeys.forEach(k => delete process.env[k]);
  process.env.ProgramData = path.join(root,'ProgramData');
  process.env.OPENAI_API_KEY = 'sdk-fixture';
  if (process.platform !== 'win32') t.mock.method(agent,'switchSupport',() => windowsCodexFileIssue(agent.homeDir));
  const system = path.join(process.env.ProgramData,'OpenAI','Codex');
  fs.mkdirSync(system,{recursive:true}); fs.mkdirSync(agent.homeDir);
  const userConfig = path.join(agent.homeDir,'config.toml'), requirements = path.join(system,'requirements.toml');
  assert.equal(agent.switchSupport(),undefined);
  fs.writeFileSync(path.join(system,'config.toml'),'cli_auth_credentials_store="auto"');
  fs.writeFileSync(userConfig,'# default client\ncli_auth_credentials_store = "file"\n[projects.demo]\ntrust_level = "trusted"');
  assert.equal(agent.management().canSaveCurrent,true);
  fs.writeFileSync(requirements,'allowed_chatgpt_workspaces=["restricted"]');
  assert.equal(agent.management().isolatedLogin,false);
  fs.unlinkSync(requirements);
  const managed = path.join(agent.homeDir,'managed_config.toml');
  fs.writeFileSync(managed,'cli_auth_credentials_store="keyring"');
  assert.equal(agent.management().isolatedLogin,false);
  fs.unlinkSync(managed);
  process.env.OPENAI_FEDERATION_RULE_ID = 'fixture';
  assert.match(agent.switchSupport(),/环境变量/);
  delete process.env.OPENAI_FEDERATION_RULE_ID;
  fs.writeFileSync(userConfig,'cli_auth_credentials_store="file');
  assert.match(agent.switchSupport(),/TOML/);
  fs.writeFileSync(userConfig,'cli_auth_credentials_store="keyring"');
  const bytes = signed('windows-unchanged'), file = path.join(agent.homeDir,'auth.json'), saved = profile('windows-backup');
  atomicWrite(file,bytes); atomicWrite(saved,bytes);
  assert.deepEqual([agent.management().canSaveCurrent,agent.management().isolatedLogin],[false,true]);
  assert.equal(agent.identity(),undefined);
  await assert.rejects(accounts.saveAccount(agent,'stale-live'),/文件凭据/);
  await assert.rejects(accounts.useAccount(agent,'windows-backup'),/文件凭据/);
  assert.throws(() => agent.writeCredentials(agent.homeDir,{'auth.json':null}),/文件凭据/);
  let queries = 0;
  agent.queryLiveRpc = async (dir,allow) => {
    assert.equal(allow,false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'auth.json'))).tokens.refresh_token,'ags-refresh-disabled');
    queries++; return live();
  };
  assert.equal((await accounts.refreshAccount(agent,'windows-backup',true)).state,'ok');
  atomicWrite(saved+'.pending',signed('windows-candidate'));
  assert.equal((await accounts.refreshAccount(agent,'windows-backup',true)).stagedReplacement,true);
  assert.equal(queries,1);
  assert.deepEqual(readCredentialFile(saved),bytes); assert.deepEqual(fs.readFileSync(file),bytes);
  assert.deepEqual(readCredentialFile(saved+'.pending'),signed('windows-candidate'));
});

test('an opaque pair binds only the issuer identity proven by its own refresh, under the original card revision', async () => {
  const agent = fixtureAgent('opaque'), old = auth({access_token:'old-access',refresh_token:'original-lineage'});
  const target = profile('bind');
  atomicWrite(target, old);
  store.writeProfileMeta('codex','bind',{label:'keep',email});
  const visited = [];
  agent.queryLiveRpc = async (home,allowRefresh,forceRefresh) => {
    visited.push([allowRefresh,forceRefresh]);
    const file=path.join(home,'auth.json'), input=JSON.parse(fs.readFileSync(file));
    if (forceRefresh) {
      assert.equal(input.tokens.refresh_token,'original-lineage');
      const updated=JSON.parse(signed('new-lineage'));
      updated.tokens.account_id=input.tokens.account_id;
      atomicWrite(file,JSON.stringify(updated));
      throw new Error('temporary selector unresolved');
    }
    assert.equal(input.tokens.account_id,workspace);
    assert.equal(input.tokens.refresh_token,'ags-refresh-disabled');
    return live();
  };
  const result=await accounts.refreshAccount(agent,'bind',true);
  assert.equal(result.state,'ok',result.extra);
  assert.deepEqual(visited,[[true,true],[false,undefined]]);
  assert.deepEqual(readCredentialFile(target),signed('new-lineage'));
  assert.equal(store.readProfileMeta('codex','bind').label,'keep');
});

test('a registered subject without a workspace acquires only the same user’s issued workspace', async () => {
  const original = auth({id_token:accessToken(undefined,sub,email), access_token:accessToken(undefined,sub,email), refresh_token:'before'});
  for (const user of [sub,'other-member']) {
    const agent=fixtureAgent('no-workspace-'+user);
    let consumed=0, retained;
    agent.queryLiveRpc=async (home,allow,force)=>{
      if (force) {
        consumed++;
        retained=home;
        atomicWrite(path.join(home,'auth.json'),signed('after',user));
      }
      return live();
    };
    const busy=await agent.queryCredential(original,{allowRefresh:false});
    assert.equal(busy.status.state,'unverified');
    const result=await agent.queryCredential(original);
    assert.equal(consumed,1);
    if (user===sub) {
      assert.equal(result.status.state,'ok',result.status.extra);
      assert.equal(JSON.parse(result.rotated).tokens.account_id,workspace);
      const again=await agent.queryCredential(result.rotated);
      assert.equal(again.status.state,'ok');
      assert.equal(consumed,1);
    } else {
      assert.equal(result.status.refreshConsumed,true);
      assert.equal(result.rotated,undefined);
      assert.ok(result.status.extra.includes(retained));
    }
    releaseTemporaryCredentials(retained);
  }
});

test('opaque binding rejects a wrong registered user, wrong workspace, echo and unsupported issuer claims', async () => {
  for (const kind of ['wrong user','wrong workspace','echo','no issued workspace']) {
    const agent=fixtureAgent(kind), target=profile(kind);
    const old=auth({account_id:workspace,access_token:'opaque',refresh_token:'old'});
    atomicWrite(target,old);
    store.writeProfileMeta('codex',kind,{email});
    let directory;
    agent.queryLiveRpc=async home=>{
      directory=home;
      if (kind !== 'echo') {
        const rotated=JSON.parse(signed('new',sub,kind==='wrong user'?'other@example.test':email,kind==='wrong workspace'?'other-team':workspace));
        if (kind==='no issued workspace') {
          rotated.tokens.access_token='new-opaque';
          rotated.tokens.id_token=accessToken(undefined,sub,email);
        }
        atomicWrite(path.join(home,'auth.json'),JSON.stringify(rotated));
      }
      return live();
    };
    const status=await accounts.refreshAccount(agent,kind,true);
    assert.equal(status.state,kind==='echo'?'error':'expired',kind);
    assert.equal(!!status.refreshConsumed,kind!=='echo');
    assert.equal(status.quota,undefined);
    assert.deepEqual(readCredentialFile(target),old);
    if (kind==='echo') assert.ok(!fs.existsSync(directory));
    else {
      assert.ok(status.extra.includes(directory),status.extra);
      assert.ok(fs.existsSync(path.join(directory,'auth.json')));
      releaseTemporaryCredentials(directory);
    }
  }
});

test('a known account accepts an opaque bearer issued with its fresh identity without repeating that exchange', async () => {
  const agent=fixtureAgent('issued-opaque'), old=auth({
    account_id:workspace,id_token:accessToken(workspace,sub,email),access_token:'old',refresh_token:'old',
  });
  const issued=auth({account_id:workspace,id_token:accessToken(workspace,sub,email,'new'),access_token:'issued opaque bearer',refresh_token:'new'});
  let exchanges=0;
  agent.queryLiveRpc=async (home,allow,force)=>{
    if (force) { exchanges++; atomicWrite(path.join(home,'auth.json'),issued); }
    return live(email.toUpperCase());
  };
  const first=await agent.queryCredential(old);
  assert.equal(first.status.state,'ok',first.status.extra);
  assert.deepEqual(first.rotated,issued);
  releaseTemporaryCredentials(first.temporaryDirectory);
  assert.equal((await agent.queryCredential(issued,{allowRefresh:false})).status.state,'ok');
  assert.equal(exchanges,1);
});

test('quota failure after an authenticated first binding saves the successor without attributing new quota', async () => {
  const agent=fixtureAgent('quota-outage'), target=profile('after-outage');
  atomicWrite(target,auth({account_id:workspace,refresh_token:'consumed',access_token:'opaque'}));
  store.writeProfileMeta('codex','after-outage',{email});
  const next=auth({account_id:workspace,id_token:accessToken(workspace,sub,email),access_token:'issuer-opaque',refresh_token:'usable'});
  agent.queryLiveRpc=async (home,allow,force)=>{
    assert.equal(force,true);
    atomicWrite(path.join(home,'auth.json'),next);
    throw new Error('fixture quota endpoint unavailable');
  };
  const status=await accounts.refreshAccount(agent,'after-outage',true);
  assert.equal(status.state,'error');
  assert.equal(status.quota,undefined);
  assert.deepEqual(readCredentialFile(target),next);
  agent.queryLiveRpc=async (home,allow,force)=>{assert.ok(!force); return live();};
  assert.equal((await agent.queryCredential(next,{allowRefresh:false})).status.state,'ok');
});

test('a normal RPC can fail after the CLI already persisted a matching newly issued opaque pair', async () => {
  const agent=fixtureAgent('normal-rotated-outage'), next=auth({
    id_token:accessToken(workspace,sub,email,'issued'), account_id:workspace, access_token:'opaque-after',refresh_token:'after',
  });
  agent.queryLiveRpc=async home=>{
    atomicWrite(path.join(home,'auth.json'),next);
    throw new Error('fixture rate service offline');
  };
  const query=await agent.queryCredential(signed('before'));
  assert.equal(query.status.state,'error');
  assert.equal(query.status.quota,undefined);
  assert.deepEqual(query.rotated,next);
  assert.equal(query.status.refreshConsumed,undefined);
  releaseTemporaryCredentials(query.temporaryDirectory);
});

test('normal quota checks reject conflicting claims and RPC returns, including a late rotation', async () => {
  const agent=fixtureAgent('normal'), old=signed('old'), foreign='other@example.test';
  const mismatched=JSON.parse(old); mismatched.tokens.access_token=accessToken(workspace,'different-user',foreign);
  agent.queryLiveRpc=async()=>assert.fail('conflicting input must stop before RPC');
  assert.equal((await agent.queryCredential(Buffer.from(JSON.stringify(mismatched)))).status.state,'error');
  const wrongSub=JSON.parse(old); wrongSub.tokens.access_token=accessToken(workspace,undefined,email);
  assert.equal((await agent.queryCredential(Buffer.from(JSON.stringify(wrongSub)),{allowRefresh:false})).status.state,'unverified');
  for (const allowRefresh of [false,true]) {
    agent.queryLiveRpc=async()=>live(foreign);
    const query=await agent.queryCredential(old,{allowRefresh});
    assert.equal(query.status.state,'error');
    assert.equal(query.status.account,email);
    assert.equal(query.status.quota,undefined);
    assert.equal(query.rotated,undefined);
  }
  for (const afterRotation of ['wrong reported user','RPC error after other workspace rotation']) {
    let retained;
    const next=afterRotation==='wrong reported user'?signed('new'):signed('new',sub,email,'other-workspace');
    agent.queryLiveRpc=async home=>{
      retained=home;
      atomicWrite(path.join(home,'auth.json'),next);
      if (afterRotation.startsWith('RPC error')) throw new Error('quota unavailable');
      return live(foreign);
    };
    const uncommitted=await agent.queryCredential(old);
    assert.equal(uncommitted.status.refreshConsumed,true);
    assert.equal(uncommitted.rotated,undefined);
    assert.equal(uncommitted.temporaryDirectory,undefined);
    assert.ok(uncommitted.status.extra.includes(retained));
    assert.deepEqual(fs.readFileSync(path.join(retained,'auth.json')),next);
    releaseTemporaryCredentials(retained);
  }
});
