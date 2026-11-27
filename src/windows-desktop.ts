import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { codexNames, desktopCandidates, desktopCommand, userProcesses, windowsProcessError, type WindowsProcess } from './windows-processes';
import { windowsHelper } from './windows-helper';
import { processProbeError } from './diagnostics';
import { CODEX_STORE_FAMILY } from './windows-codex';

type Desktop = 'Codex' | 'Antigravity';
type Launch = { file: string } & ({ revision: string; appId?: never } | { appId: string; revision?: never });
const closed = new Map<Desktop, Launch>();
const confirmations = new WeakMap<string[], WindowsProcess[]>();
function isCodexStoreDesktop(file: string): boolean {
  const fullName = /[\\/]WindowsApps[\\/]([^\\/]+)[\\/]app[\\/](?:Codex|ChatGPT)\.exe$/i.exec(file)?.[1];
  const fields = fullName?.split('_'); // Name, version, architecture, resource ID, publisher ID.
  return fields?.length === 5 && (fields[0] + '_' + fields[4]).toLowerCase() === CODEX_STORE_FAMILY.toLowerCase();
}

function defaultFiles(name: Desktop) {
  const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  const folders = name === 'Codex' ? [path.join('OpenAI', 'Codex'), 'Codex'] : ['Antigravity', 'Google Antigravity'];
  return roots.filter((root): root is string => !!root && path.isAbsolute(root))
    .flatMap(root => folders.map(folder => path.join(root, folder, name + '.exe')));
}
export function windowsAntigravityVersion(): string | undefined {
  for (const file of defaultFiles('Antigravity')) {
    if (!fs.existsSync(file)) continue;
    const resources = path.join(path.dirname(file), 'resources');
    for (const app of ['app', 'app.asar']) {
      try {
        const { version } = JSON.parse(fs.readFileSync(path.join(resources, app, 'package.json'), 'utf8'));
        if (typeof version === 'string' && /^\d+\./.test(version)) return version;
      } catch { /* Plain Node cannot open an Electron asar as a directory. */ }
    }
    try {
      const version = execFileSync(windowsHelper('DesktopWindows'), ['version', file],
        { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^\d+\./.test(version)) return version;
    } catch { /* Try the next install location. */ }
  }
}
const equalsPath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function hasDesktopResources(file: string): boolean {
  const resources = path.join(path.dirname(file), 'resources');
  return ['app.asar', path.join('app', 'package.json')].some(name => fs.existsSync(path.join(resources, name)));
}

function elevatedDesktop(name: Desktop) {
  return windowsProcessError(undefined, `检测到更高权限运行的 ${name} 桌面进程（可能以管理员身份启动），请先手动退出该客户端后再切换`);
}

export async function windowsDesktop(name: Desktop) {
  const rows = (await desktopCandidates(name)).filter(({ file }) => {
    if (name === 'Antigravity' || !file) return true;
    if (/[\\/]WindowsApps[\\/]/i.test(file)) return isCodexStoreDesktop(file);
    if (path.basename(file).toLowerCase() !== 'codex.exe') return false;
    return hasDesktopResources(file);
  });
  // A sandbox renderer can hide both its image path and its owner. Only roots
  // need authority to close windows; descendants are observed and waited for.
  const roots = rootProcesses(rows);
  if (roots.some(row => !row.ownerKnown)) throw elevatedDesktop(name);
  if (rows.some(row => !row.created) || roots.some(row => !row.file)) throw windowsProcessError();
  return rows;
}

function revision(file: string): string {
  const canonical = fs.realpathSync.native(file);
  if (!equalsPath(file, canonical)) throw new Error('桌面安装位置已变化，请手动打开');
  const stat = fs.lstatSync(canonical, { bigint: true });
  if (!stat.isFile()) throw new Error('桌面安装文件不可用，请手动打开');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join('/');
}

// A package update changes the install path. Also invalidate on a same-version manifest replacement.
let registeredApp: { file: string; stamp: string; id: string } | undefined;
async function storeAppId(file: string): Promise<string> {
  const manifest = path.join(path.dirname(path.dirname(file)), 'AppxManifest.xml');
  const stat = await fs.promises.stat(manifest, { bigint: true }).catch(() =>
    fs.promises.stat(file, { bigint: true }).catch(() => undefined));
  const stamp = stat && [stat.dev, stat.ino, stat.ctimeNs, stat.size].join('/');
  if (stamp && registeredApp?.file === file && registeredApp.stamp === stamp) return registeredApp.id;
  let id: string;
  try {
    id = await desktopCommand(['manifest', file]);
  } catch (error) {
    if ((error as { code?: number }).code !== 3) throw windowsProcessError(error);
    // An inaccessible manifest can still be read by the current user's package registration service.
    const shell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$ErrorActionPreference='Stop'
      [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
      foreach ($package in (Get-AppxPackage -Name OpenAI.Codex)) {
        if ($package.PackageFamilyName -ine $env:AGS_CODEX_FAMILY) { continue }
        $root = $package.InstallLocation
        if ($root -ine [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($env:AGS_DESKTOP_FILE))) { continue }
        $apps = @((Get-AppxPackageManifest -Package $package.PackageFullName).Package.Applications.Application)
        $match = @($apps | Where-Object { $_.Executable -and (Join-Path $root $_.Executable) -ieq $env:AGS_DESKTOP_FILE })
        if (!$match.Count -and $apps.Count -eq 1) { $match = $apps }
        if ($match.Count -eq 1) { $match[0].Id }
      }`;
    try {
      id = await new Promise<string>((resolve, reject) => execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 10000, env: { ...process.env, AGS_DESKTOP_FILE: file, AGS_CODEX_FAMILY: CODEX_STORE_FAMILY } },
        (err, stdout) => err ? reject(err) : resolve(stdout.trim())));
    } catch (failure) { throw processProbeError(failure, '无法查询 Codex 商店应用的启动项，请手动操作客户端', '查询 Codex 商店应用的启动项超时，请稍后重试'); }
  }
  if (!/^[\w.-]+$/.test(id)) throw new Error('无法确认 Codex 商店应用的启动项，请手动操作客户端');
  id = CODEX_STORE_FAMILY + '!' + id;
  if (stamp) registeredApp = { file, stamp, id };
  return id;
}

async function launchTarget(name: Desktop, file: string): Promise<Launch> {
  if (name === 'Codex' && isCodexStoreDesktop(file)) return { file, appId: await storeAppId(file) };
  const stamp = revision(file);
  if (name === 'Codex' && !hasDesktopResources(file)) throw new Error('无法确认 Codex 桌面安装文件，请手动打开');
  if (!defaultFiles(name).some(known => equalsPath(known, file))) {
    // A relocated electron application must still be the observed vendor desktop, never a same-named CLI.
    const publisher = hasDesktopResources(file) && await desktopCommand(['publisher', file], 10000)
      .catch(error => { throw windowsProcessError(error, '无法核对桌面安装文件的发布者，请先手动退出客户端'); });
    const vendor = name === 'Codex' ? /^OpenAI(?:,? (?:Inc\.?|LLC|L\.L\.C\.|OpCo,? LLC))?$/i : /^Google (?:LLC|Inc\.?)$/i;
    if (!publisher || !vendor.test(publisher)) throw new Error(`无法确认 ${name} 桌面的安装位置与发布者，请手动操作客户端`);
  }
  return { file, revision: stamp };
}

async function backendProcesses(rows: WindowsProcess[]): Promise<string[]> {
  // Follow the observed desktop lineage even through an intermediate shell. Check creation times against PID reuse.
  const all = await userProcesses();
  const tree = new Map(rows.map(row => [row.pid, BigInt(row.created)]));
  for (const p of all) {
    if (tree.has(p.pid) && tree.get(p.pid) !== BigInt(p.created)) tree.delete(p.pid);
  }
  const wait: string[] = [];
  for (const p of all.sort((a, b) => a.created.length - b.created.length || a.created.localeCompare(b.created))) {
    if (!p.created || tree.has(p.pid)) continue;
    const parent = tree.get(p.parent), born = BigInt(p.created);
    if (parent === undefined || parent > born) continue;
    if (parent === born) throw windowsProcessError();
    tree.set(p.pid, born);
    if (codexNames.includes(p.name.toLowerCase())) wait.push(`wait:${p.pid}:${p.created}`);
  }
  if (all.some(p => !p.created && tree.has(p.parent))) throw windowsProcessError();
  return wait;
}

export async function runningWindowsClients(name: Desktop): Promise<string[]> {
  const rows = await windowsDesktop(name);
  const names = rows.length ? [name] : [];
  confirmations.set(names, rows);
  return names;
}

function rootProcesses(rows: WindowsProcess[]) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  return rows.filter(row => {
    const parent = byPid.get(row.parent);
    return !parent || BigInt(parent.created) >= BigInt(row.created);
  });
}

export async function quitWindowsDesktop(name: Desktop, confirmedNames: string[]): Promise<void> {
  const rows = await windowsDesktop(name);
  // The caller intends to reopen what it closed. A desktop that disappeared during confirmation belongs to the user.
  if (!rows.length) throw new Error(`${name} 已退出，请重试当前操作`);
  const observed = confirmations.get(confirmedNames);
  const roots = rootProcesses(rows);
  if (observed) {
    const confirmed = rootProcesses(observed);
    if (!roots.length || !roots.every(row => confirmed.some(before => before.pid === row.pid &&
        before.created === row.created && equalsPath(before.file!, row.file!)))) {
      throw new Error(`${name} 已重新启动，请重试当前操作`);
    }
  }
  const file = roots[0].file!;
  if (rows.some(row => row.file && !equalsPath(row.file, file))) throw new Error(`检测到多个 ${name} 安装位置，请手动退出`);
  const target = await launchTarget(name, file);
  const wait = name === 'Codex' ? await backendProcesses(rows) : [];
  const processes = rows.map(row => `${roots.includes(row) ? 'window' : 'wait'}:${row.pid}:${row.created}`);
  let acknowledged = false;
  try {
    await desktopCommand([file, ...processes, ...wait], 11000);
    acknowledged = true;
    if ((await windowsDesktop(name)).length) throw new Error(`${name} 未能正常退出，请手动退出后重试`);
  } catch (error) {
    // A desktop may have accepted the close while a backend remains busy. Restore only the desktop we observed.
    if (!acknowledged) {
      const { code } = error as { code?: number };
      if (code === 5) throw elevatedDesktop(name);
      if (code === 4) throw new Error(`${name} 已退出或运行实例已变化，请重试当前操作`);
      if (code !== 3) throw windowsProcessError(error, `${name} 未能正常退出，请完成正在进行的任务后手动退出`);
    }
    if (!await windowsDesktop(name).then(list => list.length > 0, () => true)) {
      try { await startTarget(target); } catch { throw new Error(`${name} 已关闭，子进程退出未确认，自动重开失败，请手动打开`); }
    }
    if (acknowledged) throw error;
    throw new Error(`${name} 未能正常退出，请完成正在进行的任务后手动退出`);
  }
  closed.set(name, target);
}

async function startTarget(target: Launch) {
  if (!target.appId && revision(target.file) !== target.revision) throw new Error('桌面安装文件已变更，请手动打开');
  const executable = target.appId ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe') : target.file;
  const args = target.appId ? ['shell:AppsFolder\\' + target.appId] : [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.dirname(executable), detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openWindowsDesktop(name: Desktop): Promise<void> {
  let target = closed.get(name);
  if (!target) {
    const file = defaultFiles(name).find(candidate => fs.existsSync(candidate));
    if (!file) throw new Error(`无法确认 ${name} 桌面的安装位置，请手动打开`);
    target = await launchTarget(name, file);
  }
  await startTarget(target);
  if (target.appId) {
    // explorer accepts shell:AppsFolder even when activation fails. Confirm that the packaged desktop actually appeared.
    const deadline = Date.now() + 5000;
    while (!(await windowsDesktopReopened(name))) {
      if (Date.now() >= deadline) throw new Error('Windows 未确认 Codex 商店应用启动，请手动打开');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  closed.delete(name);
}

/** Another installation cannot acknowledge a reopen, even if it has the same display name. */
export async function windowsDesktopReopened(name: Desktop): Promise<boolean> {
  const target = closed.get(name);
  const rows = await windowsDesktop(name);
  if (!target) return rows.length > 0;
  const reopened = rootProcesses(rows).some(row => target.appId ? isCodexStoreDesktop(row.file!) : equalsPath(target.file, row.file!));
  if (reopened) closed.delete(name);
  return reopened;
}
