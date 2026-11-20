const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const cp = require('node:child_process');
const windows = require('../dist/windows-processes');
const temp = require('../dist/temporary-credentials');
const { runningCodexSessions } = require('../dist/client-logout');
const { isolatedCodexPids } = require('../dist/codex-process');

function asWindows(t) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value:'win32' });
  t.after(() => Object.defineProperty(process, 'platform', original));
}

test('Windows live session detection excludes a local isolated query and propagates an unknown inventory', async t => {
  asWindows(t);
  const inventory = t.mock.method(windows, 'windowsCodexProcesses', async () => [201,202]);
  isolatedCodexPids.add(201);
  t.after(() => isolatedCodexPids.delete(201));
  assert.deepEqual(await runningCodexSessions({ failClosed:true }), [202]);
  t.mock.method(require('../dist/store'), 'withStoreLock', task => task());
  t.mock.method(require('../dist/store'), 'profileDir', () => 'fixture-directory');
  const agent = { id:'codex', switchSupport:() => undefined, credentials:() => ({}) };
  await assert.rejects(require('../dist/accounts').useAccount(agent, 'fixture'), /先退出 Codex/);
  inventory.mock.mockImplementation(async () => { throw new Error('inventory unavailable'); });
  await assert.rejects(runningCodexSessions({ failClosed:true }), /inventory unavailable/);
});

test('Windows recovery needs both boot records to change and preserves a pending write after reboot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-boot-test-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  asWindows(t);
  t.mock.method(os, 'homedir', () => root);
  t.mock.method(os, 'tmpdir', () => root);
  const boot = t.mock.method(windows, 'windowsBoot', async () => '12:133820340000000002');
  t.mock.method(process, 'kill', pid => {
    assert.equal(pid, 301);
    throw Object.assign(new Error('fixture process has exited'), { code:'ESRCH' });
  });
  await Promise.all([temp.initializeTemporaryBoot(), temp.initializeTemporaryBoot()]);
  for (const [prior, pending, removed] of [
    ['11:133820340000000001', false, true], ['11:133820340000000001', true, false],
    ['11:133820340000000002', false, false], ['12:133820340000000001', false, false], [undefined, false, false],
  ]) {
    const directory = temp.createTemporaryCredentials('quota');
    const file = path.join(directory,'.ags-temporary-owner.json');
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(owner.windowsBoot, '12:133820340000000002');
    fs.writeFileSync(file, JSON.stringify({ ...owner, pid:301, windowsBoot:prior, pendingCommit:pending, processes:[{pid:302,group:false}] }));
    fs.writeFileSync(path.join(directory, 'auth.json'), 'fixture');
    assert.equal(temp.reapTemporaryCredentials().removed.includes(directory), removed);
    assert.equal(fs.existsSync(path.join(directory, 'auth.json')), !removed);
  }
  assert.equal(boot.mock.callCount(), 1);
});

test('Windows CIM reports a disposable Codex-named fixture for the current user', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true',
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-session-test-'));
  const binary = path.join(directory, 'codex-app-server.exe');
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  fs.copyFileSync(process.execPath, binary);
  const child = cp.spawn(binary, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], { stdio:['ignore','pipe','ignore'], windowsHide:true });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    assert.ok((await windows.windowsCodexProcesses()).includes(child.pid));
  } finally { child.kill(); await exited; }
});
