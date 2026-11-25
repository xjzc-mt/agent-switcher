const { readCredentialFile, accessToken } = require('./helpers/test-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const email = 'portable@example.test';
function login(generation, expiry) {
  return { last_refresh: new Date((expiry - 3600) * 1000).toISOString(), tokens: {
    account_id: 'workspace', id_token: accessToken('workspace', 'owner', email),
    access_token: accessToken('workspace', 'owner', email, generation, expiry), refresh_token: generation,
  } };
}

if (process.argv[2] === 'rpc-fixture') {
  const file = path.join(process.env.CODEX_HOME, 'auth.json');
  let auth = JSON.parse(fs.readFileSync(file, 'utf8'));
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialized') return;
    let result = {}, error;
    if (method === 'account/read') {
      if (params.refreshToken) {
        assert.equal(auth.tokens.refresh_token, 'exported');
        auth = login('renewed', Math.floor(Date.now() / 1000) + 3600);
        fs.writeFileSync(file, JSON.stringify(auth));
      }
      result = { account: { type: 'chatgpt', email } };
    } else if (method === 'account/rateLimits/read') {
      const bearer = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url'));
      if (bearer.exp <= Date.now() / 1000) error = { code: 401 };
      else result = { rateLimits: { planType: 'plus', primary: { usedPercent: 18 } } };
    }
    process.stdout.write(JSON.stringify(error ? { id, error } : { id, result }) + '\n');
  });
} else require('node:test').test('Windows imports a portable Codex backup, switches, and persists an expired session renewal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-windows-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  t.mock.method(os, 'tmpdir', () => root);
  process.env.ProgramData = path.join(root, 'ProgramData');
  for (const key of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete process.env[key];
  require('./helpers/test-env.cjs').installMockKeychain();
  const { atomicWrite } = require('../dist/utils');
  const store = require('../dist/store'), backup = require('../dist/backup'), accounts = require('../dist/accounts');
  const { codexAgent } = require('../dist/agents/codex');
  const name = 'Portable', file = path.join(store.profileDir('codex', name), 'auth.json');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  atomicWrite(file, JSON.stringify(login('exported', Math.floor(Date.now() / 1000) - 60)));
  const archive = await backup.exportBackup([{ agent: 'codex', profile: name }], 'portable-password');
  fs.rmSync(store.STORE_DIR, { recursive: true });

  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  require('../dist/credential-vault').setCredentialKeyProvider({
    read: () => Buffer.alloc(32, 9), create() { throw new Error('Fixture key already exists'); },
  });
  const target = await backup.parseBackup(archive, 'portable-password');
  assert.deepEqual((await backup.installBackup(target, target.items.map(item => item.key))).imported, ['codex/' + name]);
  t.mock.method(require('../dist/windows-desktop'), 'runningWindowsClients', async () => []);
  t.mock.method(require('../dist/client-logout'), 'runningCodexSessions', async () => []);
  await accounts.useAccount(codexAgent, name);
  const live = path.join(codexAgent.homeDir, 'auth.json');
  assert.equal(JSON.parse(fs.readFileSync(live)).tokens.refresh_token, 'exported');

  // Only the Store desktop is installed; exercise the same discovery path as a real refresh.
  process.env.LOCALAPPDATA = path.join(root, 'LocalAppData');
  process.env.APPDATA = path.join(root, 'AppData');
  process.env.PATH = path.dirname(process.execPath);
  delete process.env.CODEX_CLI_PATH;
  delete process.env.CODEX_INSTALL_DIR;
  const cli = path.join(process.env.LOCALAPPDATA, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0',
    'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin', '8aaf1547b825b104', 'codex.exe');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'fixture');
  const cp = require('node:child_process'), spawn = cp.spawn;
  t.mock.method(cp, 'spawn', (binary, args, options) => {
    assert.equal(binary, cli);
    assert.equal(args[0], 'app-server');
    assert.notEqual(options.env.CODEX_HOME, codexAgent.homeDir);
    return spawn(process.execPath, [__filename, 'rpc-fixture'], options);
  });
  const status = await accounts.refreshAccount(codexAgent, name, true);
  assert.equal(status.quota?.primaryWindow?.usedPercent, 18, status.extra);
  assert.equal(JSON.parse(fs.readFileSync(live)).tokens.refresh_token, 'renewed');
  assert.deepEqual(readCredentialFile(file), fs.readFileSync(live));
  assert.equal(store.getActiveProfile('codex'), name);
});
