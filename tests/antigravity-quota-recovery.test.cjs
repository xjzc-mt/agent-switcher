const { installMockKeychain } = require('./helpers/test-env.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-quota-recovery-'));
const home = path.join(sandbox, 'home'), temporary = path.join(sandbox, 'tmp');
fs.mkdirSync(home); fs.mkdirSync(temporary);
os.homedir = () => home; os.tmpdir = () => temporary;
installMockKeychain();
const { AntigravityAgent } = require('../dist/agents/antigravity');
const accounts = require('../dist/accounts');
const { refreshAccount, credentialUpdateTarget, useAccount, prepareSwitchTarget } = accounts;
const { profileDir, clearActiveProfile } = require('../dist/store');
const { exportBackup, parseBackup, installBackup } = require('../dist/backup');
const cli = require('../dist/antigravity-cli');
const { recoverAntigravityQuota } = require('../dist/antigravity-quota-recovery');
const agent = new AntigravityAgent(() => 'unified', true, () => ({ state: 'ready' }));
const macOS = { skip: process.platform !== 'darwin' };
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function credential(email, token, expiry) {
  return Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: email,
    token: { access_token: 'access-' + token, refresh_token: token, expiry } }));
}

// Simulate a previous 1.0.1 process. Its marker contains only the original identity/token fingerprint.
function interrupted(email, token, output) {
  const program = `
    const [home,tmp,modulePath,email,token,output] = process.argv.slice(1);
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
    os.homedir=()=>home; os.tmpdir=()=>tmp;
    const api=require(modulePath), dir=api.createTemporaryCredentials('agy-quota');
    api.markTemporaryCredentialsPending(dir,email,token);
    if(output) {
      const file=path.join(dir,'.gemini','antigravity-cli','antigravity-oauth-token');
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      api.withTemporaryProcess(dir,()=>cp.spawnSync(process.execPath,['-e',''],{detached:true}));
      fs.writeFileSync(file,output,{mode:0o600});
    }
    process.stdout.write(dir);`;
  const result = spawnSync(process.execPath, ['-e', program, home, temporary, require.resolve('../dist/temporary-credentials'),
    email, token, output?.toString() || ''], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('a spare resumes a 1.0.1 rotation after restart, even if the first pool commit fails', macOS, async t => {
  const email = 'spare@example.test', expires = when => new Date(Date.now() + when).toISOString();
  const original = credential(email, 'old', expires(-60000)), next = credential(email, 'renewed', expires(60000));
  const dir = profileDir('agy','spare'), file = agent.authFiles[0];
  const put = bytes => agent.writeCredentials(dir, { [file]: bytes });
  put(original);
  const pending = interrupted(email, 'old', next);
  const writer = t.mock.method(agent, 'writeCredentials', () => { throw new Error('fixture write failed'); });
  await assert.rejects(refreshAccount(agent, 'spare', true), /fixture write failed/);
  assert.deepEqual(agent.readCredentials(dir)[file], original);
  assert.deepEqual(fs.readFileSync(cli.cliTokenPath(pending)), next);
  writer.mock.restore();
  fs.writeFileSync(cli.cliTokenPath(pending), credential(email,'unexpected',expires(90000)));
  assert.throws(() => recoverAntigravityQuota(email,original,{
    read: () => agent.readCredentials(dir)[file], write: () => assert.fail('stored a replaced output'),
  }), /无法确认/);
  fs.writeFileSync(cli.cliTokenPath(pending), next);
  t.mock.method(cli, 'queryIsolatedUsage', () => assert.fail('replayed old refresh token'));
  t.mock.method(cli, 'queryAccessTokenUsage', async (observed, bearer) => {
    assert.equal(observed,email); assert.equal(bearer,'access-renewed');
    assert.deepEqual(agent.readCredentials(dir)[file], next);
    return { groups:[{name:'Gemini',buckets:[{id:'g',remaining_fraction:0.8}]}] };
  });
  assert.equal((await refreshAccount(agent,'spare',true)).state,'ok');
  assert.equal(fs.existsSync(pending),false);
});

test('a sealed email transition recovers after the pool write and loss of the CLI home', macOS, () => {
  const lifecycle = require('../dist/temporary-credentials');
  const { bindNativeTokenIdentity, nativeTokenIdentity, parseNativeToken } = require('../dist/antigravity-native');
  for (const gained of [false, true]) {
    const email = 'receipt@example.test', grant = 'receipt-' + gained;
    const input = credential(gained ? undefined : email, grant, '2000-01-01T00:00:00Z');
    const raw = credential(gained ? email : undefined, grant, '2030-01-01T00:00:00Z');
    const before = parseNativeToken(input), id = nativeTokenIdentity(before);
    const stored = bindNativeTokenIdentity(raw, before);
    const directory = lifecycle.createTemporaryCredentials('agy-quota');
    lifecycle.markTemporaryCredentialsPending(directory, id, grant, input);
    lifecycle.withTemporaryProcess(directory, () => spawnSync(process.execPath, ['-e',''], { detached:true }));
    lifecycle.recordAntigravityQuotaOutput(directory, id, raw, stored);
    fs.rmSync(directory, { recursive:true });
    const result = recoverAntigravityQuota(email, stored, {
      read: () => stored, write: () => assert.fail('the pool already contains the confirmed output'),
    });
    assert.equal(result.pending, true);
    assert.deepEqual(result.bytes, stored);
    assert.equal(lifecycle.pendingAntigravityQuota(email, grant, stored), undefined);
  }
});

test('a marker before launch is recoverable; a launched query with no provable output retains its input', macOS, async t => {
  const email='marker@example.test', original=credential(email,'input','2000-01-01T00:00:00Z');
  const dir=profileDir('agy','marker'), file=agent.authFiles[0];
  agent.writeCredentials(dir,{[file]:original});
  const empty=interrupted(email,'input');
  const renew=t.mock.method(cli,'queryIsolatedUsage',async () => ({ rotated:original,
    data:{groups:[{name:'Gemini',buckets:[{id:'g',remaining_fraction:0.5}]}]} }));
  assert.equal((await refreshAccount(agent,'marker',true)).state,'ok');
  assert.equal(fs.existsSync(empty),false);
  const unresolved=interrupted(email,'input',original);
  const blocked=await refreshAccount(agent,'marker',true);
  assert.equal(blocked.authFailure,'quota-recovery-required');
  assert.equal(blocked.authExpired,undefined);
  assert.ok(credentialUpdateTarget(agent,'marker'));
  assert.equal(renew.mock.callCount(),1);
  assert.deepEqual(fs.readFileSync(cli.cliTokenPath(unresolved)),original);
  const marker=path.join(unresolved,'.ags-temporary-owner.json'), owner=JSON.parse(fs.readFileSync(marker));
  for(const override of [{pid:process.pid},{launching:true}]) {
    fs.writeFileSync(marker,JSON.stringify({...owner,...override}));
    assert.throws(()=>recoverAntigravityQuota(email,original,{read:()=>original,write:()=>assert.fail()}),
      error=>error.needsAuthorization===true);
  }
});

test('an unconfirmed spare whose bearer expires during a refresh cannot start a renewal',macOS,async t=>{
  const email='border@example.test', original=credential(email,'still-pending',new Date(Date.now()+90000).toISOString());
  agent.writeCredentials(profileDir('agy','border'),{[agent.authFiles[0]]:original});
  const pending=interrupted(email,'still-pending',original);
  const native=require('../dist/antigravity-native'), find=native.findQuotaBearer;
  let lookups=0;
  t.mock.method(native,'findQuotaBearer',(...args)=>++lookups===1?find(...args):undefined);
  t.mock.method(cli,'queryIsolatedUsage',()=>assert.fail('expired bearer allowed a second renewal'));
  const result=await refreshAccount(agent,'border',true);
  assert.equal(result.authFailure,'quota-recovery-required');
  native.findQuotaBearer.mock.restore();
  t.mock.method(accounts, 'resolveAgent', () => agent);
  await assert.rejects(prepareSwitchTarget(agent,'border'), /「border」.*无法确认/);
  await assert.rejects(useAccount(agent,'border'), /「border」.*无法确认/);
  await assert.rejects(exportBackup([{ agent:'agy',profile:'border' }], 'sample-pass'), /「border」.*无法确认/);
  assert.ok(fs.existsSync(pending));
});

test('switch and backup each recover the same successor on first use, including a waiting switch', macOS, async t => {
  const native = require('../dist/antigravity-native'), file = agent.authFiles[0];
  let live = null;
  t.mock.method(accounts, 'resolveAgent', () => agent);
  t.mock.method(require('../dist/clients'), 'runningClients', async () => []);
  t.mock.method(native, 'sharedAntigravitySessions', async () => []);
  t.mock.method(native, 'readNativeToken', () => live);
  t.mock.method(native, 'writeNativeToken', bytes => { live = bytes; });
  t.mock.method(agent, 'auxiliaryCredentials', () => []);
  t.mock.method(agent, 'switchFingerprint', () => undefined);
  t.mock.method(agent, 'recoverInterruptedSwitch', async () => {});
  t.mock.method(native, 'createNativeMutationJournal', () => undefined);
  const save = (profile, bytes) => agent.writeCredentials(profileDir('agy', profile), { [file]: bytes });
  const exportOne = async profile => {
    const data = await exportBackup([{ agent: 'agy', profile }], 'sample-password');
    return parseBackup(data, 'sample-password');
  };
  for (const operation of ['switch', 'export']) {
    const profile = 'first-' + operation, email = profile + '@example.test';
    const original = credential(email, 'old', '2000-01-01T00:00:00Z');
    const next = credential(email, 'successor', '2090-01-01T00:00:00Z');
    const other = credential(email, 'independent', operation === 'switch' ? '2001-01-01T00:00:00Z' : '2100-01-01T00:00:00Z');
    const alias = Buffer.from(JSON.stringify(JSON.parse(original), null, 2));
    save(profile, original); save(profile + '-alias', alias); save(profile + '-other', other);
    const directory = interrupted(email, 'old', next);
    let archive;
    if (operation === 'switch') {
      const checkMigration = t.mock.method(agent, 'needsFileMigration', bytes => bytes.equals(next));
      assert.equal((await accounts.previewTraySwitch(agent, profile)).state.migration, true);
      assert.deepEqual(agent.credentials(profileDir('agy', profile))[file], original);
      assert.deepEqual(agent.credentials(profileDir('agy', profile + '-alias'))[file], alias);
      assert.ok(fs.existsSync(directory));
      checkMigration.mock.restore();
      await useAccount(agent, profile);
      assert.deepEqual(live, next);
    } else archive = await exportOne(profile);
    assert.deepEqual(agent.credentials(profileDir('agy', profile + '-alias'))[file], next);
    assert.deepEqual(agent.credentials(profileDir('agy', profile + '-other'))[file], other);
    assert.ok(!fs.existsSync(directory));
    if (archive) {
      const pool = path.dirname(profileDir('agy', profile)), previous = path.join(sandbox, 'original-pool');
      assert.ok(pool.startsWith(home + path.sep));
      fs.renameSync(pool, previous);
      try {
        const key = 'agy/' + profile;
        assert.deepEqual((await installBackup(archive, [key])).imported, [key]);
        assert.deepEqual(agent.credentials(profileDir('agy', profile))[file], next);
        save(profile, other);
        assert.equal((await installBackup(archive, [key])).skipped.length, 1);
        assert.deepEqual(agent.credentials(profileDir('agy', profile))[file], other);
      } finally {
        fs.rmSync(pool, { recursive:true, force:true });
        fs.renameSync(previous, pool);
      }
    }
  }
  const profile = 'pending-switch', email = profile + '@example.test';
  const original = credential(email, 'old', '2000-01-01T00:00:00Z');
  const next = credential(email, 'after-query', '2090-01-01T00:00:00Z');
  save(profile, original);
  const started = Promise.withResolvers(), gate = Promise.withResolvers();
  t.mock.method(cli, 'queryIsolatedUsage', async () => {
    started.resolve(); await gate.promise;
    return { rotated: next, data: { groups: [{ name: 'Gemini', buckets: [{ id: 'g', remaining_fraction: 0.5 }] }] } };
  });
  const query = refreshAccount(agent, profile, true);
  await started.promise;
  const preview = accounts.previewTraySwitch(agent, profile);
  gate.resolve();
  const [, { state, recheck }] = await Promise.all([query, preview]);
  await useAccount(agent, profile, { recheckConfirmation: recheck, expectedCurrentRevision: state.currentRevision });
  assert.deepEqual(live, next);
  assert.equal(JSON.parse(agent.credentials(profileDir('agy', 'first-switch-other'))[file]).token.refresh_token, 'independent');

  // A newer bearer of this same official login can be exported without changing the client.
  const updated = JSON.parse(next);
  updated.token.access_token = 'official-new-access';
  updated.token.expiry = '2091-01-01T00:00:00Z';
  live = Buffer.from(JSON.stringify(updated));
  // The current identity comes from the desktop even when AGS has no active preference.
  clearActiveProfile('agy');
  assert.deepEqual((await exportOne(profile)).groups.get('agy/' + profile).get(file), live);
  await useAccount(agent, 'first-switch');
  assert.deepEqual(live, credential('first-switch@example.test', 'successor', '2090-01-01T00:00:00Z'));
});

test('a running spare query holds off save, trusted re-login and backup replacement until commit', macOS, async t => {
  const providers = accounts.ALL_AGENTS.splice(0, accounts.ALL_AGENTS.length, agent);
  t.after(() => accounts.ALL_AGENTS.splice(0, 1, ...providers));
  const store = require('../dist/store'), file = agent.authFiles[0];
  const native = require('../dist/antigravity-native');
  t.mock.method(native, 'readNativeToken', () => null);
  t.mock.method(native, 'sharedAntigravitySessions', async () => []);
  t.mock.method(require('../dist/clients'), 'runningClients', async () => []);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const action of ['save','update','backup']) {
    const profile = 'waiting-' + action, email = profile + '@example.test';
    const original = credential(email, 'old', '2000-01-01T00:00:00Z');
    const fresh = credential(email, 'new', '2090-01-01T00:00:00Z'), files = { [file]: fresh };
    agent.writeCredentials(profileDir('agy',profile), { [file]: original });
    const failure = { available:true, state:'error', authFailure:'authentication-rejected' };
    store.writeProfileMeta('agy',profile,{snapshot:failure});
    const target = accounts.credentialUpdateTarget(agent,profile);
    const key = 'agy/' + profile;
    if (action === 'save') agent.writeCredentials(await accounts.prepareLogin(agent), files);
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const rpc = t.mock.method(agent,'queryCredential', async () => { started.resolve(); await release.promise; return {status:{...failure}}; });
    const refresh = refreshAccount(agent,profile,true);
    await started.promise;
    let completed = false;
    const update = (action === 'save' ? accounts.saveAccount(agent, profile) :
      action === 'update' ? accounts.updateAccountCredentials(target,files,undefined,{trusted:true}) :
      installBackup({groups:new Map([[key,new Map([[file,fresh]])]]),items:[{key,agent:'agy',profile}]},[key]))
      .finally(() => { completed=true; });
    try {
      t.mock.timers.tick(30000); // A normal ACP operation can outlast the short store lock budget.
      await new Promise(resolve=>setTimeout(resolve,120));
      assert.equal(completed,false,action);
      assert.deepEqual(agent.readCredentials(profileDir('agy',profile))[file],original);
    } finally { release.resolve(); }
    await Promise.all([refresh, update]);
    const committed = action === 'backup' ? require('../dist/utils').readBuffer(path.join(profileDir('agy',profile),file+'.pending'))
      : agent.readCredentials(profileDir('agy',profile))[file];
    assert.deepEqual(committed,fresh);
    rpc.mock.restore();
  }
});

test('trusted re-login and final removal dispose only superseded recovery files with proven stopped writers', macOS, async t => {
  const providers = accounts.ALL_AGENTS.splice(0, accounts.ALL_AGENTS.length, agent);
  t.after(() => accounts.ALL_AGENTS.splice(0, 1, ...providers));
  const store = require('../dist/store'), lifecycle = require('../dist/temporary-credentials');
  const native = require('../dist/antigravity-native'), file = agent.authFiles[0];
  t.mock.method(native,'readNativeToken',()=>null);
  for (const action of ['replace','remove','alias','writer']) {
    const profile='retire-'+action, email=profile+'@example.test', old=credential(email,'old','2000-01-01T00:00:00Z');
    agent.writeCredentials(profileDir('agy',profile),{[file]:old});
    store.writeProfileMeta('agy',profile,{snapshot:{available:true,state:'error',authFailure:'quota-recovery-required'}});
    const before = new Set(fs.readdirSync(store.STORE_DIR));
    const dir = lifecycle.createTemporaryCredentials('agy-quota');
    lifecycle.markTemporaryCredentialsPending(dir,email,'old',old);
    lifecycle.withTemporaryProcess(dir,()=>spawnSync(process.execPath,['-e',''],{detached:true}));
    const intent = fs.readdirSync(store.STORE_DIR).find(name=>!before.has(name)&&name.startsWith('.antigravity-quota-'));
    assert.ok(intent);
    const marker = path.join(dir,'.ags-temporary-owner.json');
    if (action==='writer') fs.writeFileSync(marker,JSON.stringify({...JSON.parse(fs.readFileSync(marker)),launching:true}));
    if (action==='alias') agent.writeCredentials(profileDir('agy',profile+'-copy'),{[file]:old});
    if(action==='remove') await accounts.removeAccount(agent,profile);
    else await accounts.updateAccountCredentials(accounts.credentialUpdateTarget(agent,profile),
      {[file]:credential(email,'new','2090-01-01T00:00:00Z')},undefined,{trusted:true});
    const retain=action==='alias'||action==='writer';
    assert.equal(fs.existsSync(dir),retain,action);
    assert.equal(fs.existsSync(path.join(store.STORE_DIR,intent)),retain,action);
  }
});
