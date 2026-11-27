const { mockKeychainCommands, createTestHome, installMockKeychain, jwt } = require('./helpers/test-env.cjs');
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');

const root = createTestHome('ags-client-logout-', { mockKeychain: false });
process.env.CODEX_HOME = path.join(root, 'codex');
const authEnvironment = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
const priorEnvironment = Object.fromEntries(authEnvironment.map(key => [key, process.env[key]]));
const originalExecFile = cp.execFile, originalExists = fs.existsSync;
let allowedProbes = new Set();
let processes = '', desktops = [], keychain, keychainWrites = [], managedConfig = false;
cp.execFile = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  if (command === '/usr/sbin/lsof') {
    const pids = args[args.indexOf('-p') + 1].split(',').map(Number);
    assert.ok(pids.every(pid => allowedProbes.has(pid)), 'Only inspect fixture processes');
    return originalExecFile(command, args, options, done);
  }
  assert.equal(command, '/bin/ps', 'Only the mocked process inventory may run');
  assert.deepEqual(args, ['-xo', 'pid=,pgid=,comm=']);
  queueMicrotask(() => done(null, processes, ''));
  return { pid: 1234 };
};
cp.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
  cp.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
fs.existsSync = file => ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'].includes(file)
  ? managedConfig : originalExists(file);
const native = require('../dist/antigravity-native');
const { readNativeToken: realReadNative, writeNativeToken: realWriteNative } = native;
installMockKeychain();
const clients = require('../dist/clients');
clients.runningClients = async () => desktops;
native.readNativeToken = () => keychain;
native.writeNativeToken = value => { keychainWrites.push(value); keychain = value; };
const { CodexAgent } = require('../dist/agents/codex');
const { AntigravityAgent } = require('../dist/agents/antigravity');
const { logoutSupport, assertLogoutReady, clearClientCredentials } = require('../dist/client-logout');
const { credentialState } = require('../dist/credential-state');
const { atomicWrite } = require('../dist/utils');
const codex = new CodexAgent();
const nativeAgent = new AntigravityAgent(() => 'unified', true, () => ({ state: 'ready' }));
const auth = (account = 'A', generation = 1) => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
  account_id: account, access_token: `access-${account}-${generation}`, refresh_token: `refresh-${account}-${generation}`,
  id_token: jwt({ sub: 'user-' + account, email: `${account}@example.test` }),
} });
const nativeAuth = (account = 'A') => Buffer.from(JSON.stringify({ auth_method: 'consumer', id_token_email: `${account}@example.test`,
  token: { access_token: 'native-access-' + account, refresh_token: 'native-refresh-' + account } }));
const put = (account, generation) => atomicWrite(path.join(codex.homeDir, 'auth.json'), auth(account, generation));
const config = text => fs.writeFileSync(path.join(codex.homeDir, 'config.toml'), text);
const macTest = (name, fn) => test(name, { skip: process.platform !== 'darwin' && 'Automatic client logout is currently macOS only' }, fn);

beforeEach(() => {
  for (const key of authEnvironment) delete process.env[key];
  fs.rmSync(path.join(root, 'codex'), { recursive: true, force: true });
  Object.defineProperty(codex, 'homeDir', { value: path.join(root, 'codex'), configurable: true });
  desktops = []; processes = '100 100 /usr/bin/node\n'; keychain = nativeAuth(); keychainWrites = []; managedConfig = false;
  put('A'); config('cli_auth_credentials_store = "file"\n');
});
after(() => {
  cp.execFile = originalExecFile; fs.existsSync = originalExists;
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

macTest('missing, alternative, ambiguous and multiline credential backend configuration disables automatic logout', () => {
  const bytes = fs.readFileSync(path.join(codex.homeDir, 'auth.json'));
  for (const text of ['', 'cli_auth_credentials_store="auto"', 'cli_auth_credentials_store="keyring"',
    '[profiles.personal]\ncli_auth_credentials_store="file"',
    'cli_auth_credentials_store="file"\ncli_auth_credentials_store="keyring"',
    'cli_auth_credentials_store="file"\n[profiles.personal]\ncli_auth_credentials_store="keyring"',
    'cli_auth_credentials_store="file"\nprompt="""some text"""']) {
    config(text);
    assert.equal(typeof logoutSupport(codex), 'string', text);
    assert.deepEqual(fs.readFileSync(path.join(codex.homeDir, 'auth.json')), bytes);
  }
  fs.unlinkSync(path.join(codex.homeDir, 'config.toml'));
  assert.equal(typeof logoutSupport(codex), 'string');
});

macTest('managed requirements, unknown credential shape and authentication environment overrides stay intact', () => {
  managedConfig = true; assert.equal(typeof logoutSupport(codex), 'string'); managedConfig = false;
  const requirements = path.join(codex.homeDir, 'requirements.toml');
  fs.writeFileSync(requirements, ''); assert.equal(typeof logoutSupport(codex), 'string'); fs.unlinkSync(requirements);
  atomicWrite(path.join(codex.homeDir, 'auth.json'), JSON.stringify({ ...JSON.parse(auth()), accounts: ['unknown-schema'] }));
  assert.equal(typeof logoutSupport(codex), 'string'); put('A');
  for (const key of authEnvironment) {
    process.env[key] = 'fake-env-credential';
    assert.equal(typeof logoutSupport(codex), 'string', key);
    delete process.env[key];
  }
  assert.equal(codex.identity().id, 'A:user-A');
});

macTest('a symlinked client home cannot authorize deletion of its target', () => {
  const original = codex.homeDir, link = path.join(root, 'linked-home');
  fs.symlinkSync(original, link);
  Object.defineProperty(codex, 'homeDir', { value: link, configurable: true });
  assert.equal(typeof logoutSupport(codex), 'string');
  assert.throws(() => clearClientCredentials(codex, 'A:user-A', credentialState(codex).revision));
  assert.equal(fs.existsSync(path.join(original, 'auth.json')), true);
});

macTest('running desktop, CLI and IDE Codex processes prevent automatic logout while isolated AGS queries do not', async () => {
  const { isolatedCodexPids } = require('../dist/codex-process');
  desktops = ['Codex']; await assert.rejects(assertLogoutReady(codex)); desktops = [];
  for (const executable of ['/opt/bin/codex', '/Applications/IDE.app/Contents/Resources/codex-cli']) {
    processes = `100 100 ${executable}\n`;
    await assert.rejects(assertLogoutReady(codex));
  }
  isolatedCodexPids.add(100);
  try { await assertLogoutReady(codex); }
  finally { isolatedCodexPids.delete(100); }
  assert.equal(codex.identity().id, 'A:user-A');
});

macTest('an inconclusive process probe blocks the action and records a redacted timeout', async t => {
  const { initializeDiagnostics, runDiagnostic, exportDiagnostics } = require('../dist/diagnostics');
  const { macDesktopRunning } = require('../dist/macos-desktop');
  initializeDiagnostics(root, '0.1.0');
  t.mock.method(cp, 'execFile', (command, _args, options, callback) => {
    assert.equal(options.timeout, command === '/bin/ps' ? 3000 : 2000);
    callback(Object.assign(new Error('fixture private text'), { killed: true }));
  });
  for (const probe of [() => assertLogoutReady(codex), () => macDesktopRunning('Codex', true)]) {
    await assert.rejects(runDiagnostic('switch', 'codex', 'manual', undefined, probe), /检测.*超时/);
    const record = exportDiagnostics().operations.at(-1);
    assert.equal(record.result, 'timeout');
    assert.deepEqual(record.steps.map(item => item.step), ['process-unknown']);
  }
  assert.equal(await macDesktopRunning('Codex'), false);
});

macTest('a parallel AGS query and its descendants stay isolated while a reused PID or an official CLI stays shared', async t => {
  const source = `
    const fs = require('fs'), os = require('os'), cp = require('child_process');
    os.homedir = () => process.env.AGS_TEST_HOME;
    const api = require(process.env.AGS_LIFECYCLE);
    const dir = api.createTemporaryCredentials('quota');
    const child = api.withTemporaryProcess(dir, () => cp.spawn(process.execPath, ['-e',
      "const cp=require('child_process'), fs=require('fs'); const sub=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)']); fs.writeFileSync('descendant',String(sub.pid));"
    ], {cwd: dir, detached: true, stdio: 'ignore'}));
    child.unref();
    console.log(JSON.stringify({dir, pid:child.pid}));
  `;
  const { dir, pid } = JSON.parse(cp.execFileSync(process.execPath, ['-e', source], { encoding: 'utf8',
    env: { ...process.env, AGS_TEST_HOME: root, AGS_LIFECYCLE: require.resolve('../dist/temporary-credentials') } }));
  t.after(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    allowedProbes.clear();
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const file = path.join(dir, 'descendant');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const descendant = Number(fs.readFileSync(file, 'utf8'));
  const stale = process.pid;
  // A retained marker can still contain a PID that now belongs to another process.
  const marker = path.join(dir, '.ags-temporary-owner.json');
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
  owner.processes.push({pid: stale, group: true});
  fs.writeFileSync(marker, JSON.stringify(owner));
  allowedProbes = new Set([pid, descendant, stale]);
  processes = `${pid} ${pid} /opt/bin/codex
${descendant} ${pid} /opt/bin/codex-cli
${stale} ${stale} /opt/bin/codex
12 12 /opt/bin/codex`;
  const { runningCodexSessions } = require('../dist/client-logout');
  assert.deepEqual(await runningCodexSessions(), [stale, 12]);
  processes = processes.replaceAll('/opt/bin/codex-cli', '/opt/bin/agy').replaceAll('/opt/bin/codex', '/opt/bin/agy');
  assert.deepEqual(await native.sharedAntigravitySessions(), [stale, 12]);
});

macTest('changed account identity or token generation prevents credential removal', () => {
  const identity = codex.identity().id, revision = credentialState(codex).revision;
  put('B'); assert.throws(() => clearClientCredentials(codex, identity, revision));
  assert.equal(codex.identity().id, 'B:user-B');
  put('A', 2); const newer = fs.readFileSync(path.join(codex.homeDir, 'auth.json'));
  assert.throws(() => clearClientCredentials(codex, identity, revision));
  assert.deepEqual(fs.readFileSync(path.join(codex.homeDir, 'auth.json')), newer);
});

macTest('file logout removes auth.json while preserving history and client configuration', async () => {
  config('# Local configuration\ncli_auth_credentials_store = \'file\' # explicit\n[projects."example"]\ntrust_level = "trusted"\n');
  const history = path.join(codex.homeDir, 'history.jsonl'); fs.writeFileSync(history, 'keep user history');
  const configuration = fs.readFileSync(path.join(codex.homeDir, 'config.toml'));
  await assertLogoutReady(codex);
  clearClientCredentials(codex, codex.identity().id, credentialState(codex).revision);
  assert.equal(fs.existsSync(path.join(codex.homeDir, 'auth.json')), false);
  assert.equal(fs.readFileSync(history, 'utf8'), 'keep user history');
  assert.deepEqual(fs.readFileSync(path.join(codex.homeDir, 'config.toml')), configuration);
});

macTest('native Antigravity logout uses its Keychain adapter and waits for shared sessions', async () => {
  assert.equal(logoutSupport(nativeAgent), undefined);
  processes = '211 211 /Users/example/.local/bin/agy\n';
  await assert.rejects(assertLogoutReady(nativeAgent));
  processes = '212 212 /Applications/Editor.app/Contents/Resources/language_server\n';
  await assertLogoutReady(nativeAgent);
  processes = '214 214 /Users/example/.vscode/extensions/google.antigravity-1.2.0/bin/language_server\n';
  await assert.rejects(assertLogoutReady(nativeAgent));
  assert.equal(keychainWrites.length, 0);
  processes = `213 213 ${path.join(root, 'Applications/Antigravity.app/Contents/Resources/language_server')}\n`;
  await assertLogoutReady(nativeAgent);
  processes = '100 100 /usr/bin/node\n'; await assertLogoutReady(nativeAgent);
  const identity = nativeAgent.identity().id, revision = credentialState(nativeAgent).revision;
  keychain = nativeAuth('B');
  assert.throws(() => clearClientCredentials(nativeAgent, identity, revision));
  assert.equal(keychainWrites.length, 0);
  keychain = nativeAuth('A');
  clearClientCredentials(nativeAgent, identity, revision);
  assert.equal(keychain, null);
  assert.deepEqual(keychainWrites, [null]);
});

macTest('legacy Antigravity credentials remain unsupported for automatic logout', async () => {
  const legacy = new AntigravityAgent(() => 'legacy', false);
  assert.equal(typeof logoutSupport(legacy), 'string');
  await assert.rejects(assertLogoutReady(legacy));
  assert.equal(keychainWrites.length, 0);
});

macTest('native Antigravity logout cleans compatible fallbacks and refuses other-account or blocked fallbacks', () => {
  const gemini = path.join(root, '.gemini');
  const cliFile = path.join(gemini, 'antigravity-cli/antigravity-oauth-token');
  const cliMarker = path.join(gemini, 'antigravity-cli/cache/antigravity-keyring-unavailable');
  const desktopFile = path.join(gemini, native.NATIVE_TOKEN_FILE);
  const keychainFixture = mockKeychainCommands(nativeAuth('A'));
  const writeFile = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  native.readNativeToken = realReadNative;
  native.writeNativeToken = realWriteNative;
  try {
    // Other-account, enterprise, or corrupt fallback refuses automatic logout and preserves credentials.
    for (const [content, pattern] of [
      [nativeAuth('B'), /其他账号/],
      [JSON.stringify({ auth_method: 'business', token: { refresh_token: 'corp' } }), /非个人/],
      ['corrupt', /格式无效/],
    ]) {
      writeFile(cliFile, content);
      const reason = logoutSupport(nativeAgent);
      assert.match(reason || '', pattern);
      assert.throws(() => clearClientCredentials(nativeAgent, nativeAgent.identity().id, credentialState(nativeAgent).revision), pattern);
      assert.ok(keychainFixture.state.stored);
      assert.equal(fs.existsSync(cliFile), true);
    }

    // Same-identity fallback + stub + markers are cleared together with Keychain.
    writeFile(cliFile, nativeAuth('A'));
    writeFile(desktopFile, '{}');
    writeFile(cliMarker, '1');
    assert.equal(logoutSupport(nativeAgent), undefined);
    clearClientCredentials(nativeAgent, nativeAgent.identity().id, credentialState(nativeAgent).revision);
    assert.equal(keychainFixture.state.stored, null);
    assert.equal(fs.existsSync(cliFile), false);
    assert.equal(fs.existsSync(desktopFile), false);
    assert.equal(fs.existsSync(cliMarker), false);

    // Fallback-only login (empty Keychain) also logs out cleanly.
    writeFile(cliFile, nativeAuth('A'));
    writeFile(cliMarker, '1');
    assert.equal(logoutSupport(nativeAgent), undefined);
    clearClientCredentials(nativeAgent, nativeAgent.identity().id, credentialState(nativeAgent).revision);
    assert.equal(fs.existsSync(cliFile), false);
    assert.equal(fs.existsSync(cliMarker), false);

    // Symlinked fallback directory refuses logout and never deletes external target files.
    const externalDir = path.join(root, 'external-cli-dir');
    fs.mkdirSync(externalDir, { recursive: true });
    const externalToken = path.join(externalDir, 'antigravity-oauth-token');
    fs.writeFileSync(externalToken, nativeAuth('A'));
    keychainFixture.state.stored = keychainFixture.encode(nativeAuth('A'));
    fs.rmSync(path.join(gemini, 'antigravity-cli'), { recursive: true, force: true });
    fs.mkdirSync(gemini, { recursive: true });
    fs.symlinkSync(externalDir, path.join(gemini, 'antigravity-cli'));
    assert.match(logoutSupport(nativeAgent) || '', /符号链接/);
    assert.throws(() => clearClientCredentials(nativeAgent, 'a@example.test', credentialState(nativeAgent).revision), /符号链接/);
    assert.equal(fs.existsSync(externalToken), true);
  } finally {
    fs.rmSync(gemini, { recursive: true, force: true });
    keychainFixture.restore();
    native.readNativeToken = () => keychain;
    native.writeNativeToken = value => { keychainWrites.push(value); keychain = value; };
  }
});
