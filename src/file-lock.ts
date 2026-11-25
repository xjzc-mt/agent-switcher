import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function processReusedPid(pid: number, stat: fs.Stats, permissionDenied = false): boolean {
  if (process.platform === 'win32' || (!permissionDenied && Date.now() - stat.mtimeMs <= 2000)) return false;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'uid=', '-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const processInfo = /^(\d+)\s+(.+)$/.exec(out);
    if (!processInfo) return false;
    if (permissionDenied && Number(processInfo[1]) !== stat.uid) return true;
    const startedAt = Date.parse(processInfo[2]);
    return Number.isFinite(startedAt) && startedAt > stat.mtimeMs + 2000;
  } catch { return false; }
}

export function lockIsDead(stat: fs.Stats, raw: string): boolean {
  const pid = Number(raw.trim().split(/\s+/)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - stat.mtimeMs > 5000;
  try {
    process.kill(pid, 0);
    return processReusedPid(pid, stat);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    return code === 'EPERM' && typeof process.getuid === 'function' && stat.uid === process.getuid() &&
      processReusedPid(pid, stat, true);
  }
}

export function tryAcquireAtomicLock(lock: string, payload: string): string | null {
  const ownerId = `${process.pid}-${randomUUID()}`;
  const stage = `${lock}.stage-${ownerId}`;
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(stage, ownerId), payload, { flag: 'wx', mode: 0o600 });
    fs.renameSync(stage, lock);
    return ownerId;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY', 'ENOTDIR', 'EACCES'].includes(code)) return null;
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function releaseAtomicLock(lock: string, ownerId: string): boolean {
  if (!ownerId) return false;
  try { fs.unlinkSync(path.join(lock, ownerId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try { fs.rmdirSync(lock); return true; }
  catch { return false; }
}

export function evictDeadLock(lock: string): boolean {
  const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
  if (!stat) return true;
  if (stat.isDirectory()) {
    let entries: string[];
    try { entries = fs.readdirSync(lock); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    for (const entry of entries) {
      const entryPath = path.join(lock, entry);
      try {
        const entryStat = fs.lstatSync(entryPath);
        const raw = fs.readFileSync(entryPath, 'utf8');
        if (!lockIsDead(entryStat, raw)) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    for (const entry of entries) {
      try { fs.unlinkSync(path.join(lock, entry)); } catch {}
    }
    try { fs.rmdirSync(lock); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  }
  let raw: string;
  try { raw = fs.readFileSync(lock, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  if (!lockIsDead(stat, raw)) return false;
  // Renaming onto an existing regular file atomically rejects directory locks (ENOTDIR/EISDIR).
  const trash = `${lock}.trash-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(trash, '', { flag: 'wx', mode: 0o600 });
    fs.renameSync(lock, trash);
    return true;
  } catch { return false; }
  finally { fs.rmSync(trash, { force: true }); }
}

/** Readers that cannot wait use the same owner/eviction rules as both kinds of writer. */
export function tryClaimFileLock(lock: string, payload: string): string | null {
  return tryAcquireAtomicLock(lock, payload) ?? (evictDeadLock(lock) ? tryAcquireAtomicLock(lock, payload) : null);
}

function* waitForLock(lock: string, timeout: number, message: string): Generator<void, string> {
  const payload = process.pid + '\n' + randomUUID();
  const deadline = Date.now() + timeout;
  for (;;) {
    const owner = tryClaimFileLock(lock, payload);
    if (owner) return owner;
    if (Date.now() >= deadline) throw new Error(message);
    yield;
  }
}

export async function withFileLock<T>(lock: string, work: () => Promise<T>, timeout = 20000): Promise<T> {
  const attempts = waitForLock(lock, timeout, '另一个账号操作仍在进行，请稍后重试');
  let next = attempts.next();
  while (!next.done) {
    await new Promise(resolve => setTimeout(resolve, 100));
    next = attempts.next();
  }
  try { return await work(); } finally { releaseAtomicLock(lock, next.value); }
}

export function withKeyCreationLock<T>(lock: string, work: () => T): T {
  const attempts = waitForLock(lock, 300, '账号池密钥正在初始化，请稍后重试；无法确认锁归属时不会覆盖它');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let next = attempts.next();
  while (!next.done) {
    Atomics.wait(pause, 0, 0, 50);
    next = attempts.next();
  }
  try { return work(); } finally { releaseAtomicLock(lock, next.value); }
}
