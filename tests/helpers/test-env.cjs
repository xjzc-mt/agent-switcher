const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createTestHome(prefix, { mockKeychain = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  os.homedir = () => root;
  process.env.HOME = root;
  if (process.platform === 'win32') process.env.USERPROFILE = root;
  process.env.CODEX_HOME = path.join(root, '.codex');
  if (mockKeychain) installMockKeychain();
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Call only after selecting the fixture home. Some suites capture native methods before installing the mock.
function installMockKeychain() {
  if (!process.env.CODEX_HOME || !path.resolve(process.env.CODEX_HOME).startsWith(os.homedir() + path.sep)) {
    process.env.CODEX_HOME = path.join(os.homedir(), '.codex');
  }
  require('../../dist/credential-vault').setCredentialKeyProvider({
    read: () => Buffer.alloc(32, 7),
    create: () => { throw new Error('The fixture key already exists'); },
  });
  const native = require('../../dist/antigravity-native');
  native.readNativeToken = () => null;
  native.writeNativeToken = () => { throw new Error('Native credential writes need an explicit fixture'); };
}

function mockIdleClients() {
  const clients = require('../../dist/clients');
  clients.runningClients = async () => [];
  require('../../dist/client-logout').runningCodexSessions = async () => [];
  return clients;
}

function readCredentialFile(file, encoding) {
  const bytes = require('../../dist/utils').readBuffer(file);
  if (bytes === null) throw Object.assign(new Error('Fixture file not found'), { code: 'ENOENT' });
  return encoding ? bytes.toString(encoding) : bytes;
}

function jwt(claims) {
  return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
}

function accessToken(workspace, sub, email, generation, exp) {
  return jwt({ sub, jti: generation, exp, 'https://api.openai.com/profile': { email },
    'https://api.openai.com/auth': { chatgpt_account_id: workspace } });
}

function mockKeychainCommands(initial) {
  const original = childProcess.execFileSync;
  const encode = bytes => bytes ? 'go-keyring-base64:' + bytes.toString('base64') : null;
  const state = { stored: encode(initial), itemRevision: 'original-ref-and-date', writes: 0, failWrite: false, failDelete: false, corruptAfterWrite: false, corruptNextRead: false };
  childProcess.execFileSync = (cmd, args, opts) => {
    assert.ok(args.every(arg => !String(arg).includes('go-keyring-base64:')));
    const nativeDelete = cmd === '/usr/bin/osascript' && args.some(arg => String(arg).includes('SecItemDelete'));
    if (nativeDelete || (cmd === '/usr/bin/security' && args[0] === 'delete-generic-password')) {
      if (nativeDelete) {
        assert.ok(args.some(arg => String(arg).includes('SecKeychainSetUserInteractionAllowed(false)')));
        assert.ok(args.some(arg => String(arg).includes('m_ItemList')));
        assert.ok(args.every(arg => !String(arg).includes('NSTask')));
        const { raw, revision } = JSON.parse(String(opts.input));
        state.beforeRetireCheck?.();
        if (state.stored === null) throw Object.assign(new Error('missing'), { status: 44 });
        if (revision !== state.itemRevision || ((state.nativeReadable || state.verifyRetiredPayload) && raw !== state.stored)) {
          throw Object.assign(new Error('item changed'), { status: 78 });
        }
      }
      state.onDelete?.();
      if (state.failDelete) throw new Error('mock delete failed');
      state.stored = null;
      state.nativeReadable = false;
      return '';
    }
    if (cmd === '/usr/bin/osascript') {
      assert.equal(opts?.input, undefined);
      if (args.at(-1).includes('AGS_SECURITY_READ_ROUTE')) {
        state.routeReads = (state.routeReads || 0) + 1;
        state.sharedScript = args.at(-1);
        if (state.sharedUnavailable || state.ambiguous) throw Object.assign(new Error('unavailable fixture'), { status: state.ambiguous ? 78 : 77 });
        if (state.stored === null) throw Object.assign(new Error('missing'), { status: 44 });
        if (state.nativeReadable || state.allowNoUiRead) return 'N' + state.stored;
        return 'T' + state.itemRevision;
      }
      if (args.some(arg => String(arg).includes('AGS_SHARED_QUOTA_REVISION'))) {
        state.sharedScript = args.at(-1);
        if (state.sharedUnavailable) throw Object.assign(new Error('locked or ambiguous fixture'), { status: 77 });
        if (state.stored === null) throw Object.assign(new Error('missing'), { status: 44 });
        return state.itemRevision;
      }
      if (args.some(arg => String(arg).includes('AGS_KEYCHAIN_REVISION'))) {
        if (state.stored === null) throw Object.assign(new Error('missing'), { status: 44 });
        return state.itemRevision;
      }
      if (state.stored === null) throw Object.assign(new Error('missing'), { status: 44 });
      if (state.nativeReadable || state.allowNoUiRead) return state.stored;
      throw Object.assign(new Error('fixture is readable by the official security tool'), { status: 77 });
    }
    assert.equal(cmd, '/usr/bin/security');
    if (args[0] === 'find-generic-password') {
      state.toolReads = (state.toolReads || 0) + 1;
      if (args.includes('-w') && state.deniedReads !== undefined) {
        state.deniedReads++;
        throw Object.assign(new Error('fixture read denied'), { status: 51 });
      }
      if (state.corruptNextRead && args.includes('-w')) { state.corruptNextRead = false; return 'go-keyring-base64:' + Buffer.from('corrupt').toString('base64'); }
      if (state.stored === null) throw Object.assign(new Error('missing'), { status: 44 });
      return state.stored;
    }
    assert.equal(args[0], '-i');
    assert.ok(Buffer.byteLength(opts.input) < 4000);
    if (state.deniedWrites !== undefined) {
      state.deniedWrites++;
      throw Object.assign(new Error('fixture write denied'), { status: 51 });
    }
    if (state.failWrite) throw new Error('mock security write failed');
    state.writes++;
    state.onWrite?.();
    state.stored = opts.input.match(/-w "([^"]*)"/)[1];
    if (state.corruptAfterWrite) { state.corruptAfterWrite = false; state.corruptNextRead = true; }
    return '';
  };
  return { state, encode, restore: () => { childProcess.execFileSync = original; } };
}

module.exports = { mockKeychainCommands, mockIdleClients, createTestHome, installMockKeychain, readCredentialFile, jwt, accessToken };
