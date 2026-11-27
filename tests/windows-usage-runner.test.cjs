const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');

test('Windows isolated quota stages only public CA material and inherits the configured proxies without forcing a route', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-proxy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(require('../dist/windows-helper'), 'windowsHelper', () => 'fixture-helper');
  const { windowsUsageLaunch, windowsUsageHome } = require('../dist/windows-usage');
  const cert = require('node:tls').rootCertificates[0], bundle = path.join(dir, 'user-bundle.pem');
  fs.writeFileSync(bundle, cert + '\n-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----');
  const sources = path.join(dir, 'user-certs');
  fs.mkdirSync(sources); fs.writeFileSync(path.join(sources, '1234abcd.0'), cert);
  fs.writeFileSync(path.join(sources, 'user-key.pem'), '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----');
  const settings = { https_proxy: 'http://192.168.1.2:8080', SSL_CERT_FILE: bundle, SSL_CERT_DIR: sources };
  const launch = (isolated, env) => windowsUsageLaunch('agy.exe', ['-p', '/usage'], dir, isolated, env).options.env;
  const env = launch(true, settings);
  assert.equal(env.HTTPS_PROXY, settings.https_proxy);
  assert.deepEqual(fs.readdirSync(env.SSL_CERT_DIR), ['1234abcd.0']);
  for (const file of [env.SSL_CERT_FILE, path.join(env.SSL_CERT_DIR, '1234abcd.0')]) {
    assert.ok(file.startsWith(windowsUsageHome(dir) + path.sep));
    const data = fs.readFileSync(file, 'utf8');
    assert.equal(new crypto.X509Certificate(data).fingerprint256, new crypto.X509Certificate(cert).fingerprint256);
    assert.equal(data.includes('PRIVATE KEY'), false);
  }
  assert.equal(launch(false, settings).SSL_CERT_FILE, bundle);
  const proxy = 'http://127.0.0.1:7890', bypass = 'localhost,.googleapis.com';
  const loopback = launch(true, { HTTPS_PROXY: proxy, NO_PROXY: bypass });
  assert.equal(loopback.HTTPS_PROXY, proxy); assert.equal(loopback.NO_PROXY, bypass);
  assert.equal(launch(true, { ALL_PROXY: proxy }).HTTPS_PROXY, undefined);
});

test('Windows ACP cancellation drains the supervisor and old TEMP recovery still protects the grant', { timeout: 6000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ags-stop-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root); t.mock.method(os, 'tmpdir', () => root);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const local = process.env.LOCALAPPDATA;
  t.after(() => { if (local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = local; });
  delete process.env.LOCALAPPDATA;
  t.mock.method(require('../dist/antigravity-windows'), 'createPrivateWindowsQuotaDirectory', dir => fs.mkdirSync(dir, { mode: 0o700 }));
  const trusted = t.mock.method(require('../dist/antigravity-windows'), 'trustedWindowsQuotaDirectory', () => true);
  const temp = require('../dist/temporary-credentials');
  const old = temp.createTemporaryCredentials('agy-quota');
  temp.markTemporaryCredentialsPending(old, 'test@example.test', 'example-grant');
  const vault = require('../dist/credential-vault'), input = Buffer.from('synthetic credential');
  t.after(vault.setCredentialKeyProvider({ read: () => Buffer.alloc(32, 3) }));
  const pending = temp.createTemporaryCredentials('agy-quota');
  temp.markTemporaryCredentialsPending(pending, 'pending@example.test', 'unknown-grant', input);
  temp.withTemporaryProcess(pending, () => require('node:child_process').spawnSync(process.execPath, ['-e', '']));
  process.env.LOCALAPPDATA = path.join(root, 'user-local');
  const binary = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, '');
  const directory = temp.createTemporaryCredentials('agy-quota');
  assert.ok(directory.startsWith(path.join(process.env.LOCALAPPDATA, 'Temp') + path.sep));
  const readdir = fs.readdirSync, unreadable = t.mock.method(fs, 'readdirSync', (parent, ...args) => {
    if (parent === path.dirname(old)) throw Object.assign(new Error('legacy TEMP offline'), { code: 'EACCES' });
    return readdir(parent, ...args);
  });
  assert.doesNotThrow(() => temp.markTemporaryCredentialsPending(directory, 'test@example.test', 'different'));
  assert.doesNotThrow(() => temp.reapTemporaryCredentials());
  assert.throws(() => temp.pendingAntigravityQuota('pending@example.test', 'unknown-grant', input), e => e.diagnostic === 'recovery-missing');
  unreadable.mock.restore();
  assert.throws(() => temp.markTemporaryCredentialsPending(directory, 'test@example.test', 'example-grant'), error => error.diagnostic === 'recovery-writer');
  const supervisor = `
    const fs = require('node:fs'), name = '.ags-stop-' + process.pid;
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      if (JSON.parse(line).id === 1) console.log('{"id":1,"result":{}}');
    });
    setInterval(() => { if (fs.existsSync(name)) {
      fs.writeFileSync('.ags-win-drained-' + process.pid, '1'); process.exit(1);
    } }, 20);
  `;
  t.mock.method(require('../dist/windows-usage'), 'windowsUsageLaunch', () => ({
    command: process.execPath, args: ['-e', supervisor], options: { cwd: directory, env: { SystemRoot: process.env.SystemRoot } },
  }));
  let ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const session = require('../dist/antigravity-cli').startAcpLogin(directory, false, ready);
  t.after(() => session.stop());
  await initialized;
  await session.stop();
  await assert.rejects(session.complete, /取消/);
  assert.equal(temp.releaseTemporaryCredentials(directory), true);
  trusted.mock.mockImplementationOnce(() => false);
  assert.equal(temp.releaseTemporaryCredentials(old), false); assert.ok(fs.existsSync(old));
  assert.equal(temp.releaseTemporaryCredentials(old), true);
});

test('Windows quota runner isolates credential files, carries ACP and usage responses, and proves job exit', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.AGS_QUOTA_STANDARD_USER !== '1',
  timeout: 120000,
}, async t => {
  assert.match(os.userInfo().username, /(?:^|\\)AgsQuota[0-9a-f]{10}$/i, 'Expected the disposable CI account');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-quota-job-'));
  let removeCredential;
  t.after(() => {
    try { removeCredential?.(); }
    finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); }
  });
  const home = path.join(root, 'redirected-profile'), alias = path.join(root, 'profile-junction');
  const roaming = path.join(root, 'redirected-roaming'), roamingAlias = path.join(root, 'roaming-junction');
  fs.mkdirSync(home); fs.symlinkSync(home, alias, 'junction');
  fs.mkdirSync(roaming); fs.symlinkSync(roaming, roamingAlias, 'junction');
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  t.mock.method(os, 'tmpdir', () => root);
  t.mock.method(os, 'homedir', () => alias);
  const previous = {};
  for (const [name, value] of Object.entries({ HOME: alias, USERPROFILE: alias, LOCALAPPDATA: path.join(alias, 'AppData', 'Local'), APPDATA: roamingAlias })) {
    previous[name] = process.env[name]; process.env[name] = value;
  }
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  const { fixtureHelper } = require('./helpers/windows-helper.cjs');
  const { windowsUsageLaunch, windowsUsageHome } = require('../dist/windows-usage');
  const temp = require('../dist/temporary-credentials');
  const target = 'AGS-test-' + crypto.randomUUID();
  const native = fs.readFileSync(path.join(__dirname, '../assets/windows/AntigravityCredential.cs'), 'utf8')
    .replace('"gemini:antigravity"', JSON.stringify(target)).replace('public static int Main(', 'public static int FixtureCommand(')
    .replace('public static class AntigravityCredential', 'public static partial class AntigravityCredential');
  assert.ok(native.includes(JSON.stringify(target)) && !native.includes('gemini:antigravity'));
  const fixture = fixtureHelper(root, 'FixtureQuotaCli', native + fs.readFileSync(path.join(__dirname, 'helpers/windows-quota-fixture.cs'), 'utf8'));
  const sentinel = path.join(home, '.gemini', 'jetski-standalone-oauth-token');
  fs.mkdirSync(path.dirname(sentinel));
  // Real profiles may contain history junctions unrelated to either official login.
  fs.symlinkSync(roaming, path.join(home, '.gemini', 'conversations'), 'junction');
  execFileSync(fixture, ['create'], { input: Buffer.from(sentinel).toString('base64') + '\nZml4dHVyZQ==\n' });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'fixture');
  assert.equal(execFileSync(fixture, ['present'], { encoding: 'utf8' }), '0');
  execFileSync(fixture, ['write-canary']);
  removeCredential = () => {
    const [revision, value] = execFileSync(fixture, ['read'], { encoding: 'utf8' }).split(':');
    if (revision !== '-') execFileSync(fixture, ['replace'], { input: [value, revision, '-'].join('\n') + '\n' });
  };
  assert.equal(execFileSync(fixture, ['present'], { encoding: 'utf8' }), '1');
  assert.match(execFileSync(fixture, ['read'], { encoding: 'utf8' }), /^[A-F0-9]{16}:Kg==$/);
  let requests = 0;
  const proxy = require('node:http').createServer((request, response) => {
    if (request.url === 'http://ags-fixture.invalid/quota') requests++;
    response.setHeader('Content-Length', 13); response.end('fixture-quota');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const settings = { HTTPS_PROXY: 'http://127.0.0.1:' + proxy.address().port };
  async function run(args, isolated, binary = fixture, env = {}) {
    const directory = temp.createTemporaryCredentials('agy-quota');
    const home = windowsUsageHome(directory);
    fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-auth'), 'exported');
    const launch = windowsUsageLaunch(binary, args, directory, isolated, env);
    const child = temp.withTemporaryProcess(directory, () => spawn(launch.command, launch.args,
      { ...launch.options, stdio: ['pipe', 'pipe', 'pipe'] }));
    let out = '', err = '';
    child.stdout.on('data', data => {
      out += data;
      if (args[0] === 'wait-stop' && out.includes('waiting')) require('../dist/windows-usage').stopWindowsQuota(directory, child);
    });
    child.stderr.on('data', data => { err += data; });
    child.stdin.on('error', () => {}); // The startup-failure probe closes the pipe immediately.
    const closed = once(child, 'close');
    child.stdin.end('{"id":1}\n');
    const [code] = await closed;
    if (isolated) {
      assert.equal(fs.readFileSync(path.join(directory, '.ags-win-drained-' + child.pid), 'utf8'), String(code), err);
      assert.equal(temp.confirmWindowsQuotaExit(directory, child, code), true, err);
    }
    const state = fs.readFileSync(path.join(home, 'fixture-auth'), 'utf8');
    assert.equal(fs.existsSync(path.join(directory, 'cli-bin')), false);
    return { code, out, err, state, file: path.join(home, 'fixture-auth') };
  }
  const args = ['acp', 'check', sentinel];
  const acp = await run(args, true, fixture, settings);
  assert.equal(acp.code, 0, acp.err);
  assert.deepEqual(JSON.parse(acp.out), { id: 1, result: {} }); assert.equal(acp.state, 'renewed');
  const usage = await run(['-p', '/usage'], false);
  assert.equal(usage.code, 0, usage.err); assert.equal(JSON.parse(usage.out).command.name, 'usage');
  const failed = await run(['fail'], true);
  assert.equal(failed.code, 1, failed.err);
  const worker = /fixture query failed with child (\d+)/.exec(failed.err);
  assert.ok(worker, failed.err);
  assert.throws(() => process.kill(Number(worker[1]), 0), { code: 'ESRCH' });
  const stopped = await run(['wait-stop'], true);
  assert.equal(stopped.code, 1, stopped.err);
  const second = await run([...args, acp.file], true, fixture, settings);
  assert.equal(second.code, 0, second.err); assert.equal(requests, 2);
  assert.equal(fs.readFileSync(acp.file, 'utf8'), 'renewed');
  // Prove direct execution, a cold concurrent copy, a warm hit and invalidation after an upgrade.
  const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  const installed = path.join(root, 'official-install', 'agy.exe');
  fs.mkdirSync(path.dirname(installed)); fs.copyFileSync(fixture, installed);
  execFileSync(icacls, [installed, '/inheritance:r', '/grant:r', os.userInfo().username + ':F']);
  async function imagePath() {
    const result = await run(['image'], true, installed);
    assert.equal(result.code, 0, result.err); return result.out.trim();
  }
  const [cached, concurrent] = await Promise.all([imagePath(), imagePath()]);
  assert.equal(concurrent, cached);
  assert.equal(path.basename(cached), 'agy.exe');
  assert.equal(path.basename(path.dirname(path.dirname(cached))), 'AgentSwitcher-QuotaCLI');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(installed)).digest('hex').toUpperCase();
  assert.ok(path.basename(path.dirname(cached)).endsWith('.' + digest));
  const stamp = fs.statSync(cached, { bigint: true });
  assert.equal(await imagePath(), cached);
  assert.equal(fs.statSync(cached, { bigint: true }).ino, stamp.ino);
  assert.equal(fs.statSync(cached, { bigint: true }).mtimeNs, stamp.mtimeNs);
  fs.appendFileSync(installed, 'new fixture version'); // An overlay leaves the small PE executable.
  assert.notEqual(await imagePath(), cached);
  execFileSync(icacls, [installed, '/grant', '*S-1-5-11:RX', '*S-1-5-32-545:RX']);
  assert.equal((await imagePath()).toLowerCase(), fs.realpathSync.native(installed).toLowerCase());

  // The actual credential behind the profile junction must still be private before launch.
  execFileSync(icacls, [sentinel, '/grant', '*S-1-1-0:R', '*S-1-5-32-545:R']);
  const unsafe = await run(args, true, fixture, settings);
  assert.equal(unsafe.code, 124, unsafe.err); assert.equal(unsafe.state, 'exported'); assert.equal(requests, 2);
  fs.unlinkSync(sentinel);
  const missing = await run([], true, path.join(root, 'missing-fixture.exe'));
  assert.equal(missing.code, 124, missing.err);
});
