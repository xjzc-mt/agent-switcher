const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-switch-recovery-'));
os.homedir = () => root;
require('./vault-fixture.cjs');
const recovery = require('../dist/antigravity-switch-recovery');
const { readBuffer } = require('../dist/utils');
const { ANTIGRAVITY_SWITCH_FILE } = require('../dist/credential-vault');
const journal = path.join(root, '.agent-switcher', ANTIGRAVITY_SWITCH_FILE);
const files = ['desktop', 'cli'].map(name => path.join(root, name));
const old = Buffer.from('previous-private-token'), target = Buffer.from('next-private-token');
const capture = file => ({ path: file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null, mode: 0o600 });
const write = (file, bytes) => bytes === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, bytes, { mode: 0o600 });
const restore = (before, current) => {
  assert.deepEqual(capture(before.path).bytes, current.bytes);
  write(before.path, before.bytes);
};
const recover = (keychain, replace = restore) => recovery.recoverPendingSwitch(() => keychain, files, capture, replace);
function begin(keychain) {
  files.forEach(file => write(file, old));
  recovery.beginSwitchRecovery(keychain, target, files.map(capture));
}
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a restarted process restores the files from its sealed journal when the original Keychain item still exists', () => {
  write(files[0], old);
  write(files[1], null);
  const script = `
    const fs=require('node:fs'), os=require('node:os');
    os.homedir=()=>process.argv[1];
    require('./tests/vault-fixture.cjs');
    const files=process.argv.slice(2), next=Buffer.from('next-private-token');
    require('./dist/antigravity-switch-recovery').beginSwitchRecovery('mock-keychain',next,
      files.map(path=>({path,bytes:fs.existsSync(path)?fs.readFileSync(path):null,mode:0o600})));
    fs.writeFileSync(files[0],next);
    process.exit(23);
  `;
  const child = spawnSync(process.execPath, ['-e', script, root, ...files], { cwd: path.join(__dirname, '..') });
  assert.equal(child.status, 23, child.stderr.toString());
  const raw = fs.readFileSync(journal);
  assert.ok(raw.toString('utf8', 0, 18).startsWith('AGS-CREDENTIALS-1'));
  for (const secret of [old, target, Buffer.from('mock-keychain')]) {
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes(secret.toString('base64')), false);
  }
  recover('mock-keychain');
  assert.deepEqual(files.map(file => capture(file).bytes), [old, null]);
  assert.equal(recovery.hasPendingAntigravitySwitch(), false);
  recovery.recoverPendingSwitch(() => assert.fail('no Keychain read without a record'), files, capture, restore);
});

test('both target files survive completed retirement; an interrupted rollback can retry', () => {
  begin('prior');
  files.forEach(file => write(file, target));
  recover(null);
  assert.deepEqual(files.map(file => capture(file).bytes), [target, target]);
  begin(null);
  write(files[0], target);
  assert.throws(() => recover(null, () => { throw Error('temporary write failure'); }), /temporary write/);
  assert.ok(recovery.hasPendingAntigravitySwitch());
  recover(null);
  assert.deepEqual(files.map(file => capture(file).bytes), [old, old]);
});

test('external logins survive recovery and retain the encrypted pre-switch evidence', () => {
  for (const live of ['external', 'prior', null]) {
    begin('prior');
    write(files[0], target);
    write(files[1], Buffer.from('external-file'));
    const previousArchives = new Set(fs.readdirSync(path.dirname(journal)));
    assert.throws(() => recover(live), /加密恢复副本/);
    assert.deepEqual(capture(files[0]).bytes, live === 'prior' ? old : target);
    assert.equal(capture(files[1]).bytes.toString(), 'external-file');
    const archive = fs.readdirSync(path.dirname(journal)).find(name => !previousArchives.has(name));
    assert.ok(archive.startsWith('.antigravity-switch.retained-'));
    assert.equal(JSON.parse(readBuffer(path.join(path.dirname(journal), archive))).keychain, 'prior');
  }
  begin('prior');
  write(files[0], target);
  let reads = 0;
  assert.throws(() => recovery.recoverPendingSwitch(
    () => reads++ ? 'external' : 'prior', files, capture, () => assert.fail('external login is active'),
  ), /加密恢复副本/);
  assert.deepEqual(capture(files[0]).bytes, target);
  const vault = require('../dist/credential-vault');
  const reset = vault.setCredentialKeyProvider({ read: () => null, create: () => assert.fail('recovery requires the original key') });
  try {
    const profile = path.join(root, '.agent-switcher', 'agy', 'test', 'jetski-standalone-oauth-token');
    assert.throws(() => vault.encodeCredentialFile(profile, target), /账号池密钥不存在/);
  } finally { reset(); }
});

test('plaintext or damaged journals cannot authorize writes or contact Keychain', () => {
  fs.writeFileSync(journal, '{}');
  assert.throws(() => recovery.recoverPendingSwitch(() => assert.fail(), files, capture, restore), /加密校验/);
  assert.equal(fs.readFileSync(journal, 'utf8'), '{}');
});
