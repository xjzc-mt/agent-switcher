import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export async function windowsQuery(script: string, timeout = 5000, environment?: NodeJS.ProcessEnv): Promise<string> {
  const system = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n" + script],
    { windowsHide: true, timeout, env: environment });
  return stdout.trim();
}

export interface WindowsProcess { pid: number; parent: number; name: string; file: string | null; created: string; ownerKnown: boolean }
const codexNames = ['codex.exe', 'codex-cli.exe', 'codex-app-server.exe', 'codex-x86_64-pc-windows-msvc.exe', 'codex-aarch64-pc-windows-msvc.exe'];

async function userProcesses(names: string[]): Promise<WindowsProcess[]> {
  const filter = names.map(name => `Name='${name}'`).join(' OR ');
  try {
    const output = await windowsQuery(`
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
      $rows = @(foreach ($row in (Get-CimInstance Win32_Process -Filter "SessionId=$session AND (${filter})" -Property ProcessId,ParentProcessId,SessionId,Name,ExecutablePath,CreationDate)) {
        $owner = try { Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction Stop } catch { $null }
        $ownerSid = if ($owner -and $owner.ReturnValue -eq 0) { $owner.Sid }
        if (!$ownerSid) {
          $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($row.ProcessId)" -ErrorAction Stop
          if (!$current -or $current.SessionId -ne $session -or $current.CreationDate -ne $row.CreationDate) { continue }
          $account = try { Invoke-CimMethod -InputObject $current -MethodName GetOwner -ErrorAction Stop } catch { $null }
          if ($account -and $account.ReturnValue -eq 0 -and $account.User) {
            try { $ownerSid = [Security.Principal.NTAccount]::new($account.Domain,$account.User).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
          }
        }
        if ($ownerSid -and $ownerSid -ne $sid) { continue }
        $file = $row.ExecutablePath
        if (!$file) {
          $live = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
          if (!$live) { continue }
          try {
            $file = $live.Path
            if ($file -and $row.CreationDate -and [Math]::Abs($live.StartTime.ToFileTimeUtc() - $row.CreationDate.ToFileTimeUtc()) -gt 9) { continue }
          } catch { $file = $null }
        }
        $born = if ($row.CreationDate) { $row.CreationDate.ToFileTimeUtc().ToString() } else { '' }
        [pscustomobject]@{ pid=$row.ProcessId; parent=$row.ParentProcessId; name=$row.Name; file=$file; created=$born; ownerKnown=[bool]$ownerSid }
      })
      ConvertTo-Json -InputObject $rows -Compress`);
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows) || !rows.every(row => Number.isSafeInteger(row?.pid) && row.pid > 0 &&
      Number.isSafeInteger(row.parent) && row.parent >= 0 && typeof row.name === 'string' && typeof row.created === 'string' && /^(?:\d{16,19})?$/.test(row.created) &&
      typeof row.ownerKnown === 'boolean' && (row.file === null || typeof row.file === 'string'))) throw new Error();
    return rows;
  } catch { throw new Error('无法确认 Windows 当前用户的客户端或 CLI 运行状态，请稍后重试'); }
}

function currentUser(rows: WindowsProcess[]): WindowsProcess[] {
  if (rows.some(row => !row.ownerKnown)) throw new Error('无法确认 Windows 进程所属用户，请稍后重试');
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
      throw new Error('无法确认 Windows 语言服务的安装位置，请稍后重试');
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
  return !!before && !!now && Number(before[1]) < Number(now[1]) && before[2] !== now[2];
}

/** Pair the OS boot counter with the System process creation time so a clock change or resume alone cannot authorize cleanup. */
export async function windowsBoot(): Promise<string | undefined> {
  try {
    const output = await windowsQuery([
      "$key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters'",
      '$id = (Get-ItemProperty -LiteralPath $key -Name BootId).BootId',
      '$created = (Get-CimInstance Win32_Process -Filter "ProcessId=4" -Property CreationDate).CreationDate',
      '"{0}:{1}" -f $id, $created.ToFileTimeUtc()',
    ].join('\n'));
    if (bootRecord.test(output)) return output;
  } catch { /* Access to either source is optional; uncertain directories are retained. */ }
}
