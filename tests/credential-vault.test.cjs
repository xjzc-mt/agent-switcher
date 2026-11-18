const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const childProcess = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-vault-test-'));
os.homedir = () => root;
const vault = require('../dist/credential-vault');
const { atomicWrite, readBuffer, readJsonFile } = require('../dist/utils');
const pool = path.join(root, '.agent-switcher');
const auth = Buffer.from(JSON.stringify({ tokens: { account_id: 'fixture-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh' } }));
const file = (profile = 'A', agent = 'codex', name = 'auth.json') => path.join(pool, agent, profile, name);
const rawWrite = (target, data) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); };
let key, creations, restore;
beforeEach(() => {
  restore?.();
  fs.rmSync(pool, { recursive: true, force: true });
  key = null; creations = 0;
  restore = vault.setCredentialKeyProvider({ read: () => key, create: value => { creations++; key = Buffer.from(value); } });
});
after(() => { restore?.(); fs.rmSync(root, { recursive: true, force: true }); });

test('pool bytes are encrypted, native client files and metadata retain their formats', () => {
  atomicWrite(file(), auth);
  const encrypted = fs.readFileSync(file());
  assert.ok(encrypted.subarray(0, 18).toString().startsWith('AGS-CREDENTIALS-1'));
  assert.equal(encrypted.includes(Buffer.from('fixture-refresh')), false);
  assert.deepEqual(readBuffer(file()), auth);
  assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  const live = path.join(root, '.codex', 'auth.json');
  const meta = path.join(path.dirname(file()), '_meta.json');
  atomicWrite(live, auth); atomicWrite(meta, '{"label":"A"}');
  assert.deepEqual(fs.readFileSync(live), auth);
  assert.equal(fs.readFileSync(meta, 'utf8'), '{"label":"A"}');
  assert.equal(creations, 1);
});

test('encrypted staged imports and renamed profiles remain readable without rebinding credentials', () => {
  const staged = path.join(pool, '.import-fixture', 'codex', 'A', 'auth.json');
  atomicWrite(staged, auth);
  const bytes = fs.readFileSync(staged);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.renameSync(staged, file());
  fs.renameSync(path.dirname(file()), path.dirname(file('renamed')));
  assert.deepEqual(readBuffer(file('renamed')), auth);
  assert.deepEqual(fs.readFileSync(file('renamed')), bytes);
  rawWrite(file('other', 'claude', '.credentials.json'), bytes);
  assert.throws(() => readBuffer(file('other', 'claude', '.credentials.json')), /校验失败/);
});

test('legacy migration verifies each encrypted disk copy before replacing its original', () => {
  rawWrite(file(), auth);
  const native = path.join(root, 'live', 'auth.json');
  rawWrite(native, auth);
  assert.deepEqual(readBuffer(file()), auth);
  assert.equal(key, null, 'reading a legacy pool must not require system key initialization');
  assert.deepEqual(vault.migrateCredentialPool(), { migrated: 1 });
  assert.notDeepEqual(fs.readFileSync(file()), auth);
  assert.deepEqual(readBuffer(file()), auth);
  assert.deepEqual(fs.readFileSync(native), auth);
  assert.deepEqual(vault.migrateCredentialPool(), { migrated: 0 });
});

test('failed disk verification leaves the legacy credentials intact and removes its temporary copy', () => {
  rawWrite(file(), auth);
  const write = fs.writeFileSync;
  fs.writeFileSync = function(target, bytes, ...args) {
    if (String(target).startsWith(file() + '.') && String(target).endsWith('.tmp')) {
      bytes = Buffer.from(bytes); bytes[bytes.length - 1] ^= 1;
    }
    return write.call(this, target, bytes, ...args);
  };
  try { assert.throws(() => vault.migrateCredentialPool(), /校验失败/); }
  finally { fs.writeFileSync = write; }
  assert.deepEqual(fs.readFileSync(file()), auth);
  assert.deepEqual(fs.readdirSync(path.dirname(file())), ['auth.json']);
});

test('key loss blocks writes while already unlocked reads remain available for recovery export', () => {
  atomicWrite(file(), auth);
  const encrypted = fs.readFileSync(file());
  key = null;
  assert.deepEqual(readBuffer(file()), auth);
  assert.throws(() => vault.assertCredentialWriteReady(file()), /密钥不存在/);
  assert.throws(() => atomicWrite(file(), Buffer.from('{}')), /密钥不存在/);
  assert.throws(() => atomicWrite(file('B'), auth), /密钥不存在/);
  assert.equal(creations, 1);
  assert.deepEqual(fs.readFileSync(file()), encrypted);
  assert.equal(fs.existsSync(file('B')), false);
  const resetSession = vault.setCredentialKeyProvider({ read: () => null, create: () => { throw new Error('must not recreate'); } });
  try { assert.throws(() => readJsonFile(file()), /密钥不存在/); }
  finally { resetSession(); }
});

test('replaced key and damaged ciphertext cannot silently overwrite an existing generation', () => {
  atomicWrite(file(), auth);
  const encrypted = fs.readFileSync(file()), previousKey = key;
  key = Buffer.alloc(32, 4);
  assert.deepEqual(readBuffer(file()), auth);
  assert.throws(() => vault.assertCredentialWriteReady(file()), /密钥已变化/);
  assert.throws(() => atomicWrite(file(), auth), /密钥已变化/);
  assert.throws(() => atomicWrite(file('B'), auth), /密钥已变化/);
  assert.throws(() => vault.migrateCredentialPool(), /密钥已变化/);
  assert.deepEqual(fs.readFileSync(file()), encrypted);
  key = previousKey;
  const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] ^= 1;
  fs.writeFileSync(file(), damaged);
  assert.throws(() => readJsonFile(file()), /校验失败/);
  assert.throws(() => atomicWrite(file(), auth), /校验失败/);
  assert.deepEqual(fs.readFileSync(file()), damaged);
  damaged[0] = 0;
  fs.writeFileSync(file(), damaged);
  assert.throws(() => readJsonFile(file()), /格式异常/);
  assert.throws(() => atomicWrite(file(), auth), /格式异常/);
  assert.deepEqual(fs.readFileSync(file()), damaged);
});

test('dashboard-style repeated reads unlock once, while writes and migration recheck the system key', () => {
  atomicWrite(file(), auth); atomicWrite(file('B'), auth);
  let reads = 0;
  const resetSession = vault.setCredentialKeyProvider({ read: () => { reads++; return key; }, create: () => { throw new Error('unexpected creation'); } });
  try {
    for (let n = 0; n < 100; n++) {
      assert.deepEqual(readBuffer(file()), auth);
      assert.deepEqual(readBuffer(file('B')), auth);
    }
    assert.equal(reads, 1, '200 profile reads should not launch 200 Keychain commands');
    const beforeCheck = fs.readFileSync(file());
    vault.assertCredentialWriteReady(file());
    assert.equal(reads, 2, 'renewal readiness must recheck the system even with an unlocked read cache');
    assert.deepEqual(fs.readFileSync(file()), beforeCheck, 'readiness must not change credentials');
    atomicWrite(file(), auth);
    const afterWrite = reads;
    assert.ok(afterWrite > 1, 'a cached read key must not authorize writes');
    vault.migrateCredentialPool();
    assert.ok(reads > afterWrite, 'migration must not rely on the read cache');
    key = null;
    assert.throws(() => vault.migrateCredentialPool(), /密钥不存在/);
    assert.deepEqual(readBuffer(file()), auth);
  } finally { resetSession(); }
});

test('key save verification failure preserves plaintext and leaves no credential staging file', () => {
  rawWrite(file(), auth);
  const reset = vault.setCredentialKeyProvider({ read: () => null, create: () => {} });
  try { assert.throws(() => vault.migrateCredentialPool(), /密钥保存后校验失败/); }
  finally { reset(); }
  assert.deepEqual(fs.readFileSync(file()), auth);
  assert.deepEqual(fs.readdirSync(path.dirname(file())), ['auth.json']);
  assert.equal(fs.existsSync(path.join(pool, '.vault-key.lock')), false);
});

test('a concurrent external credential write wins over migration', () => {
  rawWrite(file(), auth);
  const newer = Buffer.from('{"tokens":{"refresh_token":"newer-fixture"}}');
  const write = fs.writeFileSync;
  let replaced = false;
  fs.writeFileSync = function(target, bytes, ...args) {
    const result = write.call(this, target, bytes, ...args);
    if (!replaced && String(target).startsWith(file() + '.') && String(target).endsWith('.tmp')) {
      replaced = true; write.call(this, file(), newer);
    }
    return result;
  };
  try { assert.throws(() => vault.migrateCredentialPool(), /迁移期间凭据发生变化/); }
  finally { fs.writeFileSync = write; }
  assert.deepEqual(fs.readFileSync(file()), newer);
});

test('vault rejects symlink directory escapes and does not touch external credentials', () => {
  const external = path.join(root, 'external');
  rawWrite(path.join(external, 'auth.json'), auth);
  fs.mkdirSync(path.join(pool, 'codex'), { recursive: true });
  fs.symlinkSync(external, path.dirname(file()));
  assert.throws(() => readBuffer(file()), /普通目录|符号链接/);
  assert.throws(() => atomicWrite(file(), Buffer.from('{}')), /普通目录|符号链接/);
  assert.throws(() => vault.migrateCredentialPool(), /符号链接/);
  assert.deepEqual(fs.readFileSync(path.join(external, 'auth.json')), auth);
});

test('active key initialization is not overwritten; a dead process lock is recoverable', () => {
  rawWrite(path.join(pool, '.vault-key.lock'), String(process.pid));
  assert.throws(() => atomicWrite(file(), auth), /正在初始化/);
  assert.equal(creations, 0);
  fs.writeFileSync(path.join(pool, '.vault-key.lock'), '2147483647');
  atomicWrite(file(), auth);
  assert.deepEqual(readBuffer(file()), auth);
  assert.equal(creations, 1);
});

test('macOS system provider uses stdin and verifies the saved key without overwriting an existing item', { skip: process.platform !== 'darwin' }, () => {
  const exec = childProcess.execFileSync, calls = [];
  let systemKey;
  childProcess.execFileSync = (command, args, options) => {
    calls.push({ command, args, input: options.input });
    assert.equal(command, '/usr/bin/security');
    if (args[0] === 'find-generic-password') {
      if (!systemKey) throw Object.assign(new Error('fixture missing'), { status: 44 });
      return systemKey;
    }
    assert.deepEqual(args, ['-i']);
    assert.doesNotMatch(options.input, / -U /);
    systemKey = options.input.match(/-w "([^"]+)"/)[1];
    return '';
  };
  restore(); restore = undefined;
  try {
    atomicWrite(file(), auth);
    assert.deepEqual(readBuffer(file()), auth);
    assert.equal(calls.filter(call => call.args[0] === '-i').length, 1);
    for (const call of calls) assert.equal(call.args.join(' ').includes(systemKey), false);
  } finally { childProcess.execFileSync = exec; }
});
