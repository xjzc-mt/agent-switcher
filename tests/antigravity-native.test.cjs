const { mockKeychainCommands, createTestHome, installMockKeychain, readCredentialFile, jwt } = require('./helpers/test-env.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const childProcess = require('node:child_process');
const root = createTestHome('ags-native-test-', { mockKeychain: false });
// The recovery entry rechecks shared sessions. Keep its inventory independent of the desktop running the tests.
const { promisify } = require('node:util');
const originalExecFile = childProcess.execFile;
const fixtureExec = (...args) => originalExecFile(...args);
fixtureExec[promisify.custom] = (file, args, ...rest) =>
  file === '/bin/ps' && args.join(' ') === '-xo pid=,pgid=,comm=' ? Promise.resolve({ stdout: '', stderr: '' })
    : promisify(originalExecFile)(file, args, ...rest);
childProcess.execFile = fixtureExec;
const { readNativeToken: realReadNative, writeNativeToken: realWriteNative } = require('../dist/antigravity-native');
childProcess.execFile = originalExecFile;
installMockKeychain();
const native = require('../dist/antigravity-native');
const clients = require('../dist/clients');
const { AntigravityAgent } = require('../dist/agents/antigravity');
const { saveAccount, useAccount, refreshAccount, needsUnmanagedChoice, clientSwitchRevision } = require('../dist/accounts');
const store = require('../dist/store');
const { profileDir, listProfiles } = store;
const { atomicWrite } = require('../dist/utils');
const { credentialState } = require('../dist/credential-state');
const token = (email, generation = 1) => Buffer.from(JSON.stringify({ auth_method: 'consumer',
  id_token_email: email, token: { access_token: `fake-access-${email}-${generation}`, refresh_token: `fake-refresh-${email}`, expiry: new Date(1795000000000 + generation * 60000).toISOString() } }));
let live = token('a@example.test');
native.readNativeToken = () => live;
native.writeNativeToken = bytes => { live = bytes; };
native.sharedAntigravitySessions = async () => [];
clients.runningClients = async () => [];
const agent = new AntigravityAgent(() => 'unified', true);

test('legacy JWT and unified email retain the same personal identity after refresh', () => {
  const legacy = { auth_method: 'consumer', token: { refresh_token: 'fake-refresh' },
    id_token: jwt({ sub: 'google-subject', email: 'b@example.test' }) };
  assert.equal(agent.identityFromAuth(legacy).id, agent.identityFromAuth(JSON.parse(token('b@example.test'))).id);
  assert.doesNotThrow(() => native.parseNativeToken(Buffer.from(JSON.stringify(legacy))));
  const unsupported = [{}, { auth_method: 'business', token: { refresh_token: 'fake' } },
    { auth_method: 'consumer', token: { refresh_token: 'fake' } },
    ...[{}, '   '].map(refresh_token => ({ ...legacy, token: { refresh_token } })),
  ];
  for (const value of unsupported) {
    const bytes = Buffer.from(JSON.stringify(value));
    assert.throws(() => native.parseNativeToken(bytes), /个人 Google/);
    assert.equal(agent.identityFromBytes(bytes), undefined);
  }
  assert.throws(() => native.parseNativeToken(Buffer.from('not-json')), /格式无效/);
});

test('quota preserves backend buckets and treats missing or disabled values as unknown', () => {
  const data = { groups: [{ name: 'Gemini', buckets: [
    { id: 'weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-11-20T00:00:00Z' },
    { id: '5h', name: 'Five hours', window: '5h', remaining_fraction: 0 },
    { id: 'unknown', name: 'Unknown' },
    { id: 'disabled', name: 'Disabled', remaining_fraction: 0, disabled: true },
  ] }] };
  const result = native.quotaFromUsage(data, 'a@example.test');
  const buckets = result.quota.buckets;
  assert.equal(buckets[0].label, 'Gemini');
  assert.deepEqual(buckets[0].windows.map(w => [w.windowMins, w.usedPercent]), [[300, 100], [10080, 25]]);
  assert.equal(buckets[0].windows[1].resetsAt, Date.parse('2026-11-20T00:00:00Z') / 1000);
  assert.equal(result.account, 'a@example.test');
  assert.throws(() => native.quotaFromUsage({}, 'a@example.test'), /未返回/);
});

const largeToken = (email, size = 8000) => Buffer.from(JSON.stringify({
  ...JSON.parse(token(email)), id_token: 'x'.repeat(size),
}));

// Each official client has its own fallback and one-hour marker. Model its next startup
// separately from AGS so an incorrect AGS resolver cannot make the assertion pass.
function officialLogin(state, file, marker, now) {
  const fileOnly = fs.existsSync(marker) && now - fs.statSync(marker).mtimeMs < 3600_000;
  if (!fileOnly && state.stored !== null) {
    return Buffer.from(state.stored.slice('go-keyring-base64:'.length), 'base64');
  }
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function assertBothClients(state, paths, expected) {
  for (const [file, marker] of [[paths.desktop, paths.desktopMarker], [paths.cli, paths.cliMarker]]) {
    assert.deepEqual(officialLogin(state, file, marker, Date.now()), expected);
    assert.deepEqual(officialLogin(state, file, marker, Date.now() + 7200_000), expected);
    if (fs.existsSync(file)) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
}

test('explicit switching supports empty, compact, and long Keychain logins across both official clients', { skip: process.platform !== 'darwin' }, async () => {
  const small = token('small@example.test');
  const big = largeToken('large@example.test'), next = largeToken('next-large@example.test', 1024 * 1024 - 1024);
  const targets = new Map([['A1-small', small], ['A1-large', big], ['A1-next', next]]);
  for (const [name, bytes] of targets) {
    atomicWrite(path.join(profileDir('agy', name), agent.authFiles[0]), bytes);
  }
  const cases = [
    { previous: null, names: ['A1-large', 'A1-next', 'A1-small'] },
    { previous: small, names: ['A1-large'] },
    { previous: small, nativeReadable: true, names: ['A1-large'] },
    { previous: largeToken('old-long@example.test'), names: ['A1-small'] },
  ];
  for (const { previous, nativeReadable, names } of cases) {
    await withMockKeychain(previous, async ({ state, paths, writeFile }) => {
      state.nativeReadable = nativeReadable;
      if (previous) {
        writeFile(paths.desktopMarker, '', nativeReadable ? 7200_000 : 0);
        writeFile(paths.cliMarker, '', nativeReadable ? 0 : 7200_000);
      }
      for (const [index, name] of names.entries()) {
        const bytes = targets.get(name);
        const requiresConsent = index === 0;
        assert.equal(native.assertNativeSwitchReady(bytes) === 'files', requiresConsent);
        if (previous === small && !nativeReadable) {
          const before = state.stored;
          await assert.rejects(useAccount(agent, name, { saveUnmanaged: false }), /确认文件存储/);
          assert.equal(state.stored, before);
          assert.equal(fs.existsSync(paths.desktop), false);
        }
        await useAccount(agent, name, { saveUnmanaged: false, allowFileMigration: requiresConsent });
        assertBothClients(state, paths, bytes);
        assert.deepEqual(realReadNative(), bytes);
        assert.equal(store.getActiveProfile('agy'), name);
      }
    });
  }
});

test('long credential migration preserves the original login and active card until the final retirement succeeds', { skip: process.platform !== 'darwin' }, async t => {
  const previous = largeToken('retirement-old@example.test');
  const target = largeToken('retirement-new@example.test');
  const outside = token('external-login@example.test');
  const oldProfile = 'A1-retire-old', newProfile = 'A1-retire-new';
  atomicWrite(path.join(profileDir('agy', oldProfile), agent.authFiles[0]), previous);
  atomicWrite(path.join(profileDir('agy', newProfile), agent.authFiles[0]), target);

  for (const failAt of ['second-file', 'active-card', 'new-login', 'new-cli-login', 'last-item-replacement', 'delete-timeout', 'timeout-after-delete']) {
    await t.test(failAt, async t => withMockKeychain(previous, async ({ state, paths, encode, writeFile }) => {
      store.setActiveProfile('agy', oldProfile);
      writeFile(paths.cli, previous);
      const before = state.stored;
      let attempted = false;
      if (failAt === 'second-file') {
        const rename = fs.renameSync;
        t.mock.method(fs, 'renameSync', (from, to) => {
          if (to === paths.cli && !attempted) { attempted = true; throw new Error('CLI file write failed'); }
          return rename(from, to);
        });
      } else if (['active-card', 'new-login', 'new-cli-login'].includes(failAt)) {
        const save = store.setActiveProfile;
        t.mock.method(store, 'setActiveProfile', (id, name) => {
          if (name === newProfile) {
            attempted = true;
            assert.equal(state.stored, before, 'the original keychain item must survive metadata failure');
            if (failAt === 'active-card') throw new Error('active card write failed');
            if (failAt === 'new-login') state.stored = encode(outside);
            else writeFile(paths.cli, outside);
          }
          return save(id, name);
        });
      } else if (failAt === 'last-item-replacement') {
        state.beforeRetireCheck = () => {
          attempted = true;
          state.itemRevision = 'replacement-ref-and-date';
        };
      } else {
        state.onDelete = () => {
          attempted = true;
          assert.deepEqual(fs.readFileSync(paths.desktop), target);
          assert.deepEqual(fs.readFileSync(paths.cli), target);
          if (failAt === 'timeout-after-delete') state.stored = null;
          throw Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' });
        };
      }
      const switching = useAccount(agent, newProfile, { saveUnmanaged: false, allowFileMigration: true });
      if (failAt === 'timeout-after-delete') {
        await switching;
        assert.equal(state.stored, null);
        assertBothClients(state, paths, target);
        assert.equal(store.getActiveProfile('agy'), newProfile);
      } else {
        await assert.rejects(switching);
        assert.equal(state.stored, failAt === 'new-login' ? encode(outside) : before);
        assert.equal(store.getActiveProfile('agy'), oldProfile);
        assert.equal(fs.existsSync(paths.desktop), false);
        assert.deepEqual(fs.readFileSync(paths.cli), failAt === 'new-cli-login' ? outside : previous);
      }
      assert.equal(attempted, true);
    }));
  }
});

test('a long switch recovers empty and truncated entries without replacing protected formats', { skip: process.platform !== 'darwin' }, async () => {
  const target = largeToken('recovered@example.test');
  const name = 'A1-recover-damaged';
  atomicWrite(path.join(profileDir('agy', name), agent.authFiles[0]), target);
  for (const raw of ['', ('go-keyring-base64:' + largeToken('truncated@example.test').toString('base64')).slice(0, 4030)]) {
    await withMockKeychain(null, async ({ state, paths }) => {
      state.stored = raw;
      assert.equal(native.assertNativeSwitchReady(target), 'files');
      await assert.rejects(useAccount(agent, name), /allow-file-storage/);
      state.failDelete = true;
      await assert.rejects(useAccount(agent, name, { allowFileMigration: true }), /移除旧钥匙串/);
      assert.equal(state.stored, raw);
      assert.ok(!fs.existsSync(paths.desktop) && !fs.existsSync(paths.cli));
      state.failDelete = false;
      await useAccount(agent, name, { allowFileMigration: true });
      assert.equal(state.stored, null);
      for (const file of [paths.desktop, paths.cli]) assert.deepEqual(fs.readFileSync(file), target);
    });
  }
  await withMockKeychain(null, async ({ state, paths, encode }) => {
    for (const raw of ['unrecognized-format', encode(Buffer.from('{"auth_method":"enterprise"}'))]) {
      state.stored = raw;
      await assert.rejects(useAccount(agent, name, { allowFileMigration: true }), /尚未支持|非个人/);
      assert.equal(state.stored, raw);
      assert.ok(!fs.existsSync(paths.desktop) && !fs.existsSync(paths.cli));
    }
  });
});

test('an external logout during long-credential migration remains logged out in both clients', { skip: process.platform !== 'darwin' }, async t => {
  const old = token('logout-old@example.test'), target = largeToken('logout-target@example.test');
  const oldName = 'A1-logout-old', targetName = 'A1-logout-target';
  atomicWrite(path.join(profileDir('agy', oldName), agent.authFiles[0]), old);
  atomicWrite(path.join(profileDir('agy', targetName), agent.authFiles[0]), target);
  for (const when of ['with desktop file cleanup', 'during retirement']) {
    await t.test(when, async t => withMockKeychain(old, async ({ state, paths, encode, writeFile }) => {
      store.setActiveProfile('agy', oldName);
      for (const file of [paths.desktop, paths.cli]) writeFile(file, old);
      writeFile(paths.desktopMarker, '');
      writeFile(paths.cliMarker, '', 7200_000);
      const originals = new Set(fs.readdirSync(store.STORE_DIR));
      let loggedOut = false;
      const logout = () => {
        for (const file of [paths.desktop, paths.cli]) assert.deepEqual(fs.readFileSync(file), target);
        loggedOut = true;
        state.stored = null;
      };
      if (when !== 'during retirement') {
        const save = store.setActiveProfile;
        t.mock.method(store, 'setActiveProfile', (id, name) => {
          if (name === targetName) {
            logout();
            fs.unlinkSync(paths.desktop);
          }
          return save(id, name);
        });
      } else {
        state.beforeRetireCheck = logout;
      }
      await assert.rejects(useAccount(agent, targetName, { saveUnmanaged: false, allowFileMigration: true }), /加密恢复副本/);
      assert.ok(loggedOut);
      assert.equal(state.stored, null);
      assertBothClients(state, paths, null);
      assert.equal(realReadNative(), null);
      const archives = fs.readdirSync(store.STORE_DIR).filter(name => !originals.has(name) && name.startsWith('.antigravity-switch.retained-'));
      assert.equal(archives.length, 1);
      const archive = path.join(store.STORE_DIR, archives[0]);
      assert.ok(fs.readFileSync(archive).subarray(0, 18).toString().startsWith('AGS-CREDENTIALS-1'));
      const record = JSON.parse(readCredentialFile(archive, 'utf8'));
      assert.equal(record.keychain, encode(old));
      assert.deepEqual(record.before.map(file => file.data), [old, old].map(bytes => bytes.toString('base64')));
    }));
  }
});

test('a later explicit switch reconciles an uncertain Keychain retirement or preserves an intervening login', { skip: process.platform !== 'darwin' }, async () => {
  const { hasPendingAntigravitySwitch } = require('../dist/antigravity-switch-recovery');
  const old = largeToken('recovery-old@example.test'), target = largeToken('recovery-target@example.test');
  const external = token('recovery-outside@example.test');
  const name = 'A1-uncertain-target';
  atomicWrite(path.join(profileDir('agy', name), agent.authFiles[0]), target);
  const switchTarget = () => useAccount(agent, name, { saveUnmanaged: false, allowFileMigration: true });
  for (const externalLogin of [false, true]) {
    await withMockKeychain(old, async ({ state, paths, encode }) => {
      state.onDelete = () => {
        state.deniedReads = 0;
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      };
      await assert.rejects(switchTarget(), /恢复记录/);
      assert.ok(hasPendingAntigravitySwitch());
      for (const file of [paths.desktop, paths.cli]) assert.deepEqual(fs.readFileSync(file), target);
      delete state.deniedReads;
      delete state.onDelete;
      native.retryNativeKeychainAccess();
      if (externalLogin) {
        state.stored = encode(external);
        await assert.rejects(switchTarget(), /外部|已变化/);
        assert.equal(state.stored, encode(external));
        for (const file of [paths.desktop, paths.cli]) assert.deepEqual(fs.readFileSync(file), target);
      } else {
        await switchTarget();
        assertBothClients(state, paths, target);
        assert.equal(store.getActiveProfile('agy'), name);
      }
      assert.equal(hasPendingAntigravitySwitch(), false);
    });
  }
});

test('background refresh never migrates a Keychain login and explicit switching can repair it', { skip: process.platform !== 'darwin' }, async () => {
  const small = token('small@example.test'), big = largeToken('large@example.test');
  atomicWrite(path.join(profileDir('agy', 'A1-format-small'), agent.authFiles[0]), small);
  await withMockKeychain(small, async ({ state, paths, encode }) => {
    assert.throws(() => realWriteNative(big));
    assert.equal(state.stored, encode(small));
    assert.equal(fs.existsSync(paths.desktop), false);
    assert.equal(fs.existsSync(paths.cli), false);
    state.stored = 'go-keyring-base64:' + Buffer.from('{"truncated":').toString('base64');
    await useAccount(agent, 'A1-format-small', { expectedCurrentRevision: clientSwitchRevision(agent) });
    assert.deepEqual(realReadNative(), small);
  });
});

test('long renewal migrates the exact idle login and reuses private same-session files while the desktop stays open', { skip: process.platform !== 'darwin' }, async t => {
  const name = 'renew-long', small = token('renew-long@example.test'), big = largeToken('renew-long@example.test');
  await withMockKeychain(small, async ({ paths, state, encode, writeFile }) => {
    const revision = credentialState(agent).revision, files = { [agent.authFiles[0]]: big };
    let running = ['Antigravity'];
    t.mock.method(clients, 'runningClients', async () => running);
    const accounts = require('../dist/accounts');
    const providers = accounts.ALL_AGENTS.splice(0, accounts.ALL_AGENTS.length, agent);
    t.after(() => accounts.ALL_AGENTS.splice(0, 1, ...providers));
    const poolFile = path.join(profileDir('agy', name), agent.authFiles[0]);
    atomicWrite(poolFile, small);
    store.writeProfileMeta('agy', name, { snapshot: { available: true, state: 'expired', authExpired: true, credentialRevision: revision } });
    const saved = await accounts.updateAccountCredentials(accounts.credentialUpdateTarget(agent, name), files, undefined, { trusted: true });
    assert.match(saved.warning, /切换/);
    assert.deepEqual(readCredentialFile(poolFile), big);
    assert.equal(state.stored, encode(small));
    assert.equal(accounts.dashboard()[0].profiles.find(p => p.name === name).isActive, false);
    running = [];
    writeFile(paths.cli, token('other-login@example.test'));
    await assert.rejects(agent.writeRenewedCredentials(files, revision), /其他登录/);
    assert.equal(state.stored, encode(small));
    fs.unlinkSync(paths.cli);
    await useAccount(agent, name, { allowFileMigration: true });
    assert.deepEqual(readCredentialFile(poolFile), big);
    assert.equal(store.readProfileMeta('agy', name).pendingLiveRevision, undefined);
    assertBothClients(state, paths, big);
    assert.equal(state.stored, null);
    assert.deepEqual(native.readSharedQuotaLogin(realReadNative([])), big);
    running = ['Antigravity'];
    assert.deepEqual((await useAccount(agent, name)).files, []);
    assert.equal(native.hasPendingNativeCleanup(), false);
    fs.chmodSync(paths.cli, 0o640);
    assert.equal(native.readSharedQuotaLogin(realReadNative([])), undefined);
    assert.equal(native.hasPendingNativeCleanup(), true);
  });
});

test('idle current-account refresh writes the long official successor to the pool and both clients', { skip: process.platform !== 'darwin' }, async t => {
  const name = 'idle-long', email = 'idle-long@example.test', small = token(email), long = largeToken(email);
  await withMockKeychain(small, async ({ paths, state }) => {
    const file = path.join(profileDir('agy', name), agent.authFiles[0]);
    atomicWrite(file, small);
    t.mock.method(agent, 'queryCredential', async () => ({ status: { available: true, state: 'ok' }, rotated: long }));
    assert.equal((await refreshAccount(agent, name, true)).state, 'ok');
    assert.deepEqual(readCredentialFile(file), long);
    assertBothClients(state, paths, long);
  });
});

test('first-screen reads keep helpers asynchronous and show an interrupted switch before reading a login', { skip: process.platform !== 'darwin' }, async t => {
  await withMockKeychain(token('dashboard@example.test'), async ({ state, encode }) => {
    const sync = childProcess.execFileSync, launched = [];
    let switchDuringRead = false;
    const asyncRead = t.mock.method(childProcess, 'execFile', (file, args, opts, cb) => {
      launched.push(file);
      setImmediate(() => {
        try {
          const raw = sync(file, args, opts);
          if (switchDuringRead && file === '/usr/bin/security') {
            state.itemRevision = 'replaced-during-read';
            state.stored = encode(token('new-desktop@example.test'));
            switchDuringRead = false;
          }
          cb(null, raw);
        } catch (error) { cb(Object.assign(error, { code: error.status })); }
      });
    });
    const wrapper = read => native.withDashboardNativeSnapshot(true, read);
    childProcess.execFileSync = () => assert.fail('dashboard blocked on a native credential helper');
    try {
      assert.deepEqual(await wrapper(() => realReadNative()), token('dashboard@example.test'));
      assert.deepEqual(launched, ['/usr/bin/osascript', '/usr/bin/security', '/usr/bin/osascript']);
      assert.equal(state.routeReads, 1);
      const journal = path.join(root, '.agent-switcher', '.antigravity-switch.pending');
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.writeFileSync(journal, 'synthetic unfinished switch');
      try {
        await assert.rejects(wrapper(() => native.readUnavailableDesktopQuotaFile()), /切换中断/);
        assert.equal(asyncRead.mock.callCount(), 3);
      } finally { fs.unlinkSync(journal); }
      switchDuringRead = true;
      await assert.rejects(wrapper(() => realReadNative()), /无法读取/);
      assert.deepEqual(await wrapper(() => realReadNative()), token('new-desktop@example.test'));
    } finally { childProcess.execFileSync = sync; }
  });
});

test('denied tool reads stay blocked for the same item revision and a changed official login becomes visible', { skip: process.platform !== 'darwin' }, async () => {
  const initial = token('permission@example.test');
  await withMockKeychain(initial, async ({ state, encode }) => {
    try {
      state.deniedReads = 0;
      for (let i = 0; i < 3; i++) assert.throws(realReadNative, /无法读取/);
      assert.equal(state.deniedReads, 1);
      state.allowNoUiRead = true;
      assert.deepEqual(realReadNative(), initial);
      assert.equal(state.deniedReads, 1, 'an available no-UI reader skips the denied tool');
      delete state.deniedReads;
      delete state.allowNoUiRead;
      const changed = token('official-switch@example.test');
      state.stored = encode(changed);
      state.itemRevision = 'official-replaced-item';
      assert.deepEqual(realReadNative(), changed, 'observe an external switch without clearing the denial manually');

      state.deniedWrites = 0;
      const target = token('target@example.test');
      for (let i = 0; i < 3; i++) assert.throws(() => realWriteNative(target), /无法更新|写入被拒/);
      assert.equal(state.deniedWrites, 1);
      assert.equal(state.stored, encode(changed));
      delete state.deniedWrites;
      native.retryNativeKeychainAccess();
      realWriteNative(target);
      assert.deepEqual(realReadNative(), target);
    } finally { native.retryNativeKeychainAccess(); }
  });
});

test('partial native write corruption during switch still rolls back to previous live credentials', async () => {
  live = token('keep@example.test', 1);
  atomicWrite(path.join(profileDir('agy', 'target'), agent.authFiles[0]), token('target@example.test', 1));
  let corrupted = false;
  native.readNativeToken = () => {
    if (corrupted) throw new Error('Antigravity 凭据格式无效');
    return live;
  };
  native.writeNativeToken = bytes => {
    if (!corrupted) { corrupted = true; throw new Error('模拟中途截断损坏'); }
    corrupted = false; live = bytes;
  };
  try {
    await assert.rejects(useAccount(agent, 'target', { saveUnmanaged: false }), /截断损坏/);
    assert.equal(corrupted, false);
    assert.equal(agent.identity().email, 'keep@example.test');
  } finally {
    native.readNativeToken = () => live;
    native.writeNativeToken = bytes => { live = bytes; };
  }
});

function withMockKeychain(initial, fn) {
  const gemini = path.join(root, '.gemini');
  const paths = {
    desktop: path.join(gemini, native.NATIVE_TOKEN_FILE),
    cli: path.join(gemini, 'antigravity-cli/antigravity-oauth-token'),
    desktopMarker: path.join(gemini, 'cache/antigravity-keyring-unavailable'),
    cliMarker: path.join(gemini, 'antigravity-cli/cache/antigravity-keyring-unavailable'),
  };
  fs.rmSync(gemini, { recursive: true, force: true });
  const { state, encode, restore } = mockKeychainCommands(initial);
  native.readNativeToken = realReadNative;
  native.writeNativeToken = realWriteNative;
  const writeFile = (file, content, ageMs = 0) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (ageMs) {
      const ts = (Date.now() - ageMs) / 1000;
      fs.utimesSync(file, ts, ts);
    }
  };
  const finish = () => {
    native.retryNativeKeychainAccess();
    fs.rmSync(gemini, { recursive: true, force: true });
    restore();
    native.readNativeToken = () => live;
    native.writeNativeToken = bytes => { live = bytes; };
  };
  return Promise.resolve().then(() => fn({ state, paths, encode, writeFile })).finally(finish);
}

test('read-only desktop quota observes only a trusted active desktop file, without opening Keychain', { skip: process.platform !== 'darwin' }, async t => {
  const read = native.readActiveDesktopQuotaFile;
  await withMockKeychain(token('other@example.test'), async ({ paths, writeFile }) => {
    let toolCalls = 0;
    childProcess.execFileSync = () => { toolCalls++; assert.fail('read-only desktop probe started a system tool'); };
    const expired = JSON.parse(token('desktop@example.test'));
    expired.token.expiry = '2000-01-01T00:00:00Z';
    const bytes = Buffer.from(JSON.stringify(expired));
    writeFile(paths.desktop, bytes);
    writeFile(paths.cli, token('cli@example.test'));
    assert.equal(read(), undefined);
    writeFile(paths.desktopMarker, '', 7200_000);
    assert.equal(read(), undefined);
    writeFile(paths.desktopMarker, '');
    const copies = [];
    const observed = read(copies);
    assert.deepEqual(observed, bytes);
    assert.deepEqual(copies, []);
    assert.equal(native.readSharedQuotaLogin(observed), undefined);
    const cli = JSON.parse(bytes);
    cli.token.access_token = 'new-cli-access';
    cli.token.expiry = new Date(Date.now() + 3600_000).toISOString();
    writeFile(paths.cli, JSON.stringify(cli));
    assert.deepEqual(read(copies), bytes);
    assert.equal(native.findQuotaBearer(expired, copies).accessToken, cli.token.access_token);
    copies.length = 0;
    fs.chmodSync(paths.cli, 0o666);
    assert.deepEqual(read(copies), bytes);
    assert.deepEqual(copies, []);
    fs.chmodSync(paths.cli, 0o600);
    cli.token.refresh_token = 'independent-file-login';
    writeFile(paths.cli, JSON.stringify(cli));
    assert.deepEqual(read(copies), bytes);
    assert.deepEqual(copies, []);
    for (const file of [paths.desktop, paths.desktopMarker]) {
      fs.chmodSync(file, 0o666);
      assert.equal(read(), undefined);
      fs.chmodSync(file, 0o600);
      const alias = file + '.alias';
      fs.linkSync(file, alias);
      assert.equal(read(), undefined);
      fs.unlinkSync(file);
      fs.symlinkSync(alias, file);
      assert.equal(read(), undefined);
      fs.unlinkSync(file);
      fs.renameSync(alias, file);
    }
    const getuid = t.mock.method(process, 'getuid', () => -1);
    try { assert.equal(read(), undefined); } finally { getuid.mock.restore(); }
    fs.chmodSync(path.dirname(paths.desktopMarker), 0o777);
    assert.equal(read(), undefined);
    fs.chmodSync(path.dirname(paths.desktopMarker), 0o700);
    assert.deepEqual(read(), bytes);
    const readFile = fs.readFileSync;
    const changeMarker = t.mock.method(fs, 'readFileSync', (...args) => {
      const data = readFile(...args);
      if (typeof args[0] === 'number') fs.unlinkSync(paths.desktopMarker);
      return data;
    });
    try { assert.equal(read(), undefined); } finally { changeMarker.mock.restore(); }
    writeFile(paths.desktopMarker, '');
    for (const invalid of ['{}', '{"auth_method":"business"}', '{']) {
      writeFile(paths.desktop, invalid);
      assert.equal(read(), undefined);
    }
    assert.equal(toolCalls, 0);
  });
});

test('trusted desktop fallback yields to a readable login and survives an unavailable or ambiguous one', { skip: process.platform !== 'darwin' }, async () => {
  await withMockKeychain(null, async ({ paths, writeFile, state, encode }) => {
    const desktop = token('desktop@example.test'), normal = token('keychain@example.test');
    writeFile(paths.desktop, desktop);
    writeFile(paths.desktopMarker, '');
    const read = native.readUnavailableDesktopQuotaFile;
    assert.equal(read(), undefined, 'an absent keychain item is readable normally');
    state.stored = encode(normal);
    assert.equal(read(), undefined);
    state.sharedUnavailable = true;
    assert.deepEqual(read(), desktop);
    delete state.sharedUnavailable;
    state.ambiguous = true;
    assert.throws(realReadNative, /无法读取/);
    assert.deepEqual(read(), desktop);
    assert.equal(state.toolReads, undefined, 'an ambiguous item must not select a password from the search list');
    delete state.ambiguous;
    state.deniedReads = 0;
    assert.throws(realReadNative, /无法读取/);
    assert.deepEqual(read(), desktop);
    assert.equal(state.deniedReads, 1);
  });
});

test('fallback files (stub, older/newer same identity, pool spare, markers) resolve cleanly and converge on switch', { skip: process.platform !== 'darwin' }, async () => {
  await withMockKeychain(token('fa@example.test', 2), async ({ state, paths, encode, writeFile }) => {
    const expected = realReadNative([]), reads = state.toolReads, sharedLogin = () => native.readSharedQuotaLogin(expected);
    // JXA bridges NSUInteger to a string on macOS. Exercise the actual item selector with inert objects.
    const selector = state.sharedScript.match(/function uniqueItem\(\) \{[\s\S]*?\n  \}/)[0];
    const choose = (count, length) => require('node:vm').runInNewContext(selector + '\nuniqueItem().revision', {
      q: {}, ObjC: { unwrap: x => x }, $: Object.assign(x => x, { exit() { throw new Error('ambiguous'); } }),
      copy: () => ({ count, objectAtIndex: () => ({ objectForKey: key => key === 'mdat'
        ? { timeIntervalSinceReferenceDate: 123 } : { length, base64EncodedStringWithOptions: () => 'fixture' } }) }),
    });
    assert.equal(choose('1', '4'), 'fixture/123');
    assert.throws(() => choose('2', '4'), /ambiguous/);
    assert.throws(() => choose('1', '0'), /ambiguous/);
    assert.deepEqual(sharedLogin(), expected);
    assert.equal(native.readSharedQuotaLogin(Buffer.from(expected)), undefined, 'a pool copy has no live-source observation');
    for (const marker of [paths.cliMarker, paths.desktopMarker]) {
      writeFile(marker, '1'); assert.equal(sharedLogin(), undefined); fs.unlinkSync(marker);
    }
    state.sharedUnavailable = true;
    assert.equal(sharedLogin(), undefined);
    for (let i = 0; i < 2; i++) assert.throws(() => realReadNative([]), /无法读取/);
    delete state.sharedUnavailable;
    state.itemRevision = 'replaced-ref-or-date'; assert.equal(sharedLogin(), undefined);
    assert.equal(state.toolReads, reads, 'eligibility checks never invoke the security executable');
    assert.deepEqual(native.readSharedQuotaLogin(realReadNative([])), expected, 'quota resumes after unlock without a manual reset');
    atomicWrite(path.join(profileDir('agy', 'FB'), agent.authFiles[0]), token('fb@example.test', 1));
    // 1. Logout stub + markers do not block reading, saving, or switching A -> B -> A.
    writeFile(paths.cli, JSON.stringify({ auth_method: 'consumer', token: {} }));
    writeFile(paths.desktopMarker, '1');
    writeFile(paths.cliMarker, '1');
    assert.equal(agent.identity().email, 'fa@example.test');
    await saveAccount(agent, 'FA');
    await useAccount(agent, 'FB');
    assert.equal(agent.identity().email, 'fb@example.test');
    assert.equal(fs.existsSync(paths.cli), false);
    assert.equal(fs.existsSync(paths.desktopMarker), false);
    assert.equal(fs.existsSync(paths.cliMarker), false);
    await useAccount(agent, 'FA');
    assert.equal(agent.identity().email, 'fa@example.test');

    // 2. Older same-identity fallback keeps Keychain gen; newer same-identity fallback wins and syncs to pool.
    writeFile(paths.cli, token('fa@example.test', 1));
    assert.deepEqual(realReadNative(), token('fa@example.test', 2));
    writeFile(paths.cli, token('fa@example.test', 3));
    assert.deepEqual(realReadNative(), token('fa@example.test', 3));
    assert.deepEqual(native.readSharedQuotaLogin(realReadNative([])), token('fa@example.test', 2), 'return canonical bytes even when the file bearer is newer');
    await useAccount(agent, 'FB');
    assert.deepEqual(readCredentialFile(path.join(profileDir('agy', 'FA'), agent.authFiles[0])), token('fa@example.test', 3));
    assert.equal(fs.existsSync(paths.cli), false);

    // 3. CLI fallback holds newer rotation of pool spare account FA -> syncs into FA before switching B -> FA.
    writeFile(paths.cli, token('fa@example.test', 4));
    writeFile(paths.cliMarker, '1');
    assert.equal(agent.identity().email, 'fb@example.test');
    assert.equal(needsUnmanagedChoice(agent, 'FA'), false);
    await useAccount(agent, 'FA');
    assert.deepEqual(realReadNative(), token('fa@example.test', 4));
    assert.deepEqual(readCredentialFile(path.join(profileDir('agy', 'FA'), agent.authFiles[0])), token('fa@example.test', 4));
    assert.equal(fs.existsSync(paths.cli), false);
    assert.equal(fs.existsSync(paths.cliMarker), false);

    // 4. Active desktop marker (<1h) prefers desktop fallback; expired marker (>1h) falls back to Keychain.
    state.stored = encode(token('fa@example.test', 4));
    writeFile(paths.desktop, token('fb@example.test', 2));
    writeFile(paths.desktopMarker, '1', 60_000);
    assert.equal(agent.identity().email, 'fb@example.test');
    writeFile(paths.desktopMarker, '1', 4000_000);
    assert.equal(agent.identity().email, 'fa@example.test');

    const shared = JSON.parse(token('fa@example.test'));
    shared.token.expiry = new Date(Date.now() + 3600000).toISOString();
    state.stored = encode(Buffer.from(JSON.stringify({ ...shared, token: { refresh_token: shared.token.refresh_token } })));
    writeFile(paths.desktop, JSON.stringify({ ...shared, token: { ...shared.token, refresh_token: 'independent', access_token: 'other-bearer' } }));
    const quotaBearer = () => {
      const copies = [];
      return native.findQuotaBearer(native.parseNativeToken(realReadNative(copies)), copies)?.accessToken;
    };
    assert.equal(quotaBearer(), undefined, 'The desktop fallback belongs to an independent login with the same email');
    assert.equal(native.readSharedQuotaLogin(realReadNative([])), undefined);
    writeFile(paths.cli, JSON.stringify(shared));
    assert.equal(quotaBearer(), shared.token.access_token);
  });
});

test('fallback-only auth works with single or same-account files and rejects conflicting accounts', { skip: process.platform !== 'darwin' }, async t => {
  await withMockKeychain(null, async ({ paths, writeFile }) => {
    atomicWrite(path.join(profileDir('agy', 'FB2'), agent.authFiles[0]), token('fb2@example.test', 1));
    // Stub only -> signed out.
    writeFile(paths.cli, '{}');
    assert.equal(realReadNative(), null);

    // Single CLI fallback -> readable, savable, converges to Keychain on switch.
    writeFile(paths.cli, token('only@example.test', 1));
    writeFile(paths.cliMarker, '1');
    assert.equal(agent.identity().email, 'only@example.test');
    await saveAccount(agent, 'ONLY');
    await useAccount(agent, 'FB2');
    assert.equal(agent.identity().email, 'fb2@example.test');
    assert.equal(fs.existsSync(paths.cli), false);
    assert.equal(fs.existsSync(paths.cliMarker), false);
  });

  await withMockKeychain(null, async ({ paths, writeFile, state }) => {
    // Same account in both desktop & CLI picks newer expiry.
    writeFile(paths.desktop, token('same@example.test', 1));
    writeFile(paths.cli, token('same@example.test', 2));
    assert.deepEqual(realReadNative(), token('same@example.test', 2));

    // After the marker expires, the desktop may still have only the refresh token.
    writeFile(paths.desktopMarker, 'old', 7200_000);
    const desktop = JSON.parse(token('same@example.test'));
    delete desktop.token.access_token;
    delete desktop.token.expiry;
    const cli = JSON.parse(token('same@example.test', 2));
    cli.token.expiry = new Date(Date.now() + 3600_000).toISOString();
    writeFile(paths.desktop, JSON.stringify(desktop));
    fs.unlinkSync(paths.cli);
    await saveAccount(agent, 'file-session');
    writeFile(paths.cli, JSON.stringify(cli));
    const copies = [];
    assert.equal(native.findQuotaBearer(native.parseNativeToken(realReadNative(copies)), copies).accessToken, cli.token.access_token);
    await useAccount(agent, 'FB2');
    assert.equal(agent.identity().email, 'fb2@example.test');
    assert.deepEqual(JSON.parse(readCredentialFile(path.join(profileDir('agy', 'file-session'), agent.authFiles[0]))), cli);
    await useAccount(agent, 'file-session');
    assert.deepEqual(JSON.parse(realReadNative()), cli);
    state.stored = null;
    writeFile(paths.desktopMarker, 'active');
    writeFile(paths.desktop, JSON.stringify(desktop));
    await useAccount(agent, 'FB2');
    assert.deepEqual(JSON.parse(readCredentialFile(path.join(profileDir('agy', 'file-session'), agent.authFiles[0]))), cli);
  });

  await withMockKeychain(null, async ({ paths, writeFile }) => {
    // Expiry cannot link independent logins for the same email.
    const original = token('independent@example.test'), other = JSON.parse(token('independent@example.test', 2));
    other.token.refresh_token = 'different-session';
    writeFile(paths.desktop, original);
    writeFile(paths.cli, JSON.stringify(other));
    await assert.rejects(useAccount(agent, 'FB2', { saveUnmanaged: false }), /无法确认新旧/);
    assert.deepEqual(fs.readFileSync(paths.desktop), original);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.cli)), other);
    t.mock.method(clients, 'runningClients', async () => ['Antigravity']);
    const modes = new Map();
    t.mock.method(agent, 'queryCredential', async (bytes, options) => {
      modes.set(JSON.parse(bytes).id_token_email, options.allowRefresh);
      return { status: { available: true, state: 'ok' } };
    });
    atomicWrite(path.join(profileDir('agy', 'shared-file'), agent.authFiles[0]), original);
    for (const name of ['FB2', 'shared-file']) assert.equal((await refreshAccount(agent, name, true)).state, 'ok');
    assert.deepEqual([...modes], [['fb2@example.test', true], ['independent@example.test', false]]);

    // Different accounts in desktop & CLI report conflict and preserve both files.
    const desktopBytes = token('d@example.test', 1), cliBytes = token('c@example.test', 1);
    writeFile(paths.desktop, desktopBytes);
    writeFile(paths.cli, cliBytes);
    assert.throws(() => realReadNative(), /不同账号/);
    assert.deepEqual(fs.readFileSync(paths.desktop), desktopBytes);
    assert.deepEqual(fs.readFileSync(paths.cli), cliBytes);

    // Blocked file alone reports specific reason.
    fs.unlinkSync(paths.desktop);
    writeFile(paths.cli, JSON.stringify({ auth_method: 'business', token: { refresh_token: 'corp' } }));
    assert.throws(() => realReadNative(), /非个人/);
  });
});

test('unmanaged fallback credential requires explicit save or discard choice and never resurrects when discarded', { skip: process.platform !== 'darwin' }, async () => {
  await withMockKeychain(token('ua@example.test', 1), async ({ paths, writeFile }) => {
    await saveAccount(agent, 'UA');
    atomicWrite(path.join(profileDir('agy', 'UB'), agent.authFiles[0]), token('ub@example.test', 1));
    const unmanagedBytes = token('unmanaged@example.test', 1);
    writeFile(paths.cli, unmanagedBytes);
    writeFile(paths.cliMarker, '1');

    assert.equal(needsUnmanagedChoice(agent, 'UB'), true);
    await assert.rejects(useAccount(agent, 'UB'), /明确选择/);
    assert.equal(agent.identity().email, 'ua@example.test');
    assert.deepEqual(fs.readFileSync(paths.cli), unmanagedBytes);

    // Save unmanaged -> archived as backup-*, fallback & marker cleared.
    await useAccount(agent, 'UB', { saveUnmanaged: true });
    const backups = listProfiles('agy').filter(p => /^backup-\d+$/.test(p) && agent.identity(profileDir('agy', p))?.email === 'unmanaged@example.test');
    assert.equal(backups.length, 1);
    assert.equal(fs.existsSync(paths.cli), false);
    assert.equal(fs.existsSync(paths.cliMarker), false);

    // Discard unmanaged -> fallback cleared without recreating a pool entry.
    for (const b of backups) fs.rmSync(profileDir('agy', b), { recursive: true, force: true });
    await useAccount(agent, 'UA');
    writeFile(paths.cli, unmanagedBytes);
    assert.equal(needsUnmanagedChoice(agent, 'UB'), true);
    await useAccount(agent, 'UB', { saveUnmanaged: false });
    assert.equal(fs.existsSync(paths.cli), false);
    assert.equal(listProfiles('agy').some(p => agent.identity(profileDir('agy', p))?.email === 'unmanaged@example.test'), false);
  });
});

test('background commitQuery keeps other-account fallbacks, blocked files stop switch, and failures roll back fully', { skip: process.platform !== 'darwin' }, async () => {
  await withMockKeychain(token('ra@example.test', 1), async ({ state, paths, encode, writeFile }) => {
    await saveAccount(agent, 'RA');
    atomicWrite(path.join(profileDir('agy', 'RB'), agent.authFiles[0]), token('rb@example.test', 1));
    const otherBytes = token('other@example.test', 1);
    writeFile(paths.cli, otherBytes);
    writeFile(paths.cliMarker, '1');

    // Non-switch commitQuery writes rotated A without deleting other-account CLI fallback.
    const rev1 = credentialState(agent).revision;
    agent.commitQuery(agent.homeDir, rev1, { status: { available: true, state: 'ok' }, rotated: token('ra@example.test', 2) });
    assert.deepEqual(realReadNative(), token('ra@example.test', 2));
    assert.deepEqual(fs.readFileSync(paths.cli), otherBytes);
    assert.equal(fs.existsSync(paths.cliMarker), true);

    // Same-identity fallback IS cleaned by commitQuery when no other fallback remains.
    writeFile(paths.cli, token('ra@example.test', 1));
    const rev2 = credentialState(agent).revision;
    agent.commitQuery(agent.homeDir, rev2, { status: { available: true, state: 'ok' }, rotated: token('ra@example.test', 3) });
    assert.equal(fs.existsSync(paths.cli), false);
    assert.equal(fs.existsSync(paths.cliMarker), false);

    // Enterprise or corrupt fallback does not block reading Keychain, but blocks switching and preserves everything.
    for (const [content, pattern] of [
      [JSON.stringify({ auth_method: 'business', token: { refresh_token: 'corp' } }), /非个人/],
      ['{broken-json', /格式无效/],
    ]) {
      writeFile(paths.cli, content);
      writeFile(paths.cliMarker, '1');
      assert.equal(agent.identity().email, 'ra@example.test');
      await assert.rejects(useAccount(agent, 'RB', { saveUnmanaged: false }), err =>
        pattern.test(err.message) && err.message.includes(paths.cli));
      assert.equal(state.stored, encode(token('ra@example.test', 3)));
      assert.equal(fs.readFileSync(paths.cli, 'utf8'), content);
      assert.equal(fs.existsSync(paths.cliMarker), true);
    }

    // Rollback restores Keychain, fallback file, and marker (including mtime) on verification or unlink failure.
    writeFile(paths.cli, otherBytes);
    writeFile(paths.cliMarker, 'marker-body', 120_000);
    const markerMtime = Math.floor(fs.statSync(paths.cliMarker).mtimeMs);
    state.corruptAfterWrite = true;
    await assert.rejects(useAccount(agent, 'RB', { saveUnmanaged: false }), /写入未完成/);
    assert.equal(state.stored, encode(token('ra@example.test', 3)));
    assert.deepEqual(fs.readFileSync(paths.cli), otherBytes);
    assert.equal(fs.readFileSync(paths.cliMarker, 'utf8'), 'marker-body');
    assert.ok(Math.abs(fs.statSync(paths.cliMarker).mtimeMs - markerMtime) < 2000);

    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = file => { if (file === paths.cliMarker) throw new Error('simulated unlink failure'); return realUnlink(file); };
    try {
      await assert.rejects(useAccount(agent, 'RB', { saveUnmanaged: false }), /simulated unlink failure/);
    } finally { fs.unlinkSync = realUnlink; }
    assert.equal(state.stored, encode(token('ra@example.test', 3)));
    assert.deepEqual(fs.readFileSync(paths.cli), otherBytes);
    assert.equal(fs.readFileSync(paths.cliMarker, 'utf8'), 'marker-body');
  });
});

test('background renewal preserves both active file logins and separate refresh tokens', { skip: process.platform !== 'darwin' }, async () => {
  const original = token('files@example.test'), rotated = token('files@example.test', 2);
  const unrelated = token('keychain@example.test'), alternate = JSON.parse(original);
  alternate.token.refresh_token = 'another-session';
  const independent = Buffer.from(JSON.stringify(alternate));
  const commit = () => agent.commitQuery(agent.homeDir, credentialState(agent).revision,
    { status: { available: true, state: 'ok' }, rotated });

  await withMockKeychain(unrelated, async ({ paths, state, writeFile, encode }) => {
    writeFile(paths.desktopMarker, 'desktop');
    writeFile(paths.cliMarker, 'cli');
    writeFile(paths.desktop, original);
    writeFile(paths.cli, original);
    commit();
    assert.deepEqual(officialLogin(state, paths.desktop, paths.desktopMarker, Date.now()), rotated);
    assert.deepEqual(officialLogin(state, paths.cli, paths.cliMarker, Date.now()), rotated);
    assert.equal(state.stored, encode(unrelated));

    writeFile(paths.desktop, original);
    writeFile(paths.cli, independent);
    commit();
    assert.deepEqual(fs.readFileSync(paths.desktop), rotated);
    assert.deepEqual(fs.readFileSync(paths.cli), independent);

    writeFile(paths.desktop, original);
    writeFile(paths.cli, original);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (to === paths.desktop) writeFile(paths.cli, independent);
    };
    try { assert.throws(commit, /文件已变化/); }
    finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(paths.desktop), original);
    assert.deepEqual(fs.readFileSync(paths.cli), independent);
    assert.equal(state.stored, encode(unrelated));
  });
  await withMockKeychain(original, async ({ paths, state, writeFile, encode }) => {
    writeFile(paths.cli, independent);
    writeFile(paths.cliMarker, 'cli');
    commit();
    assert.equal(state.stored, encode(rotated));
    assert.deepEqual(officialLogin(state, paths.cli, paths.cliMarker, Date.now()), independent);
  });
});

test('switching preserves independent Keychain and file logins', { skip: process.platform !== 'darwin' }, async () => {
  // Saving before the switch must include the Keychain login masked by the desktop marker.
  await withMockKeychain(token('masked-a@example.test', 1), async ({ paths, writeFile }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    atomicWrite(path.join(profileDir('agy', 'TARGET-C'), agent.authFiles[0]), token('target-c@example.test', 1));
    writeFile(paths.desktop, token('desk-b@example.test', 1));
    writeFile(paths.desktopMarker, '1', 10_000);

    assert.equal(needsUnmanagedChoice(agent, 'TARGET-C'), true);
    await useAccount(agent, 'TARGET-C', { saveUnmanaged: true });
    const savedEmails = listProfiles('agy').map(p => agent.identity(profileDir('agy', p))?.email).sort();
    assert.deepEqual(savedEmails, ['desk-b@example.test', 'masked-a@example.test', 'target-c@example.test']);
  });

  // Ambiguous generation order (same expiry, different refresh_token) between pool B and CLI fallback B refuses silent deletion.
  await withMockKeychain(token('ka@example.test', 1), async ({ paths, writeFile }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    await saveAccount(agent, 'KA');
    const poolB = Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: 'amb@example.test',
      token: { access_token: 'a1', refresh_token: 'pool-rt', expiry: '2027-05-01T00:00:00Z' } }));
    const cliB = Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: 'amb@example.test',
      token: { access_token: 'a2', refresh_token: 'cli-unique-rt', expiry: '2027-05-01T00:00:00Z' } }));
    atomicWrite(path.join(profileDir('agy', 'AMB'), agent.authFiles[0]), poolB);
    writeFile(paths.cli, cliB);
    await assert.rejects(useAccount(agent, 'AMB'), /无法确认新旧/);
    assert.deepEqual(fs.readFileSync(paths.cli), cliB);
    assert.deepEqual(readCredentialFile(path.join(profileDir('agy', 'AMB'), agent.authFiles[0])), poolB);
  });

  // Restoring a file-only login includes its marker and leaves the Keychain empty.
  await withMockKeychain(null, async ({ state, paths, writeFile }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    atomicWrite(path.join(profileDir('agy', 'FA-ONLY'), agent.authFiles[0]), token('fa-only@example.test', 1));
    atomicWrite(path.join(profileDir('agy', 'FB-TARGET'), agent.authFiles[0]), token('fb-target@example.test', 1));
    writeFile(paths.cli, token('fa-only@example.test', 1));
    writeFile(paths.cliMarker, 'm1', 30_000);
    const origSetActive = store.setActiveProfile;
    store.setActiveProfile = () => { throw new Error('simulated meta.json write failure'); };
    try {
      await assert.rejects(useAccount(agent, 'FB-TARGET'), /meta\.json/);
    } finally { store.setActiveProfile = origSetActive; }
    assert.equal(state.stored, null, 'Keychain must be restored back to empty');
    assert.deepEqual(fs.readFileSync(paths.cli), token('fa-only@example.test', 1));
    assert.equal(fs.readFileSync(paths.cliMarker, 'utf8'), 'm1');
  });

  // Same-identity switch (current A -> target A) with unmanaged B in CLI fallback and saveUnmanaged:false cleans B!
  await withMockKeychain(token('same-a@example.test', 1), async ({ paths, writeFile }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    await saveAccount(agent, 'SAME-A');
    writeFile(paths.cli, token('stray-b@example.test', 1));
    writeFile(paths.cliMarker, '1');
    await useAccount(agent, 'SAME-A', { saveUnmanaged: false });
    assert.equal(fs.existsSync(paths.cli), false);
    assert.equal(fs.existsSync(paths.cliMarker), false);
  });

  // Symlinked fallback directory refuses switch and never deletes files in linked directory.
  await withMockKeychain(token('safe-a@example.test', 1), async ({ paths }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    await saveAccount(agent, 'SAFE-A');
    atomicWrite(path.join(profileDir('agy', 'SAFE-B'), agent.authFiles[0]), token('safe-b@example.test', 1));
    const victimDir = path.join(root, 'victim-dir');
    fs.mkdirSync(victimDir, { recursive: true });
    const victimFile = path.join(victimDir, 'antigravity-oauth-token');
    fs.writeFileSync(victimFile, token('victim@example.test', 1));
    fs.mkdirSync(path.dirname(paths.desktop), { recursive: true });
    fs.symlinkSync(victimDir, path.join(path.dirname(paths.desktop), 'antigravity-cli'));
    await assert.rejects(useAccount(agent, 'SAFE-B', { saveUnmanaged: false }), /符号链接/);
    assert.equal(fs.existsSync(victimFile), true);
  });
});

// Only opt in from a dedicated macOS test user. A different HOME does not isolate SecurityAgent UI.
const dedicatedKeychainUser = process.env.AGS_KEYCHAIN_TEST_USER;
test('explicit isolated macOS user: compact system-readable writes and long credential migration to both official files', {
  skip: process.platform !== 'darwin' || process.env.AGS_REAL_KEYCHAIN_TEST !== '1' ||
    !dedicatedKeychainUser || dedicatedKeychainUser !== os.userInfo().username,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-explicit-keychain-'));
  const kc = path.join(dir, 'Library/Keychains/fixture.keychain-db');
  const env = { ...process.env, HOME: dir };
  fs.mkdirSync(path.dirname(kc), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Library/Preferences'), { recursive: true });
  const security = (...args) => childProcess.execFileSync('/usr/bin/security', args, { env, stdio: 'pipe', timeout: 3000 });
  let created = false;
  try {
    assert.equal(security('list-keychains', '-d', 'user').toString().trim(), '');
    security('create-keychain', '-p', 'fixture', kc);
    created = true;
    security('unlock-keychain', '-p', 'fixture', kc);
    security('list-keychains', '-d', 'user', '-s', kc);
    security('default-keychain', '-d', 'user', '-s', kc);
    childProcess.execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const native = require('./dist/antigravity-native');
      const cp = require('node:child_process');
      const small = Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: 'fixture@example.test', token: { refresh_token: 'fixture' } }));
      const large = Buffer.from(JSON.stringify({ ...JSON.parse(small), id_token: 'x'.repeat(8000) }));
      const read = () => cp.execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], { encoding: 'utf8' }).trim();
      assert.equal(native.readNativeToken(), null);
      const target = { clearFallbacks: 'all', allowFileMigration: true };
      native.writeNativeToken(large, target);
      assert.deepEqual(native.readNativeToken(), large);
      native.writeNativeToken(small, target);
      assert.equal(read(), 'go-keyring-base64:' + small.toString('base64'));
      native.writeNativeToken(large, target);
      assert.throws(read, e => e.status === 44);
      const fs = require('fs'), path = require('path');
      for (const relative of ['jetski-standalone-oauth-token', 'antigravity-cli/antigravity-oauth-token']) {
        const file = path.join(process.env.HOME, '.gemini', relative);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.deepEqual(fs.readFileSync(file), large);
      }
    `], { env, timeout: 10000, cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  } finally {
    if (created) security('delete-keychain', kc);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A2, A4 & B2: same-email independent tokens never merge/delete, rollback only undoes AGS-touched unchanged sources, and Antigravity verifyTarget retains rotated temp dir on usage failure', { skip: process.platform !== 'darwin' }, async () => {
  const makeSameExpiry = (email, rt, expiryIso = '2028-06-01T00:00:00Z') => Buffer.from(JSON.stringify({
    auth_method: 'consumer',
    id_token_email: email,
    token: { access_token: `acc-${rt}-${expiryIso}`, refresh_token: rt, expiry: expiryIso },
  }));

  // A2-1: Keychain & pool hold A (rt1), CLI holds same-email A2 (same expiry, rt2).
  // Switching to B MUST refuse, report conflict, and preserve A2 on disk!
  await withMockKeychain(makeSameExpiry('dup@example.test', 'rt-1'), async ({ paths, writeFile }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    await saveAccount(agent, 'DUP-A');
    atomicWrite(path.join(profileDir('agy', 'TARGET-B'), agent.authFiles[0]), token('target-b@example.test', 1));

    const a2Bytes = makeSameExpiry('dup@example.test', 'rt-2');
    writeFile(paths.cli, a2Bytes);
    await assert.rejects(useAccount(agent, 'TARGET-B', { saveUnmanaged: true }), /无法确认新旧/);
    assert.deepEqual(fs.readFileSync(paths.cli), a2Bytes, 'CLI A2 must not be deleted');

    // Same version can deduplicate cleanly; provably newer expiry keeps newer version in pool:
    writeFile(paths.cli, makeSameExpiry('dup@example.test', 'rt-1'));
    await useAccount(agent, 'TARGET-B', { saveUnmanaged: true });
    assert.equal(fs.existsSync(paths.cli), false);
  });

  // Independent auxiliary logins survive even when their expiries can be ordered.
  await withMockKeychain(token('primary-a@example.test', 1), async ({ paths, writeFile }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    await saveAccount(agent, 'PRIM-A');
    atomicWrite(path.join(profileDir('agy', 'PRIM-B'), agent.authFiles[0]), token('prim-b@example.test', 1));

    const x1 = makeSameExpiry('aux@example.test', 'aux-rt-1', '2028-06-01T00:00:00Z');
    const x2Conflict = makeSameExpiry('aux@example.test', 'aux-rt-2', '2028-06-02T00:00:00Z');
    writeFile(paths.desktop, x1);
    writeFile(paths.cli, x2Conflict);
    await assert.rejects(useAccount(agent, 'PRIM-B', { saveUnmanaged: true }), /无法确认新旧/);
    assert.deepEqual(fs.readFileSync(paths.desktop), x1);
    assert.deepEqual(fs.readFileSync(paths.cli), x2Conflict);

    // Within one session the later copy is saved before both files are cleaned.
    writeFile(paths.desktop, JSON.stringify({ ...JSON.parse(x1), expiry: '2028-07-01T00:00:00Z' }));
    const newer = JSON.parse(makeSameExpiry('aux@example.test', 'aux-rt-1', '2028-06-02T00:00:00Z'));
    newer.expiry = newer.token.expiry;
    delete newer.token.expiry;
    const x2Newer = Buffer.from(JSON.stringify(newer));
    writeFile(paths.cli, x2Newer);
    await useAccount(agent, 'PRIM-B', { saveUnmanaged: true });
    const savedAux = listProfiles('agy').find(p => agent.identity(profileDir('agy', p))?.email === 'aux@example.test');
    assert.ok(savedAux);
    assert.deepEqual(readCredentialFile(path.join(profileDir('agy', savedAux), agent.authFiles[0])), x2Newer);
  });

  // A4: Zero-write precheck failure preserves external login; partial/post-write failure preserves external CLI, Desktop, Keychain logout, and marker changes, and reports failed step + preserved state on incomplete rollback!
  await withMockKeychain(token('a4-init@example.test', 1), async ({ state, paths, encode, writeFile }) => {
    for (const p of listProfiles('agy')) fs.rmSync(profileDir('agy', p), { recursive: true, force: true });
    await saveAccount(agent, 'A4-INIT');
    atomicWrite(path.join(profileDir('agy', 'A4-TARGET'), agent.authFiles[0]), token('a4-target@example.test', 1));
    const origSetActive = store.setActiveProfile;
    const prevShared = native.sharedAntigravitySessions;

    // A4-1: Pre-check failure (sharedAntigravitySessions rejects after external CLI writes C) -> ZERO write, ZERO rollback, C untouched!
    const cliC = token('cli-c@example.test', 1);
    native.sharedAntigravitySessions = async () => {
      writeFile(paths.cli, cliC);
      return [4242];
    };
    try {
      await assert.rejects(useAccount(agent, 'A4-TARGET', { saveUnmanaged: false }), /共用认证/);
    } finally { native.sharedAntigravitySessions = prevShared; }
    assert.deepEqual(fs.readFileSync(paths.cli), cliC, 'pre-check failure must never roll back external CLI file');
    fs.unlinkSync(paths.cli);

    // The official CLI can change its file while the Keychain write is in progress.
    writeFile(paths.cli, token('a4-init@example.test', 1));
    state.onWrite = () => { delete state.onWrite; writeFile(paths.cli, cliC); };
    await assert.rejects(useAccount(agent, 'A4-TARGET', { saveUnmanaged: false }), /认证文件已变化/);
    assert.deepEqual(fs.readFileSync(paths.cli), cliC);
    assert.equal(state.stored, encode(token('a4-init@example.test', 1)));

    // A4-2: Post-write meta.json failure after external CLI writes C, Desktop writes D, marker touched, AND Keychain externally logs out!
    writeFile(paths.cli, token('a4-init@example.test', 1)); // will be deleted by AGS during switch
    const extDesk = token('ext-desk@example.test', 1);
    store.setActiveProfile = () => {
      // External changes arrive right after writeNativeToken finished, before meta.json commits:
      state.stored = null; // External Keychain logout!
      writeFile(paths.cli, cliC); // External CLI new login!
      writeFile(paths.desktop, extDesk); // External Desktop new login (untouched by AGS before)!
      writeFile(paths.cliMarker, 'ext-marker'); // External marker!
      throw new Error('meta commit failed');
    };
    try {
      await assert.rejects(useAccount(agent, 'A4-TARGET', { saveUnmanaged: false }), /meta commit failed/);
    } finally { store.setActiveProfile = origSetActive; }
    assert.equal(state.stored, null, 'rollback must not undo external Keychain logout');
    assert.deepEqual(fs.readFileSync(paths.cli), cliC, 'rollback must not overwrite external CLI login C');
    assert.deepEqual(fs.readFileSync(paths.desktop), extDesk, 'rollback must not delete external Desktop login D');
    assert.equal(fs.readFileSync(paths.cliMarker, 'utf8'), 'ext-marker', 'rollback must preserve external marker');

    // A4-3: Incomplete rollback reports BOTH which restore step failed AND which states were preserved!
    fs.rmSync(path.dirname(paths.desktop), { recursive: true, force: true });
    state.stored = encode(token('a4-init@example.test', 1));
    writeFile(paths.cli, token('a4-init@example.test', 1));
    store.setActiveProfile = () => {
      state.failWrite = true; // Keychain restore will fail, while CLI file restore succeeds!
      throw new Error('meta commit failed 2');
    };
    try {
      await assert.rejects(useAccount(agent, 'A4-TARGET', { saveUnmanaged: false }), err =>
        /Keychain 原状态恢复失败/.test(err.message) && /已恢复.*antigravity-oauth-token/.test(err.message));
    } finally {
      state.failWrite = false;
      store.setActiveProfile = origSetActive;
    }

    // B2 (Antigravity): External credential verification rotates token via ACP, then /usage fails -> temp dir MUST be retained and surfaced!
    const cliMod = require('../dist/antigravity-cli');
    const { createTemporaryCredentials, releaseTemporaryCredentials } = require('../dist/temporary-credentials');
    const origIsolated = cliMod.queryIsolatedUsage;
    let retainedAgyTemp = '';
    cliMod.queryIsolatedUsage = async () => {
      retainedAgyTemp = createTemporaryCredentials('agy-b2');
      return {
        rotated: token('a4-init@example.test', 99),
        error: new Error('模拟 /usage 网络超时'),
        temporaryDirectory: retainedAgyTemp,
      };
    };
    try {
      const q = await agent.queryCredential(token('a4-init@example.test', 2), { verifyTarget: token('a4-init@example.test', 1) });
      assert.equal(q.verifiedReplacement, false);
      assert.ok(retainedAgyTemp && fs.existsSync(retainedAgyTemp), 'rotated Antigravity temp dir must survive usage error');
      assert.ok((q.status.extra || '').includes(retainedAgyTemp));
    } finally {
      cliMod.queryIsolatedUsage = origIsolated;
      if (retainedAgyTemp) releaseTemporaryCredentials(retainedAgyTemp);
    }
  });
});
