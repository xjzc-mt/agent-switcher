import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { createPrivateWindowsDirectory } from './private-files';

const exec = promisify(execFile);
export class InvalidMacBundle extends Error {
  static readonly messageForUser = '此版本的安装包缺少完整的 AgentSwitcher.app，请稍后检查新版或查看 GitHub 项目页';
  constructor() { super(InvalidMacBundle.messageForUser); }
}
export interface UpdateHandoff { launch(): Promise<void>; dispose(): Promise<void> }
export interface InstallEnvironment { platform: string; isPackaged?: boolean; execPath?: string }

function writableBundle(environment: InstallEnvironment): string | undefined {
  if (!environment.isPackaged || environment.platform !== 'darwin') return;
  const exe = environment.execPath ?? process.execPath, bundle = path.resolve(exe, '../../..');
  if (path.basename(bundle) !== 'AgentSwitcher.app' || exe !== path.join(bundle, 'Contents/MacOS/AgentSwitcher')) return;
  try {
    const target = fs.realpathSync(bundle);
    if (target !== bundle || /^\/Volumes\/|\/AppTranslocation\//i.test(target)) return;
    for (const dir of [target, path.dirname(target)]) fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return target;
  } catch { return; }
}

export function installMode(environment: InstallEnvironment): 'open' | 'restart' {
  return environment.platform === 'win32' || writableBundle(environment) ? 'restart' : 'open';
}

export function privateInstallStage(): string {
  const base = fs.realpathSync(os.tmpdir());
  const dir = path.join(base, 'ags-install-' + randomUUID());
  if (process.platform === 'win32') createPrivateWindowsDirectory(dir);
  else {
    const parent = fs.statSync(base);
    if ((parent.uid !== process.getuid!() && parent.uid !== 0) || ((parent.mode & 0o022) && !(parent.mode & 0o1000)))
      throw new Error('暂存目录权限不安全，无法准备安装');
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  return dir;
}

function detached(file: string, args: string[], env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, env, cwd: os.tmpdir() });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// NSIS's --force-run starts the installed application even for a silent update.
const windowsInstall = `
$ErrorActionPreference = 'Stop'
Wait-Process -Id ([int]$env:AGS_UPDATE_PARENT) -ErrorAction SilentlyContinue
try {
  # Process.Start retains the native handle even if the installer exits immediately.
  $installer = [Diagnostics.Process]::Start($env:AGS_UPDATE_FILE, '/S --updated --force-run')
  if ($null -eq $installer) { throw 'Installer did not start' }
  $installer.WaitForExit()
  if ($installer.ExitCode -ne 0) { throw 'Installation failed' }
} catch {
  if ($env:AGS_ORIGINAL_APP) { Start-Process -FilePath $env:AGS_ORIGINAL_APP }
} finally {
  if ($null -ne $installer) { $installer.Dispose() }
  $stage = Split-Path -Parent $env:AGS_UPDATE_FILE
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    if ($attempt -eq 4 -or !(Test-Path -LiteralPath $stage -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
}`;

// Both the cancellation path and the detached installer release the same private,
// read-only mount. Retry an ordinary eject before forcing only this mount point.
const macDetach = `
detachImage() {
  /usr/bin/hdiutil detach "$1" || { /bin/sleep 0.4; /usr/bin/hdiutil detach "$1"; } || /usr/bin/hdiutil detach -force "$1"
}`;

const macInstall = macDetach + `
pid=$1; image=$2; mount=$3; target=$4; original=$5; work=
stage=$(/usr/bin/dirname "$image")
originalPresent() { [ "$(/usr/bin/stat -f '%d:%i' "$target")" = "$original" ]; }
swap() {
  /usr/bin/osascript -l JavaScript -e 'ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]); function run(a) { if ($.renamex_np(a[0], a[1], 2) !== 0) throw Error("swap failed"); }' "$1" "$2"
}
cleanup() {
  if [ -n "$work" ]; then /bin/rm -rf "$work"; fi
  if detachImage "$mount"; then /bin/rmdir "$mount"; /bin/rm -f "$image"; /bin/rmdir "$stage"; fi
}
trap cleanup EXIT
while /bin/kill -0 "$pid" 2>/dev/null; do /bin/sleep 0.2; done
work=$(/usr/bin/mktemp -d "$(/usr/bin/dirname "$target")/.ags-install.XXXXXX") &&
  /usr/bin/ditto --noqtn "$mount/AgentSwitcher.app" "$work/AgentSwitcher.app" &&
  originalPresent && swap "$work/AgentSwitcher.app" "$target" || { originalPresent && /usr/bin/open "$target"; exit 1; }
if ! /usr/bin/open "$target"; then
  if swap "$work/AgentSwitcher.app" "$target"; then /usr/bin/open "$target"; else work=''; fi
  exit 1
fi`;

/** Called only with a private copy whose signed hash has just been checked. */
export async function prepareHandoff(image: string, environment: InstallEnvironment): Promise<UpdateHandoff & { mode: 'open' | 'restart' }> {
  const stage = path.dirname(image), target = writableBundle(environment);
  const mount = path.join(stage, 'volume');
  let mounted = false;
  const dispose = async () => {
    if (mounted) {
      await exec('/bin/sh', ['-c', macDetach + '\ndetachImage "$1"', 'ags-detach', mount], { timeout: 60000 });
      mounted = false;
    }
    // Never recurse into a mount that may still be active.
    await fs.promises.rmdir(mount).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.promises.rm(image, { force: true });
    await fs.promises.rmdir(stage);
  };
  try {
    let original = '';
    if (target) {
      const stat = fs.statSync(target, { bigint: true });
      original = stat.dev + ':' + stat.ino;
      fs.mkdirSync(mount, { mode: 0o700 });
      await exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, image], { timeout: 60000 });
      mounted = true;
      const source = path.join(mount, 'AgentSwitcher.app');
      if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory() ||
          !fs.statSync(path.join(source, 'Contents/MacOS/AgentSwitcher'), { throwIfNoEntry: false })?.isFile())
        throw new InvalidMacBundle();
    }
    return { mode: target || environment.platform === 'win32' ? 'restart' : 'open', dispose, async launch() {
      if (target) return detached('/bin/sh', ['-c', macInstall, 'ags-update', String(process.pid), image, mount, target, original]);
      if (environment.platform === 'win32') {
        const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        return detached(powershell, ['-NoProfile', '-NonInteractive', '-Command', windowsInstall], {
          ...process.env, AGS_UPDATE_FILE: image, AGS_UPDATE_PARENT: String(process.pid),
          AGS_ORIGINAL_APP: environment.isPackaged ? environment.execPath ?? process.execPath : '',
        });
      }
      // The disk image launcher may open its backing file asynchronously. Leave this
      // private system-temporary copy available to macOS after the application exits.
      if (await shell.openPath(image)) throw new Error('无法打开已校验的安装包，请重试');
    } };
  } catch (error) { await dispose(); throw error; }
}
