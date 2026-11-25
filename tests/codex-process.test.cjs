const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { findWindowsCodexBinary, startCodexProcess } = require('../dist/codex-process');
const { createTemporaryCredentials, releaseTemporaryCredentials } = require('../dist/temporary-credentials');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-codex-process-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function isLiveNonZombie(pid) {
  try { process.kill(pid, 0); }
  catch (err) { return err.code !== 'ESRCH'; }
  if (process.platform === 'win32') return true;
  try {
    const stat = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return Boolean(stat) && !stat.startsWith('Z');
  } catch { return false; }
}

function forceKillCleanup(...pids) {
  for (const pid of pids) {
    if (!pid) continue;
    if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
function cli(name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}

test('Windows desktop discovery selects a complete relocated CLI and honors its explicit override', t => {
  const local = path.join(root, 'LocalAppData'), cache = path.join(local, 'OpenAI', 'Codex', 'bin');
  const previous = Object.fromEntries(['LOCALAPPDATA', 'CODEX_CLI_PATH', 'CODEX_INSTALL_DIR', 'PATH', 'APPDATA'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const key of Object.keys(previous)) delete process.env[key];
  process.env.LOCALAPPDATA = local;
  const runtimes = ['f'.repeat(16), '8aaf1547b825b104', 'staging'];
  for (const [index, name] of runtimes.entries()) {
    const directory = path.join(cache, name);
    fs.mkdirSync(directory, { recursive: true });
    const binary = path.join(directory, 'codex.exe');
    fs.writeFileSync(binary, '');
    fs.utimesSync(binary, index + 1, index + 1);
  }
  const older = path.join(cache, runtimes[0], 'codex.exe'), newest = path.join(cache, runtimes[1], 'codex.exe');
  assert.equal(findWindowsCodexBinary(), newest);
  const packageRoot = path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0');
  const packageCache = path.join(packageRoot, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin');
  const { missingWindowsCodexRuntime } = require('../dist/windows-codex');
  fs.mkdirSync(packageCache, { recursive: true });
  assert.match(missingWindowsCodexRuntime(), /打开 Codex/);
  for (const [index, directory] of [cache, path.join(packageCache, runtimes[0]), packageCache].entries()) {
    fs.mkdirSync(directory, { recursive: true });
    const candidate = path.join(directory, 'codex.exe');
    fs.writeFileSync(candidate, 'fixture');
    fs.utimesSync(candidate, index + 10, index + 10);
    assert.equal(findWindowsCodexBinary(), candidate);
  }
  process.env.CODEX_CLI_PATH = '"' + older + '"';
  assert.equal(findWindowsCodexBinary(), older);
});

test('Windows CLI discovery starts an isolated transport from an npm path with spaces', { timeout: 10000 }, async t => {
  const prefix = path.join(root, 'npm prefix');
  const pkg = path.join(prefix, 'node_modules', '@openai', 'codex');
  const bundled = path.join(pkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(bundled), {recursive:true});
  fs.mkdirSync(path.join(pkg, 'bin'));
  fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '');
  fs.writeFileSync(path.join(prefix, 'codex.cmd'), '@exit /b 1');
  // Node acts as the native test CLI and loads the app-server fixture from its working directory.
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, bundled);
  else fs.symlinkSync(process.execPath, bundled);
  const dirs = ['.','"' + prefix + '"'];
  const standalone = path.join(prefix, 'codex.exe');
  fs.writeFileSync(standalone, '');
  assert.equal(findWindowsCodexBinary(dirs, 'x64'), standalone);
  fs.unlinkSync(standalone);
  const binary = findWindowsCodexBinary(dirs, 'x64');
  assert.equal(binary, bundled);
  const keys = ['OpEnAi_ApI_kEy', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME',
    'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_APP_SERVER_CHATGPT_BASE_URL', 'OPENAI_BASE_URL',
    'OPENAI_FEDERATION_RULE_ID', 'OpEnAi_IdEnTiTy_ToKeN_fIlE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT'];
  fs.writeFileSync(path.join(root, 'app-server'), `
    process.stdin.once('data', data => {
      const request = JSON.parse(data), bytes = Buffer.from(JSON.stringify({id: request.id, text: '额度',
        home: process.env.CODEX_HOME, cwd: process.cwd(), overrides: ${JSON.stringify(keys)}.filter(k => process.env[k]),
        homes:Object.keys(process.env).filter(k=>k.toUpperCase()==='CODEX_HOME')}) + '\\n');
      const split = bytes.indexOf(Buffer.from('额度')) + 1;
      process.stdout.write('noise\\nnull\\n42\\n');
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 20);
    });
  `);
  const inherited = [...keys, 'CoDeX_hOmE'];
  const previous = inherited.map(key => process.env[key]);
  const systemData = process.env.ProgramData;
  process.env.ProgramData = root;
  for (const key of inherited) process.env[key] = 'fixture-override';
  let server, closeCount = 0;
  try {
    const received = new Promise((resolve, reject) => {
      server = startCodexProcess(binary, root, { onMessage: resolve, onError: reject, onClose: () => closeCount++ });
    });
    t.after(() => server.stop());
    server.send({ id: 7 });
    assert.deepEqual(await received, { id: 7, text: '额度', home: root, cwd: fs.realpathSync(root), overrides: [], homes:['CODEX_HOME'] });
    const stopped = server.stop();
    assert.equal(server.stop(), stopped);
    await stopped;
    assert.equal(closeCount, 1);
    server.send({ id: 8 }); // A late write after cancellation must be harmless.
  } finally {
    if (systemData === undefined) delete process.env.ProgramData; else process.env.ProgramData = systemData;
    inherited.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    await server?.stop();
  }
});

test('Windows x64 AGS under ARM emulation can discover the native ARM npm runtime', t => {
  const original = process.env.PROCESSOR_ARCHITEW6432;
  t.after(() => {
    if (original === undefined) delete process.env.PROCESSOR_ARCHITEW6432;
    else process.env.PROCESSOR_ARCHITEW6432 = original;
  });
  process.env.PROCESSOR_ARCHITEW6432 = 'ARM64';
  const bin = path.join(root, 'arm npm');
  const cli = path.join(bin, 'node_modules', '@openai', 'codex');
  const binary = path.join(cli, 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe');
  fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  for (const f of [path.join(bin, 'codex.cmd'), path.join(cli, 'bin', 'codex.js'), binary]) fs.writeFileSync(f, '');
  assert.equal(findWindowsCodexBinary([bin], 'x64'), binary);
});

test('shutdown reaps a child and its process-group descendants when ignoring EOF and SIGTERM, and when leader exits early on EOF', { timeout: 15000 }, async t => {
  t.mock.method(os, 'homedir', () => root);
  t.mock.method(os, 'tmpdir', () => root);
  // Case 1: Entire group ignores EOF and SIGTERM -> escalated SIGKILL cleans group and temporary credentials directory.
  const temp1 = createTemporaryCredentials('quota');
  const stubborn = cli('stubborn', `
    const { spawn } = require('child_process');
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    const sub = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
    console.log(JSON.stringify({ pid: process.pid, subPid: sub.pid }));
  `);
  let server1, closeCount1 = 0, pids1 = {};
  t.after(() => { forceKillCleanup(pids1.pid, pids1.subPid); fs.rmSync(temp1, { recursive: true, force: true }); });
  const ready1 = new Promise((resolve, reject) => {
    server1 = startCodexProcess(stubborn, temp1, { onMessage: resolve, onError: reject, onClose: () => closeCount1++ });
  });
  pids1 = await ready1;
  await server1.stop(20);
  assert.equal(closeCount1, 1);
  assert.equal(isLiveNonZombie(pids1.pid), false);
  assert.equal(isLiveNonZombie(pids1.subPid), false);
  assert.equal(releaseTemporaryCredentials(temp1), true);
  assert.equal(fs.existsSync(temp1), false);

  // Case 2: Leader exits cleanly (0) immediately on stdin EOF while background descendant keeps running (and ignores SIGTERM).
  const temp2 = createTemporaryCredentials('quota');
  const earlyLeader = cli('early-leader', `
    const { spawn } = require('child_process');
    const sub = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'], { stdio: 'ignore' });
    sub.unref();
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
    console.log(JSON.stringify({ pid: process.pid, subPid: sub.pid }));
  `);
  let server2, closeCount2 = 0, pids2 = {};
  t.after(() => { forceKillCleanup(pids2.pid, pids2.subPid); fs.rmSync(temp2, { recursive: true, force: true }); });
  const ready2 = new Promise((resolve, reject) => {
    server2 = startCodexProcess(earlyLeader, temp2, { onMessage: resolve, onError: reject, onClose: () => closeCount2++ });
  });
  pids2 = await ready2;
  await server2.stop(50);
  assert.equal(closeCount2, 1);
  assert.equal(isLiveNonZombie(pids2.pid), false);
  if (process.platform !== 'win32') {
    assert.equal(isLiveNonZombie(pids2.subPid), false);
    assert.equal(releaseTemporaryCredentials(temp2), true);
    assert.equal(fs.existsSync(temp2), false);
  }
});
