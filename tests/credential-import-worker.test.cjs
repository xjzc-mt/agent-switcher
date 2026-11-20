const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);

test('slow macOS key creation and checks leave the main event loop responsive', { skip: process.platform !== 'darwin' }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ags-vault-worker-')));
  try {
    const app = path.join(home, 'Applications/Antigravity.app/Contents');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>2.0</string></dict></plist>');
    // Preload in the test subprocess AND its workers. No command reaches Security.framework.
    const mock = path.join(home, 'mock.cjs'), runner = path.join(home, 'runner.cjs');
    fs.writeFileSync(mock, `
      const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      const { isMainThread } = require('node:worker_threads');
      assert.equal(process.permission.has('child'), false);
      const key = path.join(process.env.HOME, 'mock-key');
      require('node:child_process').execFileSync = (cmd, args, options) => {
        assert.equal(cmd, '/usr/bin/security');
        assert.equal(isMainThread, false, 'import key access must run in a worker');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        fs.appendFileSync(key + '.calls', args[0] + '\\n');
        if (args[0] === 'find-generic-password') {
          if (fs.existsSync(key)) return fs.readFileSync(key, 'utf8');
          throw Object.assign(new Error('mock item missing'), { status: 44 });
        }
        assert.equal(args[0], '-i');
        fs.writeFileSync(key, options.input.match(/-w "([^"]+)"/)[1], { flag: 'wx', mode: 0o600 });
        return '';
      };
    `);
    fs.writeFileSync(runner, `
      const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      const { installBackup, parseCredentials } = require(path.resolve('dist/backup'));
      (async () => {
        const data = Buffer.from(JSON.stringify({ OPENAI_API_KEY: 'synthetic-worker-test' }));
        const parsed = await parseCredentials(data, 'codex', 'new');
        const keys = parsed.items.map(item => item.key);
        let beats = 0;
        const timer = setInterval(() => beats++, 5);
        try { assert.equal((await installBackup(parsed, keys)).imported.length, 1); }
        finally { clearInterval(timer); }
        assert.ok(beats >= 5, 'timers must run during slow secure storage operations');
        const key = path.join(process.env.HOME, 'mock-key');
        assert.equal(fs.readFileSync(key + '.calls', 'utf8').trim().split('\\n').length, 6);
        fs.unlinkSync(key);
        await assert.rejects(installBackup(parsed, keys), /密钥不存在/);
        assert.equal(fs.existsSync(key), false, 'a cached key forbids re-creation after loss');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
    const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
    delete env.NODE_OPTIONS;
    const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
    const args = [permission, '--allow-worker', '--no-warnings', '--allow-fs-read=' + process.cwd(),
      '--allow-fs-read=' + home, '--allow-fs-write=' + home, '--require', mock, runner];
    const { stderr } = await run(process.execPath, args, { env, timeout: 15000 });
    assert.equal(stderr, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
