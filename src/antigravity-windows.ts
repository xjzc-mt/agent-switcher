import fs from 'fs';
import { execFileSync } from 'child_process';
import { windowsHelper, WindowsHelperError } from './windows-helper';
import { createPrivateWindowsDirectory } from './private-files';

const maxBlobSize = 2560;
export interface WindowsCredential { data: string | null; revision?: string }

// The official go-keyring Windows backend uses one UTF-8 blob. Base64 below
// transports bytes through stdin/stdout only; Credential Manager stores the original bytes.
function run(command: string, fields: string[] = []): string {
  return execFileSync(windowsHelper('AntigravityCredential'), [command], { input: fields.join('\n') + '\n', encoding: 'utf8', timeout: 6000,
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}

export function hasWindowsAntigravityCredential(): boolean {
  try { return run('present') === '1'; } catch { return false; }
}

export function readWindowsCredential(): WindowsCredential {
  try {
    const value = run('read');
    if (value === '-:-') return { data: null };
    const pair = /^([A-F0-9]{16}):([a-zA-Z0-9+/]*={0,2})$/.exec(value);
    if (pair) return { data: pair[2], revision: pair[1] };
  } catch (error) { if (error instanceof WindowsHelperError) throw error; }
  throw new Error('无法读取 Windows 凭据管理器中的 Antigravity 登录');
}

export function replaceWindowsCredential(before: WindowsCredential, bytes: Buffer | null): void {
  if (bytes && bytes.length > maxBlobSize) throw new Error('此凭据超出 Windows 系统凭据大小限制');
  try { run('replace', [before.data ?? '-', before.revision ?? '-', bytes?.toString('base64') ?? '-']); }
  catch (error) {
    if (error instanceof WindowsHelperError) throw error;
    if ((error as { status?: number }).status === 3) throw Object.assign(new Error('Windows 中的 Antigravity 登录已变化'), { status: 78 });
    throw new Error('无法更新 Windows 中的 Antigravity 登录，请重新核对当前账号后重试');
  }
}

export function privateWindowsFile(file: string): boolean {
  const stat = fs.lstatSync(file);
  return stat.isFile() && stat.nlink === 1 && run('private', [Buffer.from(file).toString('base64')]) === '1';
}

export function writePrivateWindowsFile(file: string, bytes: Buffer): void {
  run('create', [Buffer.from(file).toString('base64'), bytes.toString('base64')]);
}

export function createPrivateWindowsQuotaDirectory(directory: string): void {
  try { createPrivateWindowsDirectory(directory); }
  catch (error) {
    if (error instanceof WindowsHelperError) throw error;
    throw new Error('无法建立当前 Windows 用户专用的额度查询目录，请检查临时目录权限');
  }
}

export function trustedWindowsQuotaDirectory(directory: string, codex = false): boolean {
  return run(codex ? 'codex-quota' : 'owned-directory', [Buffer.from(directory).toString('base64')]) === '1';
}
