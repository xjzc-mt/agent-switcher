import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { execFile, execFileSync, type ChildProcess } from 'child_process';
import { earlierWindowsBoot, windowsBoot } from './windows-processes';

const run = promisify(execFile);

type Purpose = 'login' | 'quota' | 'agy-quota' | 'preview' | 'update' | 'import';
interface Owner {
  version: 1; pid: number; nonce: string; launching: boolean;
  pendingCommit?: boolean;
  windowsBoot?: string;
  refreshInput?: string;
  processes: Array<{ pid: number; group: boolean }>;
}
const marker = '.ags-temporary-owner.json';
const owned = new Map<string, Owner>();
let boot: string | undefined, bootQuery: Promise<void> | undefined;
export async function initializeTemporaryBoot(): Promise<void> {
  if (process.platform !== 'win32') return;
  bootQuery ??= windowsBoot().then(value => { boot = value; });
  await bootQuery;
}
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
export function groupHasLiveWriters(pgid: number): boolean {
  if (!alive(pgid, true)) return false;
  if (process.platform === 'win32') return true;
  try {
    const out = execFileSync('/bin/ps', ['-xo', 'pgid=,stat='], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const states = out.split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      return match && Number(match[1]) === pgid ? [match[2]] : [];
    });
    return states.some(state => !state.startsWith('Z'));
  } catch { return true; }
}
function writersRemain(owner: Owner): boolean {
  // On Windows a dead direct child does not prove its descendants have stopped.
  return owner.launching || owner.processes.some(p => !p.group || groupHasLiveWriters(p.pid));
}

/** A retained directory can outlive its PID. Confirm the working directory before excluding another AGS process. */
export async function sharedCliSessions(local: Set<number>, matches: (command: string) => boolean): Promise<number[]> {
  const { stdout } = await run('/bin/ps', ['-xo', 'pid=,pgid=,comm=']);
  const candidates = stdout.split('\n').flatMap(line => {
    const row = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim());
    if (!row || !matches(row[3])) return [];
    const pid = Number(row[1]), group = Number(row[2]);
    return local.has(group) || local.has(pid) ? [] : [{ pid, group }];
  });
  const shared = candidates.map(row => row.pid);
  if (!shared.length) return [];
  const groups = new Set(candidates.map(row => row.group));
  const directories = new Map<string, Set<number>>();
  try {
    const root = roots()[0];
    if (!directoryIsOwned(root)) return shared;
    for (const name of fs.readdirSync(root).filter(name => temporaryName.test(name))) {
      const directory = path.join(root, name);
      try {
        const owner = readOwner(directory);
        const ids = owner?.processes.filter(p => p.group && groups.has(p.pid)).map(p => p.pid);
        if (ids?.length) directories.set(fs.realpathSync(directory), new Set(ids));
      } catch { /* A concurrent cleanup or unreadable marker proves no ownership. */ }
    }
    if (!directories.size) return shared;
    const recorded = new Set([...directories.values()].flatMap(ids => [...ids]));
    const probes = new Set(candidates.filter(row => recorded.has(row.group)).flatMap(row => [row.pid, row.group]));
    const { stdout: files } = await run('/usr/sbin/lsof', ['-nP', '-a', '-d', 'cwd', '-p', [...probes].join(','), '-F0pn'],
      { timeout: 2000, maxBuffer: 1024 * 1024 });
    const cwd = new Map<number, string>();
    let pid = 0;
    for (const field of files.split('\0')) {
      const value = field.replace(/^\n/, '');
      if (/^p\d+$/.test(value)) pid = Number(value.slice(1));
      if (pid && value.startsWith('n/')) cwd.set(pid, value.slice(1));
    }
    return candidates.filter(row => ![row.group, row.pid].some(pid =>
      directories.get(cwd.get(pid) || '')?.has(row.group))).map(row => row.pid);
  } catch { return shared; }
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
  const owner: Owner = { version: 1, pid: process.pid, nonce: randomUUID(), launching: false, processes: [], windowsBoot: boot };
  try { writeOwner(directory, owner); }
  catch (error) { fs.rmdirSync(directory); throw error; }
  owned.set(directory, owner);
  return directory;
}

export function stopTemporaryProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* Fall back if not a group leader. */ }
  }
  try { child.kill(signal); } catch {}
}

export async function drainTemporaryProcessGroup(child: ChildProcess, graceMs = 200): Promise<void> {
  const pgid = child.pid;
  if (process.platform === 'win32' || !pgid || !groupHasLiveWriters(pgid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch {}
  const termDeadline = Date.now() + Math.min(Math.max(graceMs, 50), 400);
  while (Date.now() < termDeadline && groupHasLiveWriters(pgid)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!groupHasLiveWriters(pgid)) return;
  try { process.kill(-pgid, 'SIGKILL'); } catch {}
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline && groupHasLiveWriters(pgid)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
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
  catch (error) { stopTemporaryProcess(child); throw error; }
  return child;
}

/** A query can rotate a token before the account pool accepts it. Preserve its only disk copy. */
export function markTemporaryCredentialsPending(directory: string, identity?: string, refreshToken?: string): void {
  const owner = owned.get(directory);
  if (!owner || readOwner(directory)?.nonce !== owner.nonce) throw new Error('临时凭据目录状态已变化');
  if (identity && refreshToken) {
    const prefix = path.basename(directory).startsWith('ags-agy-quota-') ? 'ags-agy-quota-' : 'ags-quota-';
    const input = createHash('sha256').update(JSON.stringify([prefix, identity, refreshToken])).digest('hex');
    const parent = path.dirname(directory);
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith(prefix) || !temporaryName.test(name)) continue;
      const other = path.join(parent, name);
      if (other === directory) continue;
      let record: Owner | undefined;
      try { record = readOwner(other); }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (record?.pendingCommit && record.refreshInput === input) {
        throw new Error(`同一登录上次查询的凭据尚未确认写回，已停止再次续期。恢复副本位于 ${other}，请保留该目录或重新登录`);
      }
    }
    owner.refreshInput = input;
  }
  owner.pendingCommit = true;
  writeOwner(directory, owner);
}

/** Keep the recoverable output when only the access token changed. Its refresh token can still be used. */
export function allowUnchangedTemporaryRefresh(directory: string): void {
  const owner = owned.get(directory);
  if (!owner?.refreshInput) return;
  try {
    if (readOwner(directory)?.nonce !== owner.nonce) return;
    const updated = { ...owner, refreshInput: undefined };
    writeOwner(directory, updated);
    owned.set(directory, updated);
  } catch { /* An unreadable or unwritable recovery record retains its original protection. */ }
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
        if (!owner || owner.pendingCommit || alive(owner.pid) || (!earlierWindowsBoot(owner.windowsBoot, boot) && writersRemain(owner))) {
          result.retained.push(directory); continue;
        }
        fs.rmSync(directory, { recursive: true });
        result.removed.push(directory);
      } catch { result.retained.push(directory); }
    }
  }
  return result;
}
