import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

type Helper = 'AntigravityCredential' | 'AgySandbox' | 'DesktopWindows';

export class WindowsHelperError extends Error {
  constructor(message = 'Windows 辅助组件缺失或被安全软件拦截，请检查杀毒软件隔离区或重新安装 AgentSwitcher') { super(message); }
}

export function checkWindowsHelperError(error: unknown): void {
  if (error instanceof WindowsHelperError) throw error;
  if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw new WindowsHelperError();
}

export function windowsHelper(name: Helper): string {
  const directory = 'windows-helpers';
  const app = path.dirname(__dirname);
  const file = path.join(app.endsWith('.asar') ? app + '.unpacked' : app, 'dist', directory, name + '.exe');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, directory, 'sha256.json'), 'utf8'));
    if (fs.lstatSync(file).isFile() && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === manifest[name]) return file;
  } catch { throw new WindowsHelperError(); }
  throw new WindowsHelperError('Windows 辅助组件校验失败，请重新安装 AgentSwitcher');
}
