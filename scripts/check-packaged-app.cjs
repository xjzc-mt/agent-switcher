const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const [exe, arch] = process.argv.slice(2);
  const windows = process.platform === 'win32';
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('The packaged GUI check requires a disposable GitHub-hosted runner');
  }
  if ((!windows && process.platform !== 'darwin') || !path.isAbsolute(exe || '') || !fs.statSync(exe).isFile() ||
      !['arm64', 'x64'].includes(arch) || arch !== process.arch) throw new Error('Expected an installed executable for the native runner architecture');
  if (windows) {
    const image = fs.readFileSync(exe);
    const header = image.readUInt32LE(0x3c);
    if (image.toString('ascii', header, header + 4) !== 'PE\0\0' || image.readUInt16LE(header + 4) !== 0x8664) {
      throw new Error('Installed executable is not a Windows x64 PE image');
    }
  }

  const home = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'ags-smoke-'));
  const userData = path.join(home, 'profile');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${userData}`, '--use-mock-keychain',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'];
  const child = spawn(exe, args, { env, detached: !windows, stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError, logTail = '', port;
  child.on('error', error => { startupError = error; });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    logTail = (logTail + chunk).slice(-4096);
    port ||= logTail.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
  });
  const portFile = path.join(userData, 'DevToolsActivePort');
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode) throw new Error(`Packaged app exited early (${child.exitCode ?? child.signalCode})`);
      if (!port && fs.existsSync(portFile)) port = fs.readFileSync(portFile, 'utf8').match(/^(\d+)\r?\n/)?.[1];
      if (port) {
        const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
          .then(r => r.json()).catch(() => []);
        if (pages.some(p => p.type === 'page' && p.title === 'AgentSwitcher' &&
            /^file:\/\/.+\/app\.asar\/renderer\/index\.html$/.test(p.url))) {
          console.log(`Loaded packaged AgentSwitcher renderer on ${process.platform}/${arch}`);
          return;
        }
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for packaged renderer. ${logTail}`);
  } finally {
    if (child.pid && child.exitCode === null && !child.signalCode) {
      if (windows) execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
