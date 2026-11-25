const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const active = 'active@example.test', spare = 'spare@example.test';

if (process.argv[2] === 'abandon-launch') {
  const root = process.argv[3], original = fs.readFileSync(0);
  os.homedir = os.tmpdir = () => root;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  require('../dist/antigravity-windows').createPrivateWindowsQuotaDirectory = dir => fs.mkdirSync(dir, { mode: 0o700 });
  require('../dist/credential-vault').setCredentialKeyProvider({ read: () => Buffer.alloc(32, 6) });
  const temp = require('../dist/temporary-credentials'), directory = temp.createTemporaryCredentials('agy-quota');
  temp.markTemporaryCredentialsPending(directory, spare, 'initial-' + spare, original);
  const child = temp.withTemporaryProcess(directory, () => spawnSync(process.execPath,
    [__filename, 'agy-fixture', 'isolated', directory, '', 'launch-failed']));
  assert.equal(child.status, 124); process.stdout.write(directory); // Exit before AGS handles the drain receipt.
} else if (process.argv[2] === 'agy-fixture') {
  const [, , , scope, root, nativeFile, mode] = process.argv;
  const file = scope === 'shared' ? nativeFile : path.join(root, 'cli-home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  if (scope === 'isolated') process.on('exit', code => fs.writeFileSync(path.join(root, '.ags-win-drained-' + process.pid), String(code)));
  if (mode === 'launch-failed') process.exit(124);
  const auth = JSON.parse(fs.readFileSync(file, 'utf8')), email = auth.id_token_email;
  function renew() {
    assert.equal(auth.token.refresh_token, 'initial-' + email);
    assert.ok(Date.parse(auth.token.expiry) < Date.now());
    auth.token.access_token = 'fresh-' + email;
    auth.token.expiry = new Date(Date.now() + 3600000).toISOString();
    if (email === spare) auth.token.refresh_token = 'rotated-' + email;
    fs.writeFileSync(file, JSON.stringify(auth));
  }
  if (mode === 'acp') {
    assert.equal(scope, 'isolated'); assert.equal(email, spare);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method } = JSON.parse(line);
      if (method === 'authenticate') renew(); else assert.equal(method, 'initialize');
      process.stdout.write(JSON.stringify({ id, result: { _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } } }) + '\n');
    });
  } else {
    assert.equal(mode, '/usage');
    if (scope === 'shared') { assert.equal(email, active); renew(); }
    else { assert.equal(auth.token.refresh_token, undefined); assert.equal(auth.token.access_token, 'fresh-' + email); }
    const remaining = scope === 'shared' ? 0 : email === active ? 0.75 : 0.5;
    console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [
      { id: '5h', name: '5h', window: '5h', remaining_fraction: remaining },
    ] }] } } }));
  }
} else require('node:test').test('Windows imports Mac Antigravity accounts, renews the active login with the desktop open, and rotates the spare privately', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ags-agy-portable-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root); t.mock.method(os, 'tmpdir', () => root);
  process.env.LOCALAPPDATA = path.join(root, 'LocalAppData');
  const binary = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fixture');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const as = value => Object.defineProperty(process, 'platform', { ...platform, value });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  as('win32');
  const vault = require('../dist/credential-vault');
  const { atomicWrite, readBuffer } = require('../dist/utils'), store = require('../dist/store');
  const { antigravityAgent: agent } = require('../dist/agents/antigravity');
  const accounts = require('../dist/accounts'), backup = require('../dist/backup');
  const windows = require('../dist/antigravity-windows'), procs = require('../dist/windows-processes');
  const nativeFile = path.join(root, 'synthetic-wincred');
  const osRecord = () => fs.existsSync(nativeFile) ? { data: fs.readFileSync(nativeFile).toString('base64'), revision: '0000000000000001' } : { data: null };
  t.mock.method(windows, 'readWindowsCredential', osRecord);
  t.mock.method(windows, 'replaceWindowsCredential', (before, bytes) => {
    assert.deepEqual(before.data, osRecord().data);
    if (bytes) fs.writeFileSync(nativeFile, bytes); else fs.rmSync(nativeFile, { force: true });
  });
  t.mock.method(windows, 'createPrivateWindowsQuotaDirectory', dir => fs.mkdirSync(dir, { mode: 0o700 }));
  t.mock.method(windows, 'trustedWindowsQuotaDirectory', dir => dir.startsWith(root + path.sep));
  t.mock.method(procs, 'windowsAntigravitySessions', async () => []);
  let desktop = false;
  t.mock.method(require('../dist/windows-desktop'), 'runningWindowsClients', async () => desktop ? ['Antigravity'] : []);
  const calls = [];
  let launchAvailable = false;
  t.mock.method(require('../dist/windows-usage'), 'windowsUsageLaunch', (exe, args, dir, isolated) => {
    assert.equal(exe, binary);
    const scope = isolated ? 'isolated' : 'shared', mode = args.includes('/usage') ? '/usage' : launchAvailable ? args[0] : 'launch-failed';
    calls.push([scope, mode]);
    return { command: process.execPath, args: [__filename, 'agy-fixture', scope, dir, nativeFile, mode],
      options: { cwd: dir, env: { SystemRoot: process.env.SystemRoot } } };
  });
  const nameOf = email => email.split('@')[0], fileOf = email => path.join(store.profileDir('agy', nameOf(email)), agent.authFiles[0]);
  vault.setCredentialKeyProvider({ read: () => Buffer.alloc(32, 5) });
  const noMacLogin = t.mock.method(agent, 'readSwitchableCredentials', () => ({ files: { [agent.authFiles[0]]: null } }));
  const selections = [active, spare].map(email => {
    atomicWrite(fileOf(email), JSON.stringify({ auth_method: 'consumer', id_token_email: email,
      token: { access_token: 'stale-' + email, refresh_token: 'initial-' + email, expiry: new Date(0).toISOString() } }));
    return { agent: 'agy', profile: nameOf(email) };
  });
  as('darwin'); // Exercise Mac export without asking an actual Windows filesystem to fsync a POSIX directory.
  const archive = await backup.exportBackup(selections, 'fixture-password');
  noMacLogin.mock.restore(); fs.rmSync(store.STORE_DIR, { recursive: true });
  as('win32'); vault.setCredentialKeyProvider({ read: () => Buffer.alloc(32, 6) });
  const parsed = await backup.parseBackup(archive, 'fixture-password');
  const installed = await backup.installBackup(parsed, parsed.items.map(item => item.key));
  assert.deepEqual(installed.imported.sort(), ['agy/active', 'agy/spare']);
  await accounts.useAccount(agent, nameOf(active));
  desktop = true;
  const beforeSpare = readBuffer(fileOf(spare));
  let renewedActive, abandoned;
  for (const [email, used] of [[active, 25], [spare, 50]]) {
    if (email === spare) {
      const blocked = await accounts.refreshAccount(agent, nameOf(spare), true);
      assert.equal(blocked.state, 'error'); assert.match(blocked.extra, /未能启动隔离/);
      assert.deepEqual(readBuffer(fileOf(spare)), beforeSpare);
      assert.ok(!fs.readdirSync(store.STORE_DIR).some(name => name.startsWith('.antigravity-quota-')));
      assert.ok(!blocked.refreshConsumed);
      const stopped = spawnSync(process.execPath, [__filename, 'abandon-launch', root], { input: beforeSpare, encoding: 'utf8' });
      assert.equal(stopped.status, 0, stopped.stderr); abandoned = stopped.stdout;
      assert.ok(fs.existsSync(abandoned));
      const retryAt = Date.parse(blocked.checkedAt) + require('../dist/quota-refresh').MIN_REFRESH_INTERVAL_MS + 1;
      t.mock.method(Date, 'now', () => retryAt);
      launchAvailable = true;
    }
    const status = await accounts.refreshAccount(agent, nameOf(email), true);
    assert.equal(status.state, 'ok', status.extra); assert.equal(status.account, email);
    assert.equal(status.quota.buckets[0].windows[0].usedPercent, used);
    assert.equal(JSON.parse(readBuffer(fileOf(email))).token.access_token, 'fresh-' + email);
    assert.equal(fs.readFileSync(fileOf(email)).includes(Buffer.from('fresh-' + email)), false);
    if (email === active) {
      assert.deepEqual(readBuffer(fileOf(spare)), beforeSpare);
      renewedActive = readBuffer(fileOf(active));
    }
    assert.deepEqual(readBuffer(fileOf(active)), renewedActive);
    assert.deepEqual(fs.readFileSync(nativeFile), renewedActive);
  }
  assert.equal(JSON.parse(readBuffer(fileOf(spare))).token.refresh_token, 'rotated-' + spare);
  assert.equal(fs.existsSync(abandoned), false);
  assert.deepEqual(calls, [['shared','/usage'], ['isolated','/usage'], ['isolated','launch-failed'], ['isolated','acp'], ['isolated','/usage']]);
  for (const dir of fs.readdirSync(root).filter(name => name.startsWith('agent-switcher-'))) assert.deepEqual(fs.readdirSync(path.join(root, dir)), []);
  assert.ok(!fs.readdirSync(store.STORE_DIR).some(name => name.startsWith('.antigravity-quota-')));
});
