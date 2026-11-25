const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const repo = 'https://github.com/xjzc-mt/agent-switcher';
const payload = Buffer.from('fixture disk image');
const digest = createHash('sha256').update(payload).digest('hex');
const key = generateKeyPairSync('ed25519');
const assetName = version => `AgentSwitcher-${version}-arm64.dmg`;
function signedManifest(version, overrides = {}, privateKey = key.privateKey) {
  const m = { version, name: assetName(version), size: payload.length, sha256: digest, ...overrides };
  const bytes = Buffer.from(JSON.stringify(['com.agent-switcher.app/release/v1', m.version, m.name, m.size, m.sha256]));
  return { ...m, signature: sign(null, bytes, privateKey).toString('base64') };
}
const opened = [], sessions = [], fixtures = [];
class Download extends EventEmitter {
  constructor(url) { super(); this.url = url; this.received = 0; }
  getURLChain() { return [this.url]; }
  getTotalBytes() { return this.declared ?? 0; }
  getReceivedBytes() { return this.received; }
  setSavePath(file) { this.file = file; fs.writeFileSync(file, 'partial'); }
  cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled'); }
  complete(bytes = payload) { fs.writeFileSync(this.file, bytes); this.emit('done', {}, 'completed'); }
}
class Network extends EventEmitter {
  constructor() { super(); this.responses = []; this.requests = []; }
  async fetch(url, options) {
    this.requests.push({ url, options });
    if (url.endsWith('.signed.json')) {
      const version = /\/download\/v([^/]+)\//.exec(url)[1];
      return this.manifestResponse ?? response(signedManifest(version));
    }
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    assert(next, `Unexpected request: ${url}`);
    return next;
  }
  downloadURL(url) {
    this.item = new Download(url);
    queueMicrotask(() => this.emit('will-download', { preventDefault: () => { this.item.blocked = true; } }, this.item));
  }
}
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return {
    session: { fromPartition: () => { const network = new Network(); sessions.push(network); return network; } },
    shell: { openPath: async file => { opened.push(file); return ''; }, openExternal: async url => { opened.push(url); } },
  };
  return load.call(this, name, ...args);
};
let AppUpdates, newerVersion;
try { ({ AppUpdates, newerVersion } = require('../dist/app-updates')); } finally { Module._load = load; }
function release(version = '1.2.0', signed = true, names = [assetName(version)]) {
  const tag = `v${version}`;
  const asset = (name, size) => ({ name, size, state: 'uploaded', browser_download_url: `${repo}/releases/download/${tag}/${name}` });
  return { tag_name: tag, html_url: `${repo}/releases/tag/${tag}`, body: '修复显示 <script>example</script>', published_at: '2026-11-16T00:00:00Z',
    assets: names.flatMap(name => [{ ...asset(name, payload.length), digest: `sha256:${digest}` }, ...(signed ? [asset(name + '.signed.json', 320)] : [])]) };
}
const response = value => new Response(JSON.stringify(value), { status: 200 });
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-updates-'));
  const states = [];
  const options = { currentVersion: '1.0.0', platform: 'darwin', arch: 'arm64', userDataDir: root, downloadsDir: path.join(root, 'Downloads'), onChange: state => states.push(state), ...overrides };
  const updates = new AppUpdates(options, key.publicKey), network = sessions.at(-1);
  const value = { root, updates, network, states, options };
  fixtures.push(value);
  return value;
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.updates.stop(); fs.rmSync(f.root, { recursive: true, force: true }); } opened.length = 0; });
async function until(updates, status) {
  for (let i = 0; i < 100 && updates.getState().status !== status; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updates.getState().status, status);
}
async function prepared(options) {
  const f = fixture(options); f.network.responses.push(response(release())); await f.updates.check(); return f;
}
async function completed(f) {
  await f.updates.download();
  f.network.item.complete();
  await until(f.updates, 'downloaded');
  return f.network.item.file.replace(/\.partial$/, '');
}

test('stable versions compare numerically, ignore retired 1.0.x tags, and invalid/prerelease metadata never reports latest', async () => {
  assert(newerVersion('1.10.0', '1.9.0'));
  assert(newerVersion('0.1.1', '0.1.0'));
  assert(!newerVersion('1.0.0', '1.1.20'));
  assert(!newerVersion('1.0.0', '0.1.0'));
  assert(!newerVersion('1.0.1', '0.1.0'));
  assert(!newerVersion('01.2.0', '1.0.0'));
  const f = fixture({ currentVersion: '0.1.0' });
  for (const data of [release('1.0.0'), release('1.0.1'), { ...release(), prerelease: true }, release('bad'), { ...release(), html_url: 'https://other.test/release' }]) {
    f.network.responses.push(response(data));
    assert.equal((await f.updates.check()).status, 'unavailable');
  }
  fs.writeFileSync(path.join(f.root, 'app-updates.json'), JSON.stringify({ autoCheck: true, record: {
    info: { version: '1.0.1', name: assetName('1.0.1'), size: payload.length, url: `${repo}/releases/tag/v1.0.1`,
      notes: '', publishedAt: '2026-11-20T00:00:00Z', downloadable: true },
    assetUrl: `${repo}/releases/download/v1.0.1/${assetName('1.0.1')}`, manifest: signedManifest('1.0.1') } }));
  const restored = new AppUpdates({ ...f.options, currentVersion: '0.1.0' }, key.publicKey);
  assert.equal(restored.getState().status, 'idle');
  assert.equal(restored.getState().release, undefined);
  restored.stop();
});
test('private or empty GitHub repo is unavailable, with daily automatic throttling and manual retry', async () => {
  const f = fixture(); f.network.responses.push(new Response('', { status: 404 }));
  assert.equal((await f.updates.check(false)).status, 'unavailable');
  assert.match(f.updates.getState().message, /尚未公开|尚未发布/);
  await f.updates.check(false);
  assert.equal(f.network.requests.length, 1);
  f.network.responses.push(response(release()));
  assert.equal((await f.updates.check()).status, 'available');
  assert.equal(f.network.requests[0].options.credentials, 'omit');
  assert.equal(f.network.requests[0].options.headers.Authorization, undefined);
  f.network.responses.push(new Error('fixture network failure'));
  assert.equal((await f.updates.check()).errorStage, 'check');
  assert.equal(f.updates.getState().status, 'error');
  assert.equal(f.updates.getState().release.downloadable, true);
});
test('manual checks honor server rate limits and disabled automatic checks do no network work', async () => {
  const f = fixture(); f.updates.setAutoCheck(false); await f.updates.check(false);
  assert.equal(f.network.requests.length, 0);
  f.network.responses.push(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  await f.updates.check(); await f.updates.check();
  assert.equal(f.network.requests.length, 1);
});
test('unsigned legacy releases with a digest and SHA256SUMS remain viewable without enabling downloads', async () => {
  const f = fixture(), data = release('1.2.0', false);
  data.assets.push({ name: 'SHA256SUMS', size: 100, state: 'uploaded', browser_download_url: `${repo}/releases/download/v1.2.0/SHA256SUMS` });
  f.network.responses.push(response(data));
  const state = await f.updates.check();
  assert.equal(state.release.url, data.html_url);
  assert.equal(state.release.downloadable, false);
  assert.match(state.message, /发布者签名/);
  await assert.rejects(f.updates.download(), /暂无可下载/);
});
test('signed manifests bind the publisher, version, name, size and hash', async () => {
  const f = fixture(), wrong = generateKeyPairSync('ed25519');
  for (const manifest of [
    signedManifest('1.2.0', {}, wrong.privateKey), signedManifest('1.2.1'),
    signedManifest('1.2.0', { name: 'other.dmg' }), signedManifest('1.2.0', { size: payload.length + 1 }),
    { ...signedManifest('1.2.0'), sha256: 'a'.repeat(64) }, { ...signedManifest('1.2.0'), signature: '!' }, {},
  ]) {
    f.network.responses.push(response(release()));
    f.network.manifestResponse = response(manifest);
    assert.equal((await f.updates.check()).release.downloadable, false);
    await assert.rejects(f.updates.download());
  }
  const conflicting = release();
  conflicting.assets[0].digest = 'sha256:' + 'b'.repeat(64);
  f.network.manifestResponse = undefined;
  f.network.responses.push(response(conflicting));
  assert.equal((await f.updates.check()).release.downloadable, false);
  delete conflicting.assets[0].digest;
  f.network.responses.push(response(conflicting));
  assert.equal((await f.updates.check()).release.downloadable, true);
});
test('unsupported systems, missing or ambiguous assets, and off-repository URLs cannot start downloads', async () => {
  const version = '1.2.0', data = release(version, true, [assetName(version), `AgentSwitcher-Setup-${version}-x64.exe`]);
  for (const options of [{ platform: 'win32', arch: 'arm64' }, { platform: 'linux', arch: 'x64' }, { platform: 'darwin', arch: 'x64' }]) {
    const f = fixture(options);
    f.network.responses.push(response(data));
    assert.equal((await f.updates.check()).release.downloadable, false);
    assert.equal(f.network.requests.length, 1);
    await assert.rejects(f.updates.download());
  }
  const g = fixture(), ambiguous = release(), foreign = release();
  ambiguous.assets.push({ ...ambiguous.assets[0] }); foreign.assets[0].browser_download_url = 'https://example.test/file.dmg';
  for (const data of [ambiguous, foreign]) {
    g.network.responses.push(response(data));
    assert.equal((await g.updates.check()).release.downloadable, false);
    await assert.rejects(g.updates.download());
  }
});
test('download ignores legacy ignored versions, verifies bytes, preserves files, and restores the known DMG', async () => {
  const f = await prepared(); fs.mkdirSync(f.options.downloadsDir);
  const cache = path.join(f.root, 'app-updates.json');
  fs.writeFileSync(cache, JSON.stringify({ ...JSON.parse(fs.readFileSync(cache)), ignoredVersion: '1.2.0' }));
  f.updates.stop(); f.updates = new AppUpdates(f.options, key.publicKey); f.network = sessions.at(-1);
  assert.equal(f.updates.getState().release.downloadable, true);
  assert.equal('ignoredVersion' in f.updates.getState(), false);
  const existing = path.join(f.options.downloadsDir, release().assets[0].name); fs.writeFileSync(existing, 'user file');
  const file = await completed(f);
  assert.equal(f.updates.getState().message, undefined);
  assert.equal('ignoredVersion' in JSON.parse(fs.readFileSync(cache)), false);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'user file');
  assert.deepEqual(fs.readFileSync(file), payload);
  const restored = new AppUpdates(f.options, key.publicKey);
  assert.equal(restored.getState().status, 'downloaded');
  const handoff = await restored.prepareInstall();
  assert.equal(opened.length, 0);
  fs.writeFileSync(file, 'changed after staging');
  await handoff.launch();
  const staged = opened.at(-1);
  assert.notEqual(staged, file);
  assert.equal(path.basename(staged), path.basename(file));
  assert.deepEqual(fs.readFileSync(staged), payload);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(staged)).mode & 0o777, 0o700);
  await handoff.dispose();
  assert.equal(fs.existsSync(staged), false);
  fs.unlinkSync(file);
  await assert.rejects(restored.prepareInstall(), /不存在/);
  assert.equal(restored.getState().status, 'available');
  restored.stop();
});
test('cancellation ignores late completion; corrupt data is removed and never opened', async () => {
  const f = await prepared(); await f.updates.download();
  const item = f.network.item; f.updates.cancel();
  item.emit('done', {}, 'completed');
  assert.equal(f.updates.getState().status, 'available');
  assert.equal(f.updates.getState().message, undefined);
  assert.equal(f.updates.getState().errorStage, undefined);
  assert.equal(fs.existsSync(item.file), false);
  await f.updates.download(); f.network.item.complete(Buffer.alloc(payload.length));
  await until(f.updates, 'error');
  assert.match(f.updates.getState().message, /校验失败/);
  assert.equal(f.updates.getState().errorStage, 'download');
  assert.equal(fs.existsSync(f.network.item.file), false);
  assert.equal(opened.length, 0);
});

test('download rejects inconsistent response sizes and stops an unknown-length transfer as soon as it exceeds the signed size', async () => {
  const f = await prepared();
  const starting = f.updates.download(), first = f.network.item;
  first.declared = payload.length + 1;
  await starting;
  assert.ok(first.blocked);
  assert.equal(first.file, undefined);
  assert.equal(f.updates.isDownloading(), false);
  assert.match(f.updates.getState().message, /大小与发布签名不符/);
  await f.updates.download();
  const second = f.network.item;
  second.received = payload.length + 1;
  second.emit('updated', {}, 'progressing');
  assert.ok(second.cancelled);
  assert.equal(fs.existsSync(second.file), false);
  assert.deepEqual(fs.readdirSync(f.options.downloadsDir), []);
  assert.equal(f.updates.isDownloading(), false);
  await completed(f);
});
test('changed completed files cannot be opened; cache cannot authorize an unrelated path', async () => {
  const f = await prepared(), file = await completed(f);
  fs.writeFileSync(file, Buffer.alloc(payload.length));
  await assert.rejects(f.updates.prepareInstall(), /已改变/);
  assert.equal(f.updates.getState().status, 'available');
  const cached = JSON.parse(fs.readFileSync(path.join(f.root, 'app-updates.json')));
  cached.downloadedPath = path.join(f.root, release().assets[0].name);
  fs.writeFileSync(cached.downloadedPath, payload);
  fs.writeFileSync(path.join(f.root, 'app-updates.json'), JSON.stringify(cached));
  const restored = new AppUpdates(f.options, key.publicKey);
  assert.equal(restored.getState().status, 'available');
  await assert.rejects(restored.prepareInstall(), /不存在/);
  assert.equal(opened.length, 0); restored.stop();
});
test('old or modified download caches cannot authorize opening a file', async () => {
  const f = await prepared(), file = await completed(f);
  const cacheFile = path.join(f.root, 'app-updates.json');
  const cached = JSON.parse(fs.readFileSync(cacheFile));
  for (const manifest of [undefined, { ...cached.record.manifest, sha256: 'a'.repeat(64) }]) {
    fs.writeFileSync(cacheFile, JSON.stringify({ ...cached, downloadedPath: file,
      record: { ...cached.record, sha256: digest, manifest } }));
    const restored = new AppUpdates(f.options, key.publicKey);
    assert.equal(restored.getState().release.downloadable, false);
    await assert.rejects(restored.download());
    await assert.rejects(restored.prepareInstall());
    restored.stop();
  }
  assert.equal(opened.length, 0);
});
test('Windows x64 and both Mac architectures stage only their signed installer for the platform handoff', async t => {
  const f = fixture(), version = '1.3.1';
  const names = [`AgentSwitcher-Setup-${version}-x64.exe`, `AgentSwitcher-${version}-x64.dmg`, assetName(version)];
  for (const dir of ['dist', 'assets', 'scripts', 'release']) fs.mkdirSync(path.join(f.root, dir));
  for (const file of ['scripts/release-checksums.cjs', 'dist/release-manifest.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(f.root, file));
  }
  const privateFile = path.join(f.root, 'test-only-private.pem');
  fs.writeFileSync(path.join(f.root, 'assets/release-signing-public.pem'), key.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(privateFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const files = names.map(name => path.join(f.root, 'release', name));
  for (const file of files) fs.writeFileSync(file, payload);
  const run = () => spawnSync(process.execPath, ['scripts/release-checksums.cjs', '--sign-key', privateFile, ...files], { cwd: f.root, encoding: 'utf8' });
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, 'release/SHA256SUMS'), 'utf8'), names.map(name => `${digest}  ${name}\n`).join(''));
  const signed = files.map(file => fs.readFileSync(file + '.signed.json', 'utf8'));
  const data = release(version, true, names);
  const intel = fixture({ arch: 'x64' }), win = fixture({ platform: 'win32', arch: 'x64' });
  for (const [i, client] of [win, intel, f].entries()) {
    const asset = { version, name: names[i], size: payload.length };
    assert(require('../dist/release-manifest').verifyReleaseManifest(JSON.parse(signed[i]), asset, key.publicKey));
    client.network.responses.push(response(data));
    client.network.manifestResponse = new Response(signed[i]);
    const state = await client.updates.check();
    assert.equal(state.release.name, names[i]);
    assert.equal(state.release.downloadable, true);
    assert(client.network.requests.at(-1).url.endsWith(names[i] + '.signed.json'));
    const downloaded = await completed(client);
    assert.equal(path.basename(downloaded), names[i]);
    const handoff = await client.updates.prepareInstall();
    if (i === 0) {
      const spawn = t.mock.method(require('node:child_process'), 'spawn', (command, args, options) => {
        assert.match(command, /WindowsPowerShell.*powershell\.exe$/i);
        assert.ok(options.detached); assert.equal(options.stdio, 'ignore');
        const script = args.at(-1);
        assert.match(script, /\[Diagnostics\.Process\]::Start\(\$env:AGS_UPDATE_FILE, '\/S --updated --force-run'\)[\s\S]+?\$installer\.WaitForExit\(\)[\s\S]+?\$installer\.ExitCode -ne 0/);
        assert.match(script, /Remove-Item -LiteralPath \$stage -Recurse -Force -ErrorAction SilentlyContinue/);
        assert.equal(options.env.AGS_UPDATE_PARENT, String(process.pid));
        assert.notEqual(options.env.AGS_UPDATE_FILE, downloaded);
        assert.deepEqual(fs.readFileSync(options.env.AGS_UPDATE_FILE), payload);
        if (process.platform === 'win32') {
          const { fixtureHelper } = require('./helpers/windows-helper.cjs');
          const exe = fixtureHelper(f.root, 'Installer', 'class Installer { static int Main() { return int.Parse(System.Environment.GetEnvironmentVariable("FIXTURE_EXIT")); } }');
          for (const exit of [0, 7]) {
            const dir = fs.mkdtempSync(path.join(f.root, 'stage ')), image = path.join(dir, 'fixture installer.exe');
            fs.copyFileSync(exe, image);
            // Hold a stage file through the first removal, then release it on the retry.
            const lock = "$lock = [IO.File]::Open((Join-Path (Split-Path $env:AGS_UPDATE_FILE) busy), 'Create', 'Write', 'None')\nfunction Start-Sleep { $lock.Dispose() }\n";
            const result = spawnSync(command, [...args.slice(0, -1), lock + script], {
              timeout: 10000, encoding: 'utf8', env: { ...options.env, AGS_UPDATE_FILE: image,
                AGS_UPDATE_PARENT: '2147483647', AGS_ORIGINAL_APP: path.join(f.root, 'missing.exe'), FIXTURE_EXIT: String(exit) },
            });
            // Reopening the deliberately missing original app makes the failure branch observable.
            assert.equal(result.status, exit === 0 ? 0 : 1, result.stderr);
            assert.equal(fs.existsSync(dir), false);
          }
        }
        const child = new EventEmitter(); child.unref = () => {};
        queueMicrotask(() => child.emit('spawn')); return child;
      });
      await handoff.launch();
      assert.equal(spawn.mock.callCount(), 1); spawn.mock.restore();
    }
    await handoff.dispose();
    const restored = new AppUpdates(client.options, key.publicKey);
    assert.equal(restored.getState().status, 'downloaded');
    restored.stop();
  }
  const changedArch = new AppUpdates({ ...intel.options, arch: 'arm64' }, key.publicKey);
  assert.equal(changedArch.getState().release, undefined);
  changedArch.stop();
  fs.writeFileSync(privateFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const wrong = run();
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /私钥与应用内置的 Ed25519 公钥不匹配/);
  assert.deepEqual(files.map(file => fs.readFileSync(file + '.signed.json', 'utf8')), signed);
});
test('a file moved during revalidation clears the stale download and allows retry', async () => {
  const f = await prepared(), file = await completed(f), open = fs.promises.open;
  fs.promises.open = function(target, ...args) {
    if (target === file) fs.renameSync(target, `${target}.moved`);
    return open.call(this, target, ...args);
  };
  try { await assert.rejects(f.updates.prepareInstall(), /无法读取/); }
  finally { fs.promises.open = open; }
  assert.equal(opened.length, 0);
  assert.equal((await f.updates.download()).status, 'downloading');
});
test('a completed package remains usable when saving its cache fails', async () => {
  const f = await prepared(), cache = path.join(f.root, 'app-updates.json');
  fs.unlinkSync(cache); fs.mkdirSync(cache);
  const file = await completed(f);
  assert.match(f.updates.getState().message, /记录未能保存/);
  const handoff = await f.updates.prepareInstall();
  assert.equal(opened.length, 0);
  await handoff.dispose();
  assert.ok(fs.existsSync(file));
});

test('a download that stalls after starting times out cleanly and releases active state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await prepared();
  await f.updates.download();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(f.updates.isDownloading(), true);
  // Repeated updated events with unchanged received bytes must NOT extend the stall timer.
  f.network.item.received = 4;
  f.network.item.emit('updated', {}, 'progressing');
  for (let n = 0; n < 4; n++) {
    t.mock.timers.tick(20000);
    f.network.item.emit('updated', {}, 'progressing'); // still 4 bytes!
  }
  assert.equal(f.updates.isDownloading(), false);
  assert.equal(f.updates.getState().status, 'error');
  assert.match(f.updates.getState().message, /超时/);

  // Retry works after stall timeout, and genuine slow byte progress keeps renewing timeout until completion.
  await f.updates.download();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(f.updates.isDownloading(), true);
  for (const bytes of [5, 10, 15]) {
    t.mock.timers.tick(45000);
    f.network.item.received = bytes;
    f.network.item.emit('updated', {}, 'progressing');
    assert.equal(f.updates.isDownloading(), true);
  }
  f.network.item.complete();
  t.mock.timers.reset();
  await until(f.updates, 'downloaded');
});

test('macOS quit handoff swaps bundles atomically and restores the old bundle if reopening fails', { skip: process.platform !== 'darwin' }, async t => {
  const native = require('node:child_process'), { installMode, prepareHandoff } = require('../dist/update-handoff');
  const root = fs.realpathSync(fixture().root);
  const target = path.join(root, "测试 Agent's", 'AgentSwitcher.app'), relativeExe = 'Contents/MacOS/AgentSwitcher';
  const makeApp = (app, version) => {
    fs.mkdirSync(path.dirname(path.join(app, relativeExe)), { recursive: true });
    fs.writeFileSync(path.join(app, relativeExe), version, { mode: 0o755 });
  };
  makeApp(target, 'old');
  const env = { platform: 'darwin', isPackaged: true, execPath: path.join(target, relativeExe) };
  assert.equal(installMode(env), 'restart');
  assert.equal(installMode({ ...env, isPackaged: false }), 'open');
  assert.equal(installMode({ ...env, execPath: '/Volumes/AGS/AgentSwitcher.app/' + relativeExe }), 'open');
  const source = path.join(root, 'release'), dmg = path.join(root, 'test.dmg');
  makeApp(path.join(source, 'AgentSwitcher.app'), 'new');
  native.execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-srcfolder', source, dmg]);
  // Run the shipping shell, read-only image mount, ditto, stat and renamex_np
  // against the fixture. Substitute only Finder to avoid launching an application.
  let failOpen = false;
  t.mock.method(native, 'spawn', (cmd, args, options) => {
    assert.equal(cmd, '/bin/sh'); assert.ok(options.detached); assert.equal(options.stdio, 'ignore');
    const local = args.slice();
    local[1] = local[1].replaceAll('/usr/bin/open', failOpen ? '/usr/bin/false' : '/usr/bin/true');
    // A busy private mount must still be released after ordinary detach retries.
    if (failOpen) local[1] = local[1].replaceAll('/usr/bin/hdiutil detach "$1"', '/usr/bin/false');
    // Use a PID that is known to have exited, so the test process can observe the handoff.
    local[3] = String(native.spawnSync('/usr/bin/true').pid);
    const run = native.spawnSync(cmd, local, { encoding: 'utf8' });
    assert.equal(run.status, failOpen ? 1 : 0, run.stderr);
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  for (const action of ['cancel', 'rollback', 'install']) {
    const stage = fs.mkdtempSync(path.join(root, 'stage-')), image = path.join(stage, 'fixture.dmg');
    fs.copyFileSync(dmg, image);
    const prepared = await prepareHandoff(image, env);
    assert.equal(fs.readFileSync(env.execPath, 'utf8'), 'old');
    failOpen = action === 'rollback';
    if (action === 'cancel') await prepared.dispose();
    else await prepared.launch();
    assert.equal(fs.readFileSync(env.execPath, 'utf8'), action === 'install' ? 'new' : 'old');
    assert.equal(fs.existsSync(stage), false);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['AgentSwitcher.app']);
});

test('a signed DMG with no application stays unavailable until the release asset changes', { skip: process.platform !== 'darwin' }, async t => {
  const root = fs.realpathSync(fixture().root), exe = path.join(root, 'AgentSwitcher.app/Contents/MacOS/AgentSwitcher');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'fixture');
  const f = fixture({ isPackaged: true, execPath: exe }), contents = path.join(root, 'release'), image = path.join(root, 'bad.dmg');
  fs.mkdirSync(contents); fs.writeFileSync(path.join(contents, 'README'), 'no application bundle');
  require('node:child_process').execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-srcfolder', contents, image]);
  const bytes = fs.readFileSync(image), sha = createHash('sha256').update(bytes).digest('hex');
  const check = async (size, sha256) => {
    const data = release(); Object.assign(data.assets[0], { size, digest: 'sha256:' + sha256 });
    f.network.responses.push(response(data)); f.network.manifestResponse = response(signedManifest('1.2.0', { size, sha256 }));
    return f.updates.check();
  };
  await check(bytes.length, sha);
  await f.updates.download(); f.network.item.complete(bytes); await until(f.updates, 'downloaded');
  const mkdir = fs.mkdirSync, denied = t.mock.method(fs, 'mkdirSync', (dir, ...rest) => {
    if (path.basename(dir) === 'volume') throw new Error('local mount point unavailable');
    return mkdir(dir, ...rest);
  });
  await assert.rejects(f.updates.prepareInstall(), /local mount point unavailable/);
  denied.mock.restore();
  assert.equal(f.updates.getState().status, 'downloaded');
  await assert.rejects(f.updates.prepareInstall(), /缺少完整的 AgentSwitcher.app/);
  assert.equal(f.updates.getState().status, 'available');
  assert.equal(f.updates.getState().release.downloadable, false);
  const restored = new AppUpdates(f.options, key.publicKey);
  assert.equal(restored.getState().release.downloadable, false); restored.stop();
  assert.equal((await check(bytes.length, sha)).release.downloadable, false);
  assert.equal((await check(payload.length, digest)).release.downloadable, true);
});

test('zero-download GitHub release signing verifies commit, build workflow, and SHA-256 digests without downloading installers', t => {
  const f = fixture(), version = '0.1.2', sha = 'ab'.repeat(20);
  const manifestMod = require('../dist/release-manifest');
  t.mock.method(manifestMod, 'trustedReleaseKey', () => key.publicKey);
  const privateFile = path.join(f.root, 'offline-private.pem');
  fs.writeFileSync(privateFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const expectedAssets = [
    { name: `AgentSwitcher-${version}-arm64.dmg`, size: 120001, state: 'uploaded', digest: 'sha256:' + '1'.repeat(64) },
    { name: `AgentSwitcher-${version}-x64.dmg`, size: 120002, state: 'uploaded', digest: 'sha256:' + '2'.repeat(64) },
    { name: `AgentSwitcher-Setup-${version}-x64.exe`, size: 110003, state: 'uploaded', digest: 'SHA256:' + 'A'.repeat(64) },
  ];
  const { signGithubRelease } = require('../scripts/release-checksums.cjs');
  const uploaded = new Map(), calls = [];
  const makeExec = ({ target = sha, conclusion = 'success', assets = expectedAssets } = {}) => (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh' && args[0] === 'api' && args[1].includes('/releases?')) {
      return JSON.stringify([{ tag_name: `v${version}`, draft: true, target_commitish: target, assets }]);
    }
    if (cmd === 'gh' && args[0] === 'api' && args[1].includes('release-build.yml/runs')) {
      return JSON.stringify({ workflow_runs: [{ head_sha: sha, conclusion }] });
    }
    if (cmd === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      for (const file of args.slice(args.indexOf('--clobber') + 1)) {
        uploaded.set(path.basename(file), fs.readFileSync(file, 'utf8'));
      }
      return '';
    }
    if (cmd === 'gh' && args[0] === 'release' && args[1] === 'edit') return '';
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };

  assert.throws(() => signGithubRelease({ releaseTag: 'v1.0.1', keyFile: privateFile, commit: sha }, makeExec()), /已退役/);
  assert.throws(() => signGithubRelease({ releaseTag: `v${version}`, keyFile: privateFile, commit: sha },
    makeExec({ target: 'cd'.repeat(20) })), /不一致/);
  assert.throws(() => signGithubRelease({ releaseTag: `v${version}`, keyFile: privateFile, commit: sha },
    makeExec({ conclusion: 'failure' })), /release-build\.yml/);
  assert.throws(() => signGithubRelease({ releaseTag: `v${version}`, keyFile: privateFile, commit: sha },
    makeExec({ assets: expectedAssets.slice(0, 2) })), /缺少已上传的安装包/);
  assert.throws(() => signGithubRelease({ releaseTag: `v${version}`, keyFile: privateFile, commit: sha },
    makeExec({ assets: [{ ...expectedAssets[0], digest: '' }, ...expectedAssets.slice(1)] })), /SHA-256/);
  assert.equal(uploaded.size, 0);

  calls.length = 0;
  signGithubRelease({ releaseTag: `v${version}`, keyFile: privateFile, commit: sha, publish: true }, makeExec());
  assert.equal(uploaded.size, 4);
  assert.equal(uploaded.get('SHA256SUMS'), [
    `${'1'.repeat(64)}  AgentSwitcher-${version}-arm64.dmg`,
    `${'2'.repeat(64)}  AgentSwitcher-${version}-x64.dmg`,
    `${'a'.repeat(64)}  AgentSwitcher-Setup-${version}-x64.exe`,
  ].join('\n') + '\n');
  for (const item of expectedAssets) {
    const doc = JSON.parse(uploaded.get(item.name + '.signed.json'));
    assert.equal(manifestMod.verifyReleaseManifest(doc, { version, name: item.name, size: item.size }, key.publicKey), true);
  }
  assert.ok(calls.some(c => c[0] === 'gh' && c[1] === 'release' && c[2] === 'edit' && c.includes('--latest') && c.includes('--draft=false')));
});
