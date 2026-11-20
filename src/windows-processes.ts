import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

async function windowsQuery(script: string): Promise<string> {
  const system = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'\n" + script], { windowsHide: true, timeout: 5000 });
  return stdout.trim();
}

export async function windowsCodexProcesses(): Promise<number[]> {
  // Desktop, standalone CLI, IDE and app-server all may use the same login.
  const names = ['codex.exe', 'codex-cli.exe', 'codex-app-server.exe',
    'codex-x86_64-pc-windows-msvc.exe', 'codex-aarch64-pc-windows-msvc.exe'];
  const filter = names.map(name => `Name='${name}'`).join(' OR ');
  try {
    const output = await windowsQuery([
      '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      `$pids = @(Get-CimInstance Win32_Process -Filter "${filter}" -Property ProcessId | ForEach-Object {`,
      '  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid',
      "  if ($owner.ReturnValue -ne 0 -or !$owner.Sid) { throw 'Owner unavailable' }",
      '  if ($owner.Sid -eq $sid) { $_.ProcessId }',
      '})',
      'ConvertTo-Json -InputObject $pids -Compress',
    ].join('\n'));
    const pids: unknown = JSON.parse(output);
    if (!Array.isArray(pids) || !pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error();
    return pids;
  } catch { throw new Error('无法确认 Windows Codex 桌面或 CLI 的运行状态，请稍后重试'); }
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
