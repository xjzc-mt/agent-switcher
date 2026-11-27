import { execFile } from 'node:child_process';
import { processProbeError } from './diagnostics';
import { checkWindowsHelperError, windowsHelper } from './windows-helper';

export function desktopCommand(args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => execFile(windowsHelper('DesktopWindows'), args,
    { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}

export function windowsProcessError(error?: unknown, message = '无法读取 Windows 客户端或 CLI 进程状态，请检查安全软件拦截后重试；若持续出现可重启系统') {
  const failure = processProbeError(error, message, '检测 Windows 客户端与 CLI 运行状态超时（系统繁忙），请稍后重试；若反复出现可重启系统恢复');
  checkWindowsHelperError(error);
  return failure;
}

export interface WindowsProcess { pid: number; parent: number; name: string; file: string | null; created: string; ownerKnown: boolean }
export const codexNames = ['codex.exe', 'codex-cli.exe', 'codex-app-server.exe', 'codex-x86_64-pc-windows-msvc.exe', 'codex-aarch64-pc-windows-msvc.exe'];

export async function userProcesses(names: string[] = []): Promise<WindowsProcess[]> {
  try {
    const output = await desktopCommand(['processes', ...names]);
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows) || !rows.every(row => Number.isSafeInteger(row?.pid) && row.pid > 0 &&
      Number.isSafeInteger(row.parent) && row.parent >= 0 && typeof row.name === 'string' && typeof row.created === 'string' && /^(?:\d{16,19})?$/.test(row.created) &&
      typeof row.ownerKnown === 'boolean' && (row.file === null || typeof row.file === 'string'))) throw new Error();
    return rows;
  } catch (error) { throw windowsProcessError(error); }
}

function currentUser(rows: WindowsProcess[]): WindowsProcess[] {
  if (rows.some(row => !row.ownerKnown)) throw windowsProcessError(undefined, '检测到同会话存在更高权限的客户端或 CLI 进程（可能以管理员身份运行），请先关闭相关终端或客户端后再切换');
  return rows;
}

export async function windowsCodexProcesses(): Promise<number[]> {
  return currentUser(await userProcesses(codexNames)).map(row => row.pid);
}

export function sharedWindowsAntigravityPids(rows: WindowsProcess[], isolated: ReadonlySet<number>): number[] {
  const excluded = new Set(isolated);
  for (let count = -1; count !== excluded.size;) {
    count = excluded.size;
    for (const row of rows) if (excluded.has(row.parent)) excluded.add(row.pid);
  }
  return currentUser(rows.filter(row => {
    if (excluded.has(row.pid)) return false;
    if (!/^language_server/i.test(row.name)) return true;
    // The unbranded executable name is shared by unrelated IDEs. The official IDE
    // and agy are already counted independently, including when their path is inaccessible.
    if (!row.file) {
      if (/^language_server\.exe$/i.test(row.name)) return false;
      if (!row.ownerKnown) return true;
      throw windowsProcessError(undefined, '无法确认 Windows 语言服务的安装位置，请先关闭相关终端或客户端后再切换');
    }
    return /[\\/](?:resources[\\/]app[\\/]extensions[\\/]antigravity[\\/]bin|(?:google )?antigravity(?: ide)?[\\/]resources(?:[\\/]bin)?)[\\/]language_server(?:_windows_(?:x64|arm64))?\.exe$/i.test(row.file);
  })).map(row => row.pid);
}

export async function windowsAntigravitySessions(isolated: ReadonlySet<number>): Promise<number[]> {
  return sharedWindowsAntigravityPids(await userProcesses(['agy.exe', 'Antigravity IDE.exe', 'language_server.exe',
    'language_server_windows_x64.exe', 'language_server_windows_arm64.exe']), isolated);
}

export async function desktopCandidates(name: 'Codex' | 'Antigravity'): Promise<WindowsProcess[]> {
  return userProcesses(name === 'Codex' ? ['Codex.exe', 'ChatGPT.exe'] : ['Antigravity.exe']);
}

const bootRecord = /^([1-9]\d{0,9}):([1-9]\d{15,18})$/;
export function earlierWindowsBoot(recorded?: string, current?: string): boolean {
  const before = typeof recorded === 'string' && bootRecord.exec(recorded);
  const now = current && bootRecord.exec(current);
  if (!before || !now || Number(before[1]) >= Number(now[1])) return false;
  // Earlier WMI receipts truncated FILETIME to microseconds. Lost precision cannot establish a reboot.
  const delta = BigInt(now[2]) - BigInt(before[2]);
  return delta > 9n || delta < -9n;
}

/** Pair the OS boot counter with the System process creation time so a clock change or resume alone cannot authorize cleanup. */
export async function windowsBoot(): Promise<string | undefined> {
  try {
    const output = await desktopCommand(['boot']);
    if (bootRecord.test(output)) return output;
  } catch { /* Access to either source is optional; uncertain directories are retained. */ }
}
