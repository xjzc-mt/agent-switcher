const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const windows = require('../dist/antigravity-windows');
const realWindows = process.platform === 'win32';
const hostedWindows = realWindows && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';

test('Windows packaged helpers must match the manifest in the application archive', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ags-helper-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app.asar', 'dist');
  const executable = path.join(root, 'app.asar.unpacked', 'dist', 'windows-helpers', 'AgySandbox.exe');
  fs.mkdirSync(path.join(app, 'windows-helpers'), { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.copyFileSync(require.resolve('../dist/windows-helper'), path.join(app, 'windows-helper.js'));
  const { windowsHelper } = require(path.join(app, 'windows-helper.js'));
  const digest = require('node:crypto').createHash('sha256').update('fixture').digest('hex');
  fs.writeFileSync(path.join(app, 'windows-helpers/sha256.json'), JSON.stringify({ AgySandbox: digest }));
  fs.writeFileSync(executable, 'fixture');
  assert.equal(windowsHelper('AgySandbox'), executable);
  fs.writeFileSync(executable, 'changed');
  assert.throws(() => windowsHelper('AgySandbox'), /校验失败/);
});

test('Windows installs Mac personal credentials using exact bytes and rolls back an uncommitted long switch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-win-native-'));
  let removeCredential;
  t.after(() => { try { removeCredential?.(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  t.mock.method(os, 'homedir', () => root);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  require('../dist/credential-vault').setCredentialKeyProvider({ read: () => Buffer.alloc(32, 17) });
  const native = require('../dist/antigravity-native');
  const token = (email, padding) => Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: email,
    token: { refresh_token: 'synthetic-' + email, access_token: 'x'.repeat(padding) } }));
  const first = token('a@example.test', 6), second = token('b@example.test', 7000);
  let current = { data: null }, next = 0;
  if (hostedWindows) {
    const { fixtureHelper } = require('./helpers/windows-helper.cjs');
    const target = 'ags-fixture:' + require('node:crypto').randomUUID();
    const source = fs.readFileSync(path.join(__dirname, '../assets/windows/AntigravityCredential.cs'), 'utf8');
    const fixture = source.replace('"gemini:antigravity"', JSON.stringify(target));
    assert.ok(fixture !== source && !fixture.includes('gemini:antigravity'));
    const fixtureProgram = fixtureHelper(root, 'CredentialFixture', fixture);
    t.mock.method(require('../dist/windows-helper'), 'windowsHelper', () => fixtureProgram);
    removeCredential = () => {
      const run = require('node:child_process').execFileSync;
      const [revision, data] = run(fixtureProgram, ['read'], { encoding: 'utf8' }).split(':');
      if (revision !== '-') run(fixtureProgram, ['replace'], { input: [data, revision, '-'].join('\n') + '\n' });
    };
  } else {
    t.mock.method(windows, 'readWindowsCredential', () => ({ ...current }));
    t.mock.method(windows, 'replaceWindowsCredential', (before, bytes) => {
      assert.deepEqual(before.data, current.data);
      assert.equal(before.revision, current.revision);
      assert.ok(!bytes || bytes.length <= 2560);
      current = bytes ? { data: bytes.toString('base64'), revision: String(++next).padStart(16, '0') } : { data: null };
    });
  }
  // Local Windows tests only exercise real NTFS ACLs. The disposable hosted runner uses its own fixture credential.
  if (!realWindows) {
    t.mock.method(windows, 'privateWindowsFile', file => (fs.statSync(file).mode & 0o777) === 0o600);
    t.mock.method(windows, 'writePrivateWindowsFile', (file, bytes) => fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }));
  } else {
    const directory = path.join(root, 'quota'), login = path.join(directory, 'synthetic');
    windows.createPrivateWindowsQuotaDirectory(directory);
    fs.writeFileSync(login, first);
    assert.equal(windows.privateWindowsFile(login), true);
    assert.throws(() => windows.createPrivateWindowsQuotaDirectory(directory), /专用/);
  }
  native.writeNativeToken(first, { clearFallbacks: 'all' });
  assert.deepEqual(Buffer.from(windows.readWindowsCredential().data, 'base64'), first);
  assert.deepEqual(native.readSharedQuotaLogin(native.readNativeToken([])), first);
  assert.equal(native.assertNativeSwitchReady(second), 'files');
  const journal = native.createNativeMutationJournal();
  const options = { clearFallbacks: 'all', allowFileMigration: true };
  native.writeNativeToken(second, { ...options, journal });
  assert.deepEqual(native.readNativeToken(), first);
  journal.restore();
  assert.deepEqual(native.readNativeToken(), first);
  const desktop = path.join(root, '.gemini', native.NATIVE_TOKEN_FILE);
  assert.equal(fs.existsSync(desktop), false);
  native.writeNativeToken(second, options);
  assert.equal(windows.readWindowsCredential().data, null);
  assert.equal(windows.privateWindowsFile(desktop), true);
  assert.deepEqual(native.readSharedQuotaLogin(native.readNativeToken([])), second);
  const nextLogin = JSON.parse(second);
  nextLogin.token.access_token = 'synthetic-renewed';
  nextLogin.token.expiry = new Date(Date.now() + 3600000).toISOString();
  const renewed = Buffer.from(JSON.stringify(nextLogin));
  fs.writeFileSync(path.join(root, '.gemini/antigravity-cli/antigravity-oauth-token'), renewed);
  assert.deepEqual(native.readSharedQuotaLogin(native.readNativeToken([])), renewed);
  native.writeNativeToken(first, options);
  assert.equal(fs.existsSync(desktop), false);
  assert.deepEqual(native.readNativeToken(), first);

  // Two distinct NTFS file IDs can have identical Number representations. A replacement
  // with the same content and timestamp still belongs to the external writer on rollback.
  const installedId = 2n ** 54n;
  let visibleId = installedId;
  for (const method of ['lstatSync', 'statSync']) {
    const original = fs[method];
    t.mock.method(fs, method, function (file, opts) {
      const stat = original.call(this, file, opts);
      if (stat?.isFile() && (file === desktop || String(file).startsWith(desktop + '.'))) {
        stat.ino = opts?.bigint ? visibleId : Number(visibleId);
      }
      return stat;
    });
  }
  const interrupted = native.createNativeMutationJournal();
  native.writeNativeToken(second, { ...options, journal: interrupted });
  visibleId += 1n;
  assert.throws(() => interrupted.restore(), /已保留现场/);
  assert.deepEqual(fs.readFileSync(desktop), second);
});
