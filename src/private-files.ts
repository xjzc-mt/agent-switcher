import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { windowsHelper } from './windows-helper';
import { randomUUID } from 'node:crypto';

export function readRegularFile(file: string): Buffer | null {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('凭据必须是普通文件');
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Publish private bytes only after the caller has verified the completed temporary file. */
export function replacePrivateFile(file: string, bytes: Buffer | string, verify?: (temporary: string) => void, flush = false): void {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let written = false;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx', flush });
    written = true;
    verify?.(temporary);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (written || (error as NodeJS.ErrnoException).code !== 'EEXIST') fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** Check each existing directory including the root, without following links. */
export function hasUnsafeParent(file: string, root: string, requireOwner = false): boolean {
  let current = path.dirname(path.resolve(file));
  while (current === root || current.startsWith(root + path.sep)) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || (requireOwner && (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0)))) return true;
    if (current === root) break;
    current = path.dirname(current);
  }
  return false;
}

/** Atomically create a directory whose protected inheritable ACL grants only the current user access. */
export function createPrivateWindowsDirectory(directory: string): void {
  execFileSync(windowsHelper('AntigravityCredential'), ['directory'], {
    input: Buffer.from(directory).toString('base64') + '\n', timeout: 6000, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
  });
}
