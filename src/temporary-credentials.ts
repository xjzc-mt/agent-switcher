import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';

type Purpose = 'login' | 'quota' | 'agy-quota' | 'preview' | 'update' | 'import';
interface Owner {
  version: 1; pid: number; nonce: string; launching: boolean;
  pendingCommit?: boolean;
  processes: Array<{ pid: number; group: boolean }>;
}
const marker = '.ags-temporary-owner.json';
const owned = new Map<string, Owner>();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const temporaryName = new RegExp(`^ags-(?:login|quota|agy-quota|preview|update|import)-${uuid}$`);
const importName = new RegExp(`^\\.import-${uuid}$`);

function roots() {
  const user = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16);
  return [path.join(os.tmpdir(), `agent-switcher-${user}`), path.join(os.homedir(), '.agent-switcher')];
}
function directoryIsOwned(directory: string): boolean {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
function checkedDirectory(directory: string): boolean {
  const [temporary, store] = roots(), parent = path.dirname(directory), name = path.basename(directory);
  return ((parent === temporary && temporaryName.test(name)) || (parent === store && importName.test(name))) &&
    directoryIsOwned(parent) && directoryIsOwned(directory);
}
function writeOwner(directory: string, owner: Owner) {
  const file = path.join(directory, marker), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function readOwner(directory: string): Owner | undefined {
  if (!checkedDirectory(directory)) return;
  const file = path.join(directory, marker), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pid = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  if (value.version !== 1 || !pid(value.pid) || typeof value.nonce !== 'string' ||
      typeof value.launching !== 'boolean' || !Array.isArray(value.processes) ||
      (value.pendingCommit !== undefined && typeof value.pendingCommit !== 'boolean') ||
      !value.processes.every((p: { pid?: number; group?: boolean }) => p && pid(p.pid) && typeof p.group === 'boolean')) return;
  return value;
}
function alive(pid: number, group = false): boolean {
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function writersRemain(owner: Owner): boolean {
  // On Windows a dead direct child does not prove its descendants have stopped.
  return owner.launching || owner.processes.some(p => !p.group || alive(p.pid, true));
}

/** Register ownership before callers can write any credentials. */
export function createTemporaryCredentials(purpose: Purpose, options: { store?: boolean } = {}): string {
  if (options.store && purpose !== 'import') throw new Error('仅导入暂存目录可位于账号池');
  const parent = roots()[options.store ? 1 : 0];
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!directoryIsOwned(parent)) throw new Error('临时凭据目录不安全');
  fs.chmodSync(parent, 0o700);
  const directory = path.join(parent, `${options.store ? '.import' : `ags-${purpose}`}-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const owner: Owner = { version: 1, pid: process.pid, nonce: randomUUID(), launching: false, processes: [] };
  try { writeOwner(directory, owner); }
  catch (error) { fs.rmdirSync(directory); throw error; }
  owned.set(directory, owner);
  return directory;
}

/** Callers launch POSIX children with detached:true so descendants share a tracked group. */
export function withTemporaryProcess<T extends ChildProcess>(directory: string, launch: () => T): T {
  const owner = owned.get(directory);
  if (!owner) return launch(); // Also used with externally supplied homes by protocol tests.
  if (readOwner(directory)?.nonce !== owner.nonce) throw new Error('临时凭据目录状态已变化');
  owner.launching = true;
  writeOwner(directory, owner);
  let child: T;
  try { child = launch(); }
  catch (error) { owner.launching = false; writeOwner(directory, owner); throw error; }
  if (child.pid) owner.processes.push({ pid: child.pid, group: process.platform !== 'win32' });
  // A crash before this write leaves launching:true; recovery must preserve the directory.
  owner.launching = false;
  try { writeOwner(directory, owner); }
  catch (error) { child.kill(); throw error; }
  return child;
}

/** A query can rotate a token before the account pool accepts it. Preserve its only disk copy. */
export function markTemporaryCredentialsPending(directory: string): void {
  const owner = owned.get(directory);
  if (!owner || readOwner(directory)?.nonce !== owner.nonce) throw new Error('临时凭据目录状态已变化');
  owner.pendingCommit = true;
  writeOwner(directory, owner);
}

/** Release only after a verified write-back, or after proving no credentials changed. */
export function releaseTemporaryCredentials(directory: string): boolean {
  try {
    const owner = owned.get(directory);
    if (!owner || readOwner(directory)?.nonce !== owner.nonce) return false;
    const released = { ...owner, pendingCommit: false };
    writeOwner(directory, released);
    owned.set(directory, released);
    return removeTemporaryCredentials(directory);
  } catch { return false; }
}

/** A still-running descendant keeps its directory; the next startup can reclaim it. */
export function removeTemporaryCredentials(directory: string): boolean {
  const expected = owned.get(directory);
  if (!expected) return false;
  try {
    try { fs.lstatSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      owned.delete(directory); return true;
    }
    const owner = readOwner(directory);
    if (!owner || owner.nonce !== expected.nonce || owner.pendingCommit || writersRemain(owner)) return false;
    fs.rmSync(directory, { recursive: true });
    owned.delete(directory);
    return true;
  } catch {
    // Callers may already hold rotated refresh tokens. Cleanup must never discard them.
    return false;
  }
}

/** Unknown legacy directories and live/reused PIDs are deliberately never reclaimed. */
export function reapTemporaryCredentials(): { removed: string[]; retained: string[] } {
  const result = { removed: [] as string[], retained: [] as string[] };
  for (const [index, parent] of roots().entries()) {
    if (!fs.existsSync(parent) || !directoryIsOwned(parent)) continue;
    const names = fs.readdirSync(parent).filter(name => (index ? importName : temporaryName).test(name));
    for (const name of names) {
      const directory = path.join(parent, name);
      try {
        const owner = readOwner(directory);
        if (!owner || owner.pendingCommit || alive(owner.pid) || writersRemain(owner)) { result.retained.push(directory); continue; }
        fs.rmSync(directory, { recursive: true });
        result.removed.push(directory);
      } catch { result.retained.push(directory); }
    }
  }
  return result;
}
