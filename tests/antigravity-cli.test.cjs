const { createTestHome, readCredentialFile } = require('./helpers/test-env.cjs');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = createTestHome('ags-cli-test-');
const cli = require('../dist/antigravity-cli');
const native = require('../dist/antigravity-native');
const { profileDir, writeProfileMeta, readProfileMeta } = require('../dist/store');
const { credentialState } = require('../dist/credential-state');
const { atomicWrite } = require('../dist/utils');
const token = (email, generation = 1) => Buffer.from(JSON.stringify({ auth_method:'consumer', id_token_email:email,
  token:{ access_token:`fixture-${generation}`, refresh_token:`fixture-refresh-${email}`, expiry:new Date(1795000000000 + generation * 60000).toISOString() } }));
let live = token('a@example.test');
native.readNativeToken = () => live;
native.writeNativeToken = value => { live = value; };
const binary = path.join(root, '.local/bin/agy'), behaviorFile = path.join(root, 'behavior');
atomicWrite(binary, `#!${process.execPath}
const fs=require('fs'),path=require('path'),cp=require('child_process');
if(process.argv.includes('--version')) { console.log('1.5.9'); return; }
const home=process.env.HOME,file=path.join(home,'.gemini/antigravity-cli/antigravity-oauth-token');
const realHome=path.resolve(__dirname,'../..'),mode=fs.readFileSync(path.join(realHome,'behavior'),'utf8');
if(mode==='unsupported-syntax') {
 const acp=process.argv.includes('acp');
 process.stderr.write(acp?'Error: unknown com':'flag provided but not ');
 setTimeout(()=>process.stderr.write(acp?'mand "acp" fixture-private':'defined: -output-format fixture-private'),10);
 setInterval(()=>{},10000);
 return;
}
if(mode==='shared-usage') {
 const cwd=process.cwd(), args=process.argv.slice(2);
 if(fs.realpathSync(home)!==fs.realpathSync(realHome)||process.env.TMPDIR!==cwd||fs.realpathSync(home)===cwd||
    !fs.existsSync(path.join(home,'.gemini/probe'))||fs.existsSync(path.join(cwd,'.ags-temporary-owner.json'))||
    (fs.statSync(cwd).mode&0o077)||process.env.AGY_ADC_AUTH||process.env.ANTIGRAVITY_GEMINI_DIR||
    process.env.GEMINI_API_KEY||process.env.SSH_TTY) process.exit(26);
 if(args[args.indexOf('-p')+1]!=='/usage'||args[args.indexOf('--output-format')+1]!=='json'||
    JSON.parse(args[args.indexOf('--settings')+1]).disableSlashCommands!==false) process.exit(27);
 fs.writeFileSync(path.join(realHome,'shared-running'),JSON.stringify({pid:process.pid,cwd}));
 const poll=setInterval(()=>{
   if(!fs.existsSync(path.join(realHome,'shared-finish')))return;
   clearInterval(poll);
   console.log(JSON.stringify({status:'SUCCESS',command:{name:'usage',data:{groups:[{name:'unbound fixture'}]}}}));
 },10);
 return;
}
// The sandbox must prevent access to the real login, even when HOME is isolated.
try { fs.readFileSync(path.join(realHome,'.gemini/probe'));process.exit(21); } catch {}
try { fs.writeFileSync(path.join(realHome,'outside'),'unexpected');process.exit(22); } catch {}
try { cp.execFileSync('/usr/bin/security',['help'],{stdio:'pipe'});process.exit(23); } catch {}
if(process.env.GEMINI_API_KEY||process.env.SSH_TTY||process.env.AGY_LLM_GATEWAY_API_KEY)process.exit(24);
if(mode==='access-only'||mode==='access-undated') {
 const auth=JSON.parse(fs.readFileSync(file,'utf8'));
 const keys=mode==='access-undated'?'access_token,token_type':'access_token,expiry,token_type';
 if(!process.argv.includes('/usage')||process.env.AGY_LLM_GATEWAY_API_KEY||
   Object.keys(auth).sort().join()!=='auth_method,id_token_email,token'||
   Object.keys(auth.token).sort().join()!==keys||
   auth.id_token_email!=='readonly@example.test'||auth.token.access_token!=='fixture-readonly'||
   (mode==='access-only'&&!(Date.parse(auth.token.expiry)>Date.now())))process.exit(25);
}
if(process.argv.includes('/usage')) {
 if(mode==='unchanged-usage-failure'&&!JSON.parse(fs.readFileSync(file)).token.refresh_token)process.exit(3);
 if(mode==='login-on-stderr'||mode==='login-on-stdout') {
   const stream=mode==='login-on-stderr'?process.stderr:process.stdout;
   stream.write('Authentication required. Please visit ');
   setTimeout(()=>stream.write('the URL to log in:\\nhttps://example.invalid/private-state\\n'),15);
   setTimeout(()=>process.exit(99),3000);
   return;
 }
 if(mode.startsWith('usage-error-')) {
   console.log(JSON.stringify({status:'ERROR',error:'Eligibility check failed: '+mode.slice('usage-error-'.length)}));
   process.exit(1);
 }
 if(mode==='usage-error')process.exit(3);
 console.log(JSON.stringify({status:'SUCCESS',response:'Authentication required. Please visit the URL to log in:',num_turns:0,command:{name:'usage',data:{groups:[{name:'Gemini Models',buckets:[{id:'g-5h',name:'Five hours',window:'5h',remaining_fraction:.8}]}]}}}));
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
 if(mode==='unchanged-usage-failure')return send({id:msg.id,result:{}});
 if(fs.existsSync(file)&&mode!=='login-after-authenticate') {
  const auth=JSON.parse(fs.readFileSync(file));auth.token.access_token='fixture-rotated';auth.token.expiry='2027-01-01T00:00:00Z';
  if(mode.startsWith('cli-file-')) {delete auth.id_token_email;auth.token.token_type='Bearer';auth.token.expiry=new Date(Date.now()+3600000).toISOString();}
  if(mode==='cli-file-unbound')auth.token.refresh_token='independent-output';
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
const { antigravityAgent: agent, antigravityRenewalHint } = require('../dist/agents/antigravity');
const { antigravityLogin: login } = require('../dist/antigravity-login');
const { refreshAccount, saveAccount, dashboard } = require('../dist/accounts');
afterEach(async () => { await login.cancel(); fs.writeFileSync(behaviorFile, 'normal'); });
async function until(fn) {
  for (let i=0;i<300;i++) { const result=fn();if(result)return result;await new Promise(r=>setTimeout(r,10)); }
  throw new Error('Timed out');
}

test('agy version follows the installed binary and an explicit recheck', { skip: process.platform !== 'darwin' }, t => {
  let reply = 'agy version v1.5.8';
  const probe = t.mock.method(require('node:child_process'), 'spawnSync', (exe, args, opts) => {
    assert.equal(exe, binary); assert.deepEqual(args, ['--version']); assert.ok(opts.timeout > 0);
    return { status: 0, stdout: reply, stderr: '' };
  });
  const status = cli.antigravityCliStatus;
  assert.deepEqual(status(true), { state: 'outdated', version: '1.5.8' });
  reply = '1.5.9'; assert.equal(status().state, 'outdated');
  fs.utimesSync(binary, new Date(), new Date(Date.now() - 2000));
  assert.deepEqual(status(), { state: 'ready', version: '1.5.9' });
  reply = 'unexpected output'; assert.deepEqual(status(true), { state: 'unverified' });
  assert.equal(probe.mock.callCount(), 3);
  probe.mock.restore(); assert.equal(status(true).state, 'ready');
});

test('unsupported ACP and quota arguments stop a stalled CLI without consuming the grant', {
  skip: process.platform !== 'darwin', timeout: 8000,
}, async t => {
  fs.writeFileSync(behaviorFile, 'unsupported-syntax');
  const credential = token('old-cli@example.test'), login = JSON.parse(credential);
  t.after(() => { fs.utimesSync(binary, new Date(), new Date()); cli.antigravityCliStatus(true); });
  const incompatible = e => /agy update/.test(e.message) && !/fixture-private|超时/.test(e.message);
  for (let i = 0; i < 2; i++) {
    const result = await cli.queryIsolatedUsage(credential, login.id_token_email, login.token.refresh_token);
    assert.ok(incompatible(result.error)); assert.equal(result.temporaryDirectory, undefined);
  }
  assert.equal(cli.antigravityCliStatus().state, 'outdated');
  const oldQuery = cli.queryAccessTokenUsage(login.id_token_email, login.token.access_token);
  fs.utimesSync(binary, new Date(), new Date()); // The new fingerprint is ready before the old process reports its error.
  assert.equal(cli.antigravityCliStatus().state, 'ready');
  await assert.rejects(oldQuery, incompatible);
  assert.equal(cli.antigravityCliStatus().state, 'ready');
});

test('shared /usage uses the official login and stays visible as a shared writer', { skip: process.platform !== 'darwin' }, async t => {
  for (const key of ['AGY_ADC_AUTH', 'ANTIGRAVITY_GEMINI_DIR', 'GEMINI_API_KEY', 'SSH_TTY']) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = 'unused-fixture';
  }
  fs.writeFileSync(behaviorFile, 'shared-usage');
  const release = path.join(root, 'shared-finish'), running = path.join(root, 'shared-running');
  const query = cli.querySharedUsage();
  try {
    const { pid, cwd } = await Promise.race([
      until(() => fs.existsSync(running) && JSON.parse(fs.readFileSync(running))),
      query.then(() => assert.fail('official fixture returned too early')),
    ]);
    assert.equal(cli.isolatedCliPids.has(pid), false);
    assert.equal(path.dirname(cwd), fs.realpathSync(os.tmpdir()));
    fs.writeFileSync(release, 'proceed');
    assert.deepEqual(await query, { groups: [{ name: 'unbound fixture' }] });
    assert.equal(fs.existsSync(cwd), false);
  } finally { fs.writeFileSync(release, 'proceed'); }
});

test('a running client reads its own renewed token and never opens a second login when quota fails', { skip: process.platform !== 'darwin' }, async t => {
  const before = live, previous = process.env.AGY_LLM_GATEWAY_API_KEY;
  t.after(() => {
    live = before;
    if (previous === undefined) delete process.env.AGY_LLM_GATEWAY_API_KEY;
    else process.env.AGY_LLM_GATEWAY_API_KEY = previous;
  });
  process.env.AGY_LLM_GATEWAY_API_KEY = 'unused-fixture';
  t.mock.method(require('../dist/clients'), 'runningClients', async () => ['Antigravity']);
  const rotation = t.mock.method(cli, 'queryIsolatedUsage', () => assert.fail('the running client owns this refresh token'));
  const write = t.mock.method(native, 'writeNativeToken');
  const usage = t.mock.method(cli, 'queryAccessTokenUsage');
  const name = 'read-only', account = JSON.parse(token('readonly@example.test'));
  account.id_token = 'fixture-private-field';
  account.token.other = 'fixture-private-field';
  account.expiry = new Date(Date.now() + 3600000).toISOString();
  account.token.expiry = new Date(0).toISOString();
  live = Buffer.from(JSON.stringify(account));
  await saveAccount(agent, name);
  const oldTime = new Date(Date.now() - 86400000).toISOString();
  const history = { fetchedAt: oldTime, checkedAt: oldTime, state: 'unverified', available: true, plan: 'Ultra',
    extra: 'Antigravity 客户端正在运行，暂时没有可用于只读查询的有效访问令牌；客户端续期或关闭后可重试',
    quota: { buckets: [{ id: 'gemini', label: 'Gemini', windows: [{ windowMins: 300, usedPercent: 88 }] }] },
    credentialRevision: credentialState(agent).revision };
  writeProfileMeta('agy', name, { ...readProfileMeta('agy', name), snapshot: history });
  assert.equal(dashboard().find(a => a.id === 'agy').status.extra, antigravityRenewalHint);
  const diagnostics = require('../dist/diagnostics');
  diagnostics.initializeDiagnostics(path.join(root, 'diagnostics'), '1.0.1+source');
  const refresh = force => diagnostics.runDiagnostic('refresh', 'agy', force ? 'manual' : 'automatic', name,
    () => refreshAccount(agent, name, force));
  const paused = await refresh(true);
  assert.equal(paused.state, 'unverified');
  assert.equal(paused.extra, antigravityRenewalHint);
  assert.deepEqual(paused.quota, history.quota);
  assert.equal(paused.fetchedAt, oldTime);
  assert.ok(dashboard().find(a => a.id === 'agy').refreshAt > Date.now());
  assert.equal(usage.mock.callCount(), 0);

  account.token.access_token = 'fixture-readonly';
  delete account.token.expiry;
  const { parseCredentialDocument } = require('../dist/credential-document');
  const renewed = parseCredentialDocument(Buffer.from(JSON.stringify(account)), 'agy').entries[0].data;
  live = renewed;
  fs.writeFileSync(behaviorFile, 'access-only');
  const updated = await refresh(true);
  assert.equal(updated.state, 'ok');
  assert.equal(updated.plan, history.plan);
  assert.equal(Math.round(updated.quota.buckets[0].windows[0].usedPercent), 20);
  assert.ok(Date.parse(updated.fetchedAt) > Date.parse(oldTime));
  assert.equal((await refresh(false)).checkedAt, updated.checkedAt);
  const [waiting, completed, cached] = diagnostics.exportDiagnostics().operations;
  assert.equal(waiting.lastQuotaAt, oldTime);
  assert.deepEqual([waiting, completed, cached].map(op => [op.result, op.steps.map(s => s.step)]), [
    ['waiting', ['live-session', 'read-only', 'access-expired']], ['ok', ['live-session', 'read-only', 'access-valid', 'query-start', 'query-end']], ['cached', ['cached']],
  ]);
  assert.equal(usage.mock.callCount(), 1);
  assert.deepEqual(live, renewed);
  delete account.expiry;
  fs.writeFileSync(behaviorFile, 'access-undated');
  assert.equal((await agent.queryCredential(Buffer.from(JSON.stringify(account)), { allowRefresh: false })).status.state, 'ok');
  t.mock.method(native, 'readSharedQuotaLogin', bytes => bytes);
  const shared = t.mock.method(cli, 'querySharedUsage', () => assert.fail('unexpected shared renewal'));
  for (const [reason, expected] of [['503 Service Unavailable', /暂不可用/], ['no such host', /网络/], ['429', /限制/],
    ['error at https://fixture.invalid/401', /查询失败/], ['401', /未接受/]]) {
    fs.writeFileSync(behaviorFile, 'usage-error-' + reason);
    for (const input of [renewed, Buffer.from(JSON.stringify(account))]) {
      const { status } = await agent.queryCredential(input, { allowRefresh: false, withSharedRenewal: reason !== '401' ? work => work() : undefined });
      assert.equal(status.state, 'error');
      assert.match(status.extra, expected);
      assert.ok(!status.authExpired);
      await assert.rejects(usage.mock.calls.at(-1).result, err => (err instanceof cli.AntigravityAccessRejected) === (reason === '401'));
    }
  }
  for (const mode of ['login-on-stderr', 'login-on-stdout']) {
    fs.writeFileSync(behaviorFile, mode);
    const { status } = await agent.queryCredential(renewed, { allowRefresh: false, withSharedRenewal: work => work() });
    assert.equal(status.state, 'error');
    assert.equal(status.extra, '额度查询未完成，请在 Antigravity 中确认登录状态后重试');
    await assert.rejects(usage.mock.calls.at(-1).result, err => !(err instanceof cli.AntigravityAccessRejected));
    assert.ok(!status.authExpired);
    assert.equal(cli.isolatedCliPids.size, 0);
  }
  account.token.access_token = '   ';
  const incomplete = await agent.queryCredential(Buffer.from(JSON.stringify(account)), { allowRefresh: false });
  assert.equal(incomplete.status.state, 'unverified');
  assert.equal(rotation.mock.callCount(), 0);
  assert.equal(shared.mock.callCount(), 0);
  assert.deepEqual(live, renewed);
  assert.equal(write.mock.callCount(), 0);
});

test('current refresh binds the official renewal to its original login before updating the card', { skip: process.platform !== 'darwin' }, async t => {
  const before = live, readUsage = cli.queryAccessTokenUsage;
  t.after(() => { live = before; });
  t.mock.method(require('../dist/clients'), 'runningClients', async () => ['Antigravity']);
  t.mock.method(native, 'readSharedQuotaLogin', bytes => bytes.equals(live) ? live : undefined);
  t.mock.method(cli, 'queryIsolatedUsage', () => assert.fail('a shared refresh token was copied'));
  const events = [];
  let successor;
  const sharedUsage = { groups: [{ name: 'Gemini', buckets: [{ name: '5h', remaining_fraction: 0.8 }] }] };
  t.mock.method(cli, 'querySharedUsage', async () => { events.push('shared'); live = successor; return sharedUsage; });
  t.mock.method(cli, 'queryAccessTokenUsage', async (email, access, expiry) => {
    events.push(access);
    assert.equal(email, JSON.parse(live).id_token_email);
    if (access === 'undated') throw new cli.AntigravityAccessRejected();
    return readUsage(email, access, expiry);
  });
  for (const initial of ['expired', 'undated', 'external-login', 'unpublished', 'closing']) {
    events.length = 0;
    const name = 'shared-' + initial, auth = JSON.parse(token(name + '@example.test'));
    auth.token.access_token = initial;
    auth.token.expiry = initial === 'undated' ? undefined : new Date(0).toISOString();
    const original = live = Buffer.from(JSON.stringify(auth));
    await saveAccount(agent, name);
    const dir = profileDir(agent.id, name), oldRevision = credentialState(agent, dir).revision;
    if (initial === 'external-login') auth.token.refresh_token = 'different-grant-same-email';
    auth.token.access_token = 'fresh';
    auth.token.expiry = new Date(Date.now() + 3600000).toISOString();
    successor = Buffer.from(JSON.stringify(auth));
    const started = Date.now(), refresh = () => refreshAccount(agent, name, true);
    if (initial === 'closing') {
      const { setCriticalCommitTracker } = require('../dist/accounts');
      const commit = work => work();
      setCriticalCommitTracker(commit, async () => { throw new Error('退出中'); });
      t.after(() => setCriticalCommitTracker(commit));
      assert.equal((await refresh()).extra, '退出中');
      assert.deepEqual(events, []);
      live = successor;
      assert.equal((await refresh()).state, 'ok');
      assert.deepEqual(events, ['fresh']);
      continue;
    }
    if (initial === 'unpublished') {
      const published = successor, background = () => refreshAccount(agent, name, false);
      successor = original;
      const fresh = await background();
      assert.equal(fresh.state, 'ok', 'the confirmed shared CLI returned quota before a bearer was published');
      assert.deepEqual(events, ['shared']);
      assert.equal(fresh.credentialRevision, oldRevision);
      live = published;
      continue;
    }
    if (initial === 'external-login') {
      await assert.rejects(refresh(), require('../dist/credential-state').CredentialChangedError);
      assert.deepEqual(events, ['shared']);
      assert.deepEqual(readCredentialFile(path.join(dir,agent.authFiles[0])), original);
      assert.ok(!readProfileMeta(agent.id, name).snapshot?.fetchedAt);
      continue;
    }
    const result = await refresh(), stored = readProfileMeta(agent.id, name).snapshot;
    assert.equal(result.state, 'ok');
    assert.equal(Math.round(result.quota.buckets[0].windows[0].usedPercent), 20);
    assert.ok(Date.parse(stored.fetchedAt) >= started && stored.fetchedAt === result.fetchedAt);
    assert.notEqual(stored.credentialRevision, oldRevision);
    assert.equal(stored.credentialRevision, credentialState(agent, dir).revision);
    assert.deepEqual(readCredentialFile(path.join(dir, agent.authFiles[0])), successor);
    assert.equal((await refresh()).checkedAt, result.checkedAt);
    assert.deepEqual(events, initial === 'undated' ? ['undated', 'shared'] : ['shared']);
  }
});

test('current quota follows the active desktop file when Keychain is unavailable and rejects a changed source', { skip: process.platform !== 'darwin' }, async t => {
  const file = path.join(root, '.gemini', native.NATIVE_TOKEN_FILE), marker = path.join(root, '.gemini/cache/antigravity-keyring-unavailable');
  const email = 'desktop-file@example.test', name = 'desktop-file', dir = profileDir('agy', name), pool = path.join(dir, agent.authFiles[0]);
  const cred = (refresh, access, remaining, account = email) => Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: account,
    token: { refresh_token: refresh, access_token: access, expiry: new Date(Date.now() + remaining * 60000).toISOString() } }));
  const saved = cred('A', 'pool-A', 90), desktop = cred('B', 'desktop-B', 60);
  atomicWrite(pool, saved); atomicWrite(file, desktop); atomicWrite(marker, '1');
  t.after(() => { for (const path of [file, marker]) fs.rmSync(path, { force: true }); });
  const history = { available: true, state: 'ok', account: email, fetchedAt: '2000-01-01T00:00:00Z', credentialRevision: credentialState(agent, dir).revision,
    quota: { buckets: [{ label: 'Gemini', windows: [{ windowMins: 300, usedPercent: 90 }] }] } };
  writeProfileMeta('agy', name, { email, snapshot: history });
  const activeFile = () => fs.existsSync(marker) ? fs.readFileSync(file) : undefined;
  t.mock.method(native, 'readUnavailableDesktopQuotaFile', activeFile);
  t.mock.method(native, 'readActiveDesktopQuotaFile', activeFile);
  const forbidden = t.mock.fn(() => assert.fail('file quota must not access Keychain or initiate renewal'));
  for (const method of ['readNativeToken', 'writeNativeToken']) t.mock.method(native, method, forbidden);
  for (const method of ['queryIsolatedUsage', 'querySharedUsage']) t.mock.method(cli, method, forbidden);
  t.mock.method(require('../dist/clients'), 'runningClients', async () => []);
  t.mock.method(native, 'sharedAntigravitySessions', async () => []);
  let change;
  const usage = t.mock.method(cli, 'queryAccessTokenUsage', async account => {
    assert.equal(account, email); const action = change; change = undefined; action?.();
    return { groups: [{ name: 'Gemini', buckets: [{ id: 'g', remaining_fraction: 0.8 }] }] };
  });
  const panel = () => dashboard().find(a => a.id === 'agy').status;
  const refresh = () => refreshAccount(agent, undefined, true);
  assert.equal(panel().account, email); assert.equal(panel().quota, undefined);
  const first = await refresh();
  assert.equal(first.state, 'ok'); assert.ok(first.fetchedAt); assert.equal(panel().fetchedAt, first.fetchedAt);
  for (const [i, disconnect] of [() => fs.unlinkSync(marker), () => atomicWrite(file, cred('C', 'other', 60, 'other@example.test')),
    () => atomicWrite(file, cred('C', 'new-independent-grant', 60))].entries()) {
    atomicWrite(marker, '1'); atomicWrite(file, cred('B', 'during-change-' + i, 60)); change = disconnect;
    await assert.rejects(refresh(), require('../dist/credential-state').CredentialChangedError);
  }
  change = undefined; atomicWrite(marker, '1'); atomicWrite(file, cred('B', 'expired-B', -60));
  assert.notEqual((await refresh()).state, 'ok');
  assert.deepEqual(usage.mock.calls.map(call => call.arguments[1]), ['desktop-B', 'during-change-0', 'during-change-1', 'during-change-2']);
  assert.deepEqual(readCredentialFile(pool), saved); assert.deepEqual(readProfileMeta('agy', name).snapshot, history);
  // Only the same grant may borrow the pool's published bearer.
  atomicWrite(file, cred('A', undefined, -60));
  assert.equal((await refresh()).state, 'ok');
  assert.equal(usage.mock.calls.at(-1).arguments[1], 'pool-A');
  assert.equal(forbidden.mock.callCount(), 0);
});

test('isolated CLI returns email-less personal credentials and the next refresh recovers only the confirmed grant', {skip:process.platform!=='darwin'}, async () => {
  const before=live, email='b@example.test', original=token(email);
  const dir=profileDir('agy','B'), file=path.join(dir,agent.authFiles[0]);
  atomicWrite(file,original);
  fs.writeFileSync(behaviorFile,'cli-file-same');
  const query=await agent.queryCredential(original);
  assert.equal(query.status.state,'ok');assert.equal(query.status.plan,'Google AI Pro');
  assert.equal(JSON.parse(query.rotated).id_token_email,email);
  // The isolated CLI completed, but the process stopped before committing the pool copy.
  assert.deepEqual(readCredentialFile(file),original);
  const result=await refreshAccount(agent,'B',true);
  assert.equal(result.state,'ok');assert.equal(result.account,email);
  assert.equal(result.quota.buckets[0].windows[0].windowMins,300);
  assert.deepEqual(readCredentialFile(file),query.rotated);
  assert.equal(JSON.parse(readCredentialFile(file)).token.access_token,'fixture-rotated');
  assert.equal(fs.existsSync(query.temporaryDirectory),false);
  assert.deepEqual(live,before);assert.equal(fs.existsSync(path.join(root,'outside')),false);
  assert.equal(dashboard().find(a=>a.id==='agy').profiles.find(p=>p.name==='B').meta.snapshot.state,'ok');
  const anonymous=JSON.parse(token('archived-grant@example.test'));
  delete anonymous.id_token_email;
  const archived=path.join(profileDir('agy','archived-grant'),agent.authFiles[0]);
  atomicWrite(archived,JSON.stringify(anonymous));
  const checked=await refreshAccount(agent,'archived-grant',true);
  assert.equal(checked.state,'ok');assert.equal(checked.account,undefined);
  assert.equal(JSON.parse(readCredentialFile(archived)).token.access_token,'fixture-rotated');
  assert.equal(cli.isolatedCliPids.size,0);
});

test('an email-less output with a different grant retains the isolated evidence and original account', {skip:process.platform!=='darwin'}, async () => {
  const auth=JSON.parse(token('unbound@example.test'));auth.token.expiry='2000-01-01T00:00:00Z';
  const original=Buffer.from(JSON.stringify(auth)), file=path.join(profileDir('agy','unbound-output'),agent.authFiles[0]);
  atomicWrite(file,original);fs.writeFileSync(behaviorFile,'cli-file-unbound');
  const previous=await cli.queryIsolatedUsage(original,'unbound@example.test',JSON.parse(original).token.refresh_token);
  assert.ok(previous.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(cli.cliTokenPath(previous.temporaryDirectory))).token.refresh_token,'independent-output');
  const retry=await refreshAccount(agent,'unbound-output',true);
  assert.equal(retry.authFailure,'quota-recovery-required');
  assert.deepEqual(readCredentialFile(file),original);
  assert.ok(fs.existsSync(previous.temporaryDirectory));
});

test('a cached spare bearer rejected early renews once and writes only its own saved login', { skip: process.platform !== 'darwin' }, async t => {
  const name = 'rejected-spare', email = 'rejected-spare@example.test', dir = profileDir('agy', name);
  const auth = JSON.parse(token(email));
  auth.token.expiry = new Date(Date.now() + 3600000).toISOString();
  const original = Buffer.from(JSON.stringify(auth)), file = path.join(dir, agent.authFiles[0]);
  atomicWrite(file, original);
  const history = { available: true, state: 'ok', account: email, plan: 'Google AI Pro', credentialRevision: credentialState(agent, dir).revision };
  require('../dist/store').writeProfileMeta('agy', name, { email, snapshot: history });
  const before = live;
  const next = Buffer.from(JSON.stringify({ ...auth, token: { ...auth.token, refresh_token: 'rotated-spare' } }));
  const usage = { groups: [{ name: 'Gemini', buckets: [{ name: 'weekly', remaining_fraction: 0.6 }] }] };
  const rejected = t.mock.method(cli, 'queryAccessTokenUsage', async () => { throw new cli.AntigravityAccessRejected(); });
  const renewal = t.mock.method(cli, 'queryIsolatedUsage', async () => ({ data: usage, rotated: next, plan: history.plan }));
  assert.equal((await refreshAccount(agent, name, true)).state, 'ok');
  assert.deepEqual(readCredentialFile(file), next);
  assert.deepEqual(live, before);
  assert.equal(rejected.mock.callCount(), 1); assert.equal(renewal.mock.callCount(), 1);
});

test('refreshing the current login commits rotation through Keychain even when usage fails', {skip:process.platform!=='darwin'}, async t => {
  t.mock.method(require('../dist/clients'), 'runningClients', async () => []);
  t.mock.method(native, 'sharedAntigravitySessions', async () => []);
  const before = live;
  try {
    live = token('current@example.test');
    fs.writeFileSync(behaviorFile, 'usage-error');
    const result = await refreshAccount(agent, undefined, true);
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
  const usable=JSON.parse(original);usable.token.expiry=new Date(Date.now()+3600000).toISOString();
  fs.writeFileSync(behaviorFile,'unchanged-usage-failure');
  const afterAuth=await agent.queryCredential(Buffer.from(JSON.stringify(usable)));
  assert.equal(afterAuth.status.state,'error');assert.match(afterAuth.status.extra,/额度查询失败/);
  assert.equal(afterAuth.temporaryDirectory,undefined);
  // The real CLI can open the login flow after a failed token exchange without reporting invalid_grant.
  fs.writeFileSync(behaviorFile,'login-after-authenticate');
  await assert.rejects(agent.queryCredential(original), /无法确认上次续期的结果/);
  await assert.rejects(agent.queryCredential(original), error => error.diagnostic === 'recovery-writer');
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
