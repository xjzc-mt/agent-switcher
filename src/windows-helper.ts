import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

type Helper = 'AntigravityCredential' | 'AgySandbox' | 'DesktopWindows';

export class WindowsHelperError extends Error {}

export function windowsHelper(name: Helper): string {
  const directory = 'windows-helpers';
  const app = path.dirname(__dirname);
  const file = path.join(app.endsWith('.asar') ? app + '.unpacked' : app, 'dist', directory, name + '.exe');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, directory, 'sha256.json'), 'utf8'));
    if (fs.lstatSync(file).isFile() && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === manifest[name]) return file;
  } catch { /* Return the same actionable error for missing and incomplete installations. */ }
  throw new WindowsHelperError('Windows 辅助组件缺失或校验失败，请重新构建源码或安装完整的 AgentSwitcher');
}
