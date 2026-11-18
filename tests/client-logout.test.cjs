const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-client-logout-'));
os.homedir = () => root;
process.env.CODEX_HOME = path.join(root, 'codex');
const authEnvironment = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
const priorEnvironment = Object.fromEntries(authEnvironment.map(key => [key, process.env[key]]));
const originalExecFile = cp.execFile, originalExists = fs.existsSync;
let processes = '', desktops = [], keychain, keychainWrites = [], managedConfig = false;
cp.execFile = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  assert.equal(command, '/bin/ps', 'Only the mocked process inventory may run');
  assert.deepEqual(args, ['-axo', 'pid=,comm=']);
  queueMicrotask(() => done(null, processes, ''));
  return { pid: 1234 };
};
cp.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
  cp.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
fs.existsSync = file => ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'].includes(file)
  ? managedConfig : originalExists(file);
require('./vault-fixture.cjs');
const clients = require('../dist/clients');
clients.runningClients = async () => desktops;
const native = require('../dist/antigravity-native');
native.readNativeToken = () => keychain;
native.writeNativeToken = value => { keychainWrites.push(value); keychain = value; };
const { CodexAgent } = require('../dist/agents/codex');
const { AntigravityAgent } = require('../dist/agents/antigravity');
const { logoutSupport, assertLogoutReady, clearClientCredentials } = require('../dist/client-logout');
const { credentialState } = require('../dist/credential-state');
const { atomicWrite } = require('../dist/utils');
const codex = new CodexAgent();
const nativeAgent = new AntigravityAgent(() => 'unified', true);
const auth = (account = 'A', generation = 1) => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
  account_id: account, access_token: `access-${account}-${generation}`, refresh_token: `refresh-${account}-${generation}`,
  id_token: 'h.' + Buffer.from(JSON.stringify({ sub: 'user-' + account, email: `${account}@example.test` })).toString('base64url') + '.s',
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
  desktops = []; processes = '100 /usr/bin/node\n'; keychain = nativeAuth(); keychainWrites = []; managedConfig = false;
  put('A'); config('cli_auth_credentials_store = "file"\n');
});
after(() => {
  cp.execFile = originalExecFile; fs.existsSync = originalExists;
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

macTest('explicit root-level file authentication is supported and unrelated processes do not block logout', async () => {
  config('# Local configuration\ncli_auth_credentials_store = \'file\' # explicit\n[projects."example"]\ntrust_level = "trusted"\n');
  assert.equal(logoutSupport(codex), undefined);
  await assertLogoutReady(codex);
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

macTest('running desktop, CLI and IDE Codex processes prevent automatic logout', async () => {
  desktops = ['Codex']; await assert.rejects(assertLogoutReady(codex)); desktops = [];
  for (const executable of ['/opt/bin/codex', '/Applications/IDE.app/Contents/Resources/codex-cli']) {
    processes = `100 ${executable}\n`;
    await assert.rejects(assertLogoutReady(codex));
  }
  assert.equal(codex.identity().id, 'A:user-A');
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
  processes = '211 /Users/example/.local/bin/agy\n';
  await assert.rejects(assertLogoutReady(nativeAgent));
  processes = '212 /Applications/Editor.app/Contents/Resources/language_server\n';
  await assert.rejects(assertLogoutReady(nativeAgent));
  assert.equal(keychainWrites.length, 0);
  processes = '100 /usr/bin/node\n'; await assertLogoutReady(nativeAgent);
  const identity = nativeAgent.identity().id, revision = credentialState(nativeAgent).revision;
  keychain = nativeAuth('B');
  assert.throws(() => clearClientCredentials(nativeAgent, identity, revision));
  assert.equal(keychainWrites.length, 0);
  keychain = nativeAuth('A');
  clearClientCredentials(nativeAgent, identity, revision);
  assert.equal(keychain, null);
  assert.deepEqual(keychainWrites, [null]);
});

macTest('legacy Antigravity and Claude credentials remain unsupported for automatic logout', async () => {
  const legacy = new AntigravityAgent(() => 'legacy', false);
  assert.equal(typeof logoutSupport(legacy), 'string');
  await assert.rejects(assertLogoutReady(legacy));
  assert.equal(typeof logoutSupport({ id: 'claude' }), 'string');
  assert.equal(keychainWrites.length, 0);
});
