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
function release(version = '1.2.0', signed = true) {
  const tag = `v${version}`, name = assetName(version);
  const asset = (name, size) => ({ name, size, state: 'uploaded', browser_download_url: `${repo}/releases/download/${tag}/${name}` });
  return { tag_name: tag, html_url: `${repo}/releases/tag/${tag}`, body: '修复显示 <script>example</script>', published_at: '2026-11-16T00:00:00Z',
    assets: [{ ...asset(name, payload.length), digest: `sha256:${digest}` }, ...(signed ? [asset(name + '.signed.json', 320)] : [])] };
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

test('stable versions compare numerically and invalid/prerelease metadata never reports latest', async () => {
  assert(newerVersion('1.10.0', '1.9.0'));
  assert(!newerVersion('1.0.0', '1.1.20'));
  assert(!newerVersion('01.2.0', '1.0.0'));
  const f = fixture();
  for (const data of [{ ...release(), prerelease: true }, release('bad'), { ...release(), html_url: 'https://other.test/release' }]) {
    f.network.responses.push(response(data));
    assert.equal((await f.updates.check()).status, 'unavailable');
  }
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
test('unsupported systems, ambiguous assets, and off-repository URLs cannot start downloads', async () => {
  const f = await prepared({ arch: 'x64' });
  assert.equal(f.updates.getState().release.downloadable, false);
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
  await restored.openDownloaded(); assert.equal(opened.at(-1), file);
  fs.unlinkSync(file);
  await assert.rejects(restored.openDownloaded(), /不存在/);
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
  await assert.rejects(f.updates.openDownloaded(), /已改变/);
  assert.equal(f.updates.getState().status, 'available');
  const cached = JSON.parse(fs.readFileSync(path.join(f.root, 'app-updates.json')));
  cached.downloadedPath = path.join(f.root, release().assets[0].name);
  fs.writeFileSync(cached.downloadedPath, payload);
  fs.writeFileSync(path.join(f.root, 'app-updates.json'), JSON.stringify(cached));
  const restored = new AppUpdates(f.options, key.publicKey);
  assert.equal(restored.getState().status, 'available');
  await assert.rejects(restored.openDownloaded(), /不存在/);
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
    await assert.rejects(restored.openDownloaded());
    restored.stop();
  }
  assert.equal(opened.length, 0);
});
test('release signing command and updater agree on the DMG; a different signing key is rejected', async () => {
  const f = fixture(), version = '1.3.1', name = assetName(version);
  for (const dir of ['dist', 'assets', 'scripts', 'release']) fs.mkdirSync(path.join(f.root, dir));
  for (const file of ['scripts/release-checksums.cjs', 'dist/release-manifest.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(f.root, file));
  }
  const privateFile = path.join(f.root, 'test-only-private.pem');
  fs.writeFileSync(path.join(f.root, 'assets/release-signing-public.pem'), key.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(privateFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const dmg = path.join(f.root, 'release', name);
  fs.writeFileSync(dmg, payload);
  const run = () => spawnSync(process.execPath, ['scripts/release-checksums.cjs', '--sign-key', privateFile, dmg], { cwd: f.root, encoding: 'utf8' });
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, 'release/SHA256SUMS'), 'utf8'), `${digest}  ${name}\n`);
  const signed = fs.readFileSync(dmg + '.signed.json', 'utf8');
  f.network.responses.push(response(release(version)));
  f.network.manifestResponse = new Response(signed);
  assert.equal((await f.updates.check()).release.downloadable, true);
  const downloaded = await completed(f);
  await f.updates.openDownloaded();
  assert.equal(opened.at(-1), downloaded);
  fs.writeFileSync(privateFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const wrong = run();
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /私钥与应用内置的 Ed25519 公钥不匹配/);
  assert.equal(fs.readFileSync(dmg + '.signed.json', 'utf8'), signed);
});
test('a file moved during revalidation clears the stale download and allows retry', async () => {
  const f = await prepared(), file = await completed(f), createReadStream = fs.createReadStream;
  fs.createReadStream = function(target, ...args) {
    if (target === file) fs.renameSync(target, `${target}.moved`);
    return createReadStream.call(this, target, ...args);
  };
  try { await assert.rejects(f.updates.openDownloaded(), /无法读取/); }
  finally { fs.createReadStream = createReadStream; }
  assert.equal(opened.length, 0);
  assert.equal((await f.updates.download()).status, 'downloading');
});
test('a completed package remains usable when saving its cache fails', async () => {
  const f = await prepared(), cache = path.join(f.root, 'app-updates.json');
  fs.unlinkSync(cache); fs.mkdirSync(cache);
  const file = await completed(f);
  assert.match(f.updates.getState().message, /记录未能保存/);
  await f.updates.openDownloaded();
  assert.equal(opened.at(-1), file);
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
