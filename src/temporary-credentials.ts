import { replacePrivateFile } from './private-files';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { execFile, execFileSync, type ChildProcess } from 'child_process';
import { earlierWindowsBoot, windowsBoot } from './windows-processes';
import { createPrivateWindowsQuotaDirectory, trustedWindowsQuotaDirectory } from './antigravity-windows';
import { encodeCredentialFile, verifyCredentialWrite } from './credential-vault';
import { atomicWrite, ensureDir, readBuffer, syncPath } from './utils';
import { stepDiagnostic } from './diagnostics';

const run = promisify(execFile);

type Purpose = 'login' | 'quota' | 'agy-quota' | 'preview' | 'update' | 'import';
interface Owner {
  version: 1; pid: number; nonce: string; launching: boolean;
  pendingCommit?: boolean;
  windowsBoot?: string;
  refreshInput?: string;
  inputDigest?: string;
  inputRevision?: string;
  quotaIdentity?: string;
  recoveryDigest?: string;
  verification?: boolean;
  processes: Array<{ pid: number; group: boolean; jobDrained?: true }>;
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
  const name = `agent-switcher-${user}`, temporary = path.join(os.tmpdir(), name);
  const local = process.platform === 'win32' && process.env.LOCALAPPDATA;
  const candidate = local && path.isAbsolute(local) ? path.join(local, 'Temp', name) : temporary;
  return { temporary, store: path.join(os.homedir(), '.agent-switcher'), quota: path.relative(candidate, temporary) ? candidate : temporary };
}
function quotaRoots(prefix: string): string[] {
  const { quota, temporary } = roots();
  return prefix === 'ags-agy-quota-' && quota !== temporary ? [quota, temporary] : [temporary];
}
function inaccessibleLegacyQuota(parent: string, prefix: string, error: unknown): boolean {
  const { temporary, quota } = roots();
  return prefix === 'ags-agy-quota-' && temporary !== quota && parent === temporary &&
    ['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '');
}
function directoryIsOwned(directory: string): boolean {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
function checkedDirectory(directory: string): boolean {
  const { temporary, store, quota } = roots(), parent = path.dirname(directory), name = path.basename(directory);
  return (((parent === temporary || (parent === quota && name.startsWith('ags-agy-quota-'))) && temporaryName.test(name)) ||
    (parent === store && importName.test(name))) &&
    directoryIsOwned(parent) && directoryIsOwned(directory) && (parent !== temporary || quota === temporary ||
      !name.startsWith('ags-agy-quota-') || trustedWindowsQuotaDirectory(directory));
}
function writeOwner(directory: string, owner: Owner) {
  replacePrivateFile(path.join(directory, marker), JSON.stringify(owner));
}
function readOwner(directory: string): Owner | undefined {
  if (!checkedDirectory(directory)) return;
  const file = path.join(directory, marker), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pid = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  if (value?.version !== 1 || !pid(value.pid) || typeof value.nonce !== 'string' ||
      typeof value.launching !== 'boolean' || !Array.isArray(value.processes) ||
      (value.pendingCommit !== undefined && typeof value.pendingCommit !== 'boolean') ||
      !value.processes.every((p: { pid?: number; group?: boolean; jobDrained?: unknown }) => p && pid(p.pid) &&
        typeof p.group === 'boolean' && (p.jobDrained === undefined || (p.jobDrained === true && !p.group)))) return;
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
  if (earlierWindowsBoot(owner.windowsBoot, boot)) return false;
  return owner.launching || owner.processes.some(p => !p.jobDrained && (!p.group || groupHasLiveWriters(p.pid)));
}

function ownerStillRunning(owner: Owner): boolean {
  return !earlierWindowsBoot(owner.windowsBoot, boot) && alive(owner.pid);
}

/** Only the Windows quota runner can attest that its kernel job has no remaining writers. */
function windowsQuotaReceipt(directory: string, pid: number | undefined): number | undefined {
  if (!pid) return;
  try {
    const receipt = path.join(directory, '.ags-win-drained-' + pid), stat = fs.lstatSync(receipt);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 3) return;
    const text = fs.readFileSync(receipt, 'ascii');
    if (['0', '1', '124'].includes(text)) return Number(text);
  } catch { /* An unavailable receipt proves nothing about the job. */ }
}
function windowsQuotaNeverStarted(directory: string, owner: Owner): boolean {
  if (process.platform !== 'win32' || owner.launching || !owner.processes.length) return false;
  return owner.processes.every(p => !p.group && windowsQuotaReceipt(directory, p.pid) === 124) &&
    trustedWindowsQuotaDirectory(directory);
}
export function confirmWindowsQuotaExit(directory: string, child: ChildProcess, code: number | null): boolean {
  if (code !== 0 && code !== 1 && code !== 124) return false;
  const owner = owned.get(directory);
  if (!owner) return true;
  try {
    const record = readOwner(directory);
    const processRecord = record?.processes.find(p => p.pid === child.pid && !p.group);
    if (!record || owner.nonce !== record.nonce || !processRecord) return false;
    if (windowsQuotaReceipt(directory, child.pid) !== code) return false;
    processRecord.jobDrained = true;
    writeOwner(directory, record);
    owned.set(directory, record);
    return true;
  } catch { return false; }
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
    const root = roots().temporary;
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
  const { temporary, store, quota } = roots();
  const parent = options.store ? store : purpose === 'agy-quota' ? quota : temporary;
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!directoryIsOwned(parent)) throw new Error('临时凭据目录不安全');
  fs.chmodSync(parent, 0o700);
  const directory = path.join(parent, `${options.store ? '.import' : `ags-${purpose}`}-${randomUUID()}`);
  if (process.platform === 'win32' && purpose === 'agy-quota') createPrivateWindowsQuotaDirectory(directory);
  else fs.mkdirSync(directory, { mode: 0o700 });
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
  // Install the crash record before exposing a refresh token even to CLI initialization.
  if (owner.quotaIdentity && owner.refreshInput && owner.inputDigest) {
    writeQuotaIntent(quotaIntentFile(owner)!, {
      name: path.basename(directory), nonce: owner.nonce, inputDigest: owner.inputDigest,
    }, true);
  }
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

function matchingPending(parent: string, prefix: string, input: string, digest?: string) {
  const matches: Array<{ directory: string; record: Owner }> = [];
  const names = quotaDirectoryNames(parent, prefix);
  for (const name of names) {
    if (!name.startsWith(prefix) || !temporaryName.test(name)) continue;
    const directory = path.join(parent, name);
    let record: Owner | undefined;
    try { record = readOwner(directory); }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT' || inaccessibleLegacyQuota(parent, prefix, error)) continue;
      throw error;
    }
    if (record?.pendingCommit && (record.refreshInput === input || (digest && record.recoveryDigest === digest))) {
      matches.push({ directory, record });
    }
  }
  return matches;
}
function quotaDirectoryNames(parent: string, prefix: string, cleanup = false): string[] {
  try {
    if (!directoryIsOwned(parent)) {
      if (cleanup) return [];
      throw new Error('临时凭据目录不安全');
    }
    return fs.readdirSync(parent);
  } catch (error) {
    // The sealed account-specific intent still gates retries if an obsolete TEMP is no longer mounted or readable.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || inaccessibleLegacyQuota(parent, prefix, error)) return [];
    throw error;
  }
}
const bytesDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const outputDigest = (identity: string, bytes: Buffer) => createHash('sha256').update(identity).update('\0').update(bytes).digest('hex');
const refreshDigest = (prefix: string, identity: string, token: string) =>
  createHash('sha256').update(JSON.stringify([prefix, identity, token])).digest('hex');

type QuotaIntent = { name: string; nonce: string; inputDigest: string; recoveryDigest?: string; output?: string };
const quotaFilePrefix = (identityHash: string) => '.antigravity-quota-' + identityHash + '-';
function quotaIntentFile(owner: Owner) {
  if (!owner.quotaIdentity || !owner.refreshInput) return;
  if (![owner.quotaIdentity, owner.refreshInput].every(s => /^[0-9a-f]{64}$/.test(s))) throw new PendingQuotaConflict();
  return path.join(roots().store, quotaFilePrefix(owner.quotaIdentity) + owner.refreshInput);
}
function readQuotaIntent(file: string): QuotaIntent | undefined {
  const raw = readBuffer(file);
  if (!raw) return;
  let intent: QuotaIntent;
  try { intent = JSON.parse(raw.toString()); } catch { throw new PendingQuotaConflict(); }
  if (!intent || !temporaryName.test(intent.name) || !intent.name.startsWith('ags-agy-quota-') ||
      typeof intent.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(intent.inputDigest)) throw new PendingQuotaConflict();
  return intent;
}
function writeQuotaIntent(file: string, intent: QuotaIntent, create = false) {
  const bytes = Buffer.from(JSON.stringify(intent));
  if (!create) { atomicWrite(file, bytes); return; }
  ensureDir(path.dirname(file));
  const encrypted = encodeCredentialFile(file, bytes);
  const staging = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(staging, encrypted, { mode: 0o600, flag: 'wx', flush: true });
    verifyCredentialWrite(file, fs.readFileSync(staging), bytes);
    fs.linkSync(staging, file);
    if (process.platform !== 'win32') syncPath(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PendingQuotaConflict();
    throw error;
  } finally { fs.rmSync(staging, { force: true }); }
}
function finishQuotaIntent(file: string, nonce: string) {
  const intent = readQuotaIntent(file);
  if (!intent) return;
  if (intent.nonce !== nonce) throw new PendingQuotaConflict();
  fs.unlinkSync(file);
  if (process.platform !== 'win32') syncPath(path.dirname(file));
}

export class PendingQuotaConflict extends Error {
  constructor(readonly needsAuthorization = true, readonly diagnostic: 'recovery-writer' | 'recovery-conflict' |
      'recovery-missing' | 'recovery-owner-unknown' = needsAuthorization ? 'recovery-conflict' : 'recovery-writer') {
    super(!needsAuthorization ? '上次额度查询仍在处理凭据，请稍后刷新。' : diagnostic === 'recovery-missing'
      ? '上次续期的结果文件缺失，已停止使用旧凭据。请更新此账号的登录凭据。'
      : '无法确认上次续期的结果，已保留现有记录。请更新此账号的登录凭据。');
  }
}

export class ConsumedCodexRotation extends PendingQuotaConflict {
  constructor(directory: string) {
    super();
    this.message = `旧续期凭据已轮换，无法确认新凭据属于登记账号，已停止使用旧凭据。请重新授权；恢复副本保留在 ${directory}`;
  }
}

/** Read back only a private, regular file inside a stopped Codex query's checked directory. */
function codexRecoveryFile(file: string): Buffer | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (process.platform !== 'win32' &&
      (stat.uid !== process.getuid!() || (stat.mode & 0o077)))) throw new PendingQuotaConflict();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const actual = fs.fstatSync(fd);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new PendingQuotaConflict();
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function pendingCodexQuota(identity: string, token: string, original: Buffer, revision?: string) {
  const prefix = 'ags-quota-', digest = bytesDigest(original);
  return matchingPending(roots().temporary, prefix, refreshDigest(prefix, identity, token), digest).map(({ directory, record }) => {
    const check = () => {
      if (JSON.stringify(readOwner(directory)) !== JSON.stringify(record)) throw new PendingQuotaConflict();
      if (writersRemain(record) || (ownerStillRunning(record) &&
          !(record.recoveryDigest && owned.get(directory)?.nonce === record.nonce))) throw new PendingQuotaConflict(false);
    };
    check();
    if (record.verification) {
      const error = new PendingQuotaConflict();
      error.message += ` 恢复副本保留在 ${directory}`;
      throw error;
    }
    if (process.platform === 'win32' ? !trustedWindowsQuotaDirectory(directory, true) :
        [path.dirname(directory), directory].some(dir => fs.lstatSync(dir).mode & 0o077)) throw new PendingQuotaConflict();
    if (!codexRecoveryFile(path.join(directory, marker))) throw new PendingQuotaConflict();
    const output = codexRecoveryFile(path.join(directory, 'auth.json'));
    if (record.recoveryDigest && (!output || record.recoveryDigest !== bytesDigest(output))) throw new PendingQuotaConflict();
    return { directory, output, alreadyStored: record.recoveryDigest === digest,
      exactInput: record.inputDigest && (record.inputDigest === bytesDigest(original) || (!!revision && record.inputRevision === revision)),
      matchesInput: (bytes: Buffer, version?: string) => (!!version && record.inputRevision === version) || record.inputDigest === bytesDigest(bytes),
      beforeStore(bytes: Buffer) {
        check();
        record.inputDigest ??= bytesDigest(original);
        record.inputRevision ??= revision;
        record.recoveryDigest = bytesDigest(bytes);
        writeOwner(directory, record);
      },
      finish() {
        check();
        owned.set(directory, record);
        if (!releaseTemporaryCredentials(directory)) throw new PendingQuotaConflict();
      },
    };
  });
}

/** Only the account refresh lock holder may reconcile a stopped query. The caller commits under the pool lock. */
export function pendingAntigravityQuota(identity: string, refreshToken: string, original: Buffer) {
  const prefix = 'ags-agy-quota-', digest = outputDigest(identity, original);
  const { quota, store } = roots(), input = refreshDigest(prefix, identity, refreshToken);
  const matches = quotaRoots(prefix).flatMap(parent => matchingPending(parent, prefix, input, digest));
  const intentPrefix = quotaFilePrefix(bytesDigest(Buffer.from(identity)));
  const matchesGrant = (stored: string | undefined, token?: string) => !!token && refreshDigest(prefix, identity, token) === stored;
  let persisted: { file: string; intent: QuotaIntent } | undefined;
  for (const name of fs.existsSync(store) ? fs.readdirSync(store) : []) {
    if (!name.startsWith(intentPrefix) || !/^[0-9a-f]{64}$/.test(name.slice(intentPrefix.length))) continue;
    const sameInput = name === intentPrefix + input;
    const file = path.join(store, name);
    let intent: QuotaIntent | undefined;
    try { intent = readQuotaIntent(file); }
    catch (error) {
      if (!sameInput) continue;
      if (!(error instanceof PendingQuotaConflict)) stepDiagnostic('storage-unavailable');
      throw error;
    }
    if (!intent || (!sameInput && intent.recoveryDigest !== digest)) continue;
    if (persisted) throw new PendingQuotaConflict();
    persisted = { file, intent };
  }
  if (persisted && !matches.length) {
    // The OS may have reclaimed the CLI home. Only our authenticated, drained output can replace it.
    const { intent, file } = persisted;
    const directory = path.join(quota, intent.name);
    const recordedGrant = path.basename(file).slice(intentPrefix.length);
    const alreadyStored = intent.recoveryDigest === digest;
    const savedOutput = intent.output ? Buffer.from(intent.output, 'base64') : alreadyStored ? original : undefined;
    if (!savedOutput) throw new PendingQuotaConflict(true, 'recovery-missing');
    if (outputDigest(identity, savedOutput) !== intent.recoveryDigest) throw new PendingQuotaConflict();
    function checkOutput(bytes: Buffer | undefined) {
      if (!bytes || !bytes.equals(savedOutput!)) throw new PendingQuotaConflict();
    }
    return { directory, savedOutput, alreadyStored, launched: true, exactInput: intent.inputDigest === bytesDigest(original),
      matchesInput: (bytes: Buffer, token?: string) => intent.inputDigest === bytesDigest(bytes) || matchesGrant(recordedGrant, token),
      checkOutput, beforeStore(bytes: Buffer) {
        checkOutput(bytes);
        const current = readQuotaIntent(file);
        if (current?.nonce !== intent.nonce || current.recoveryDigest !== intent.recoveryDigest) throw new PendingQuotaConflict();
      }, finish: () => finishQuotaIntent(file, intent.nonce) };
  }
  if (!matches.length) return;
  const { directory, record } = matches[0];
  const unavailable = new PendingQuotaConflict();
  if (matches.length !== 1) throw unavailable;
  if (persisted && (persisted.intent.nonce !== record.nonce || persisted.intent.name !== path.basename(directory))) throw unavailable;
  // A crash may occur after the supervisor's proof but before the parent records its close event.
  // Code 124 proves the official CLI never started. A drained error from a running CLI cannot prove this.
  if (persisted && !persisted.intent.recoveryDigest && !record.recoveryDigest && persisted.intent.inputDigest === record.inputDigest &&
      windowsQuotaNeverStarted(directory, record) && quotaIntentFile(record) === persisted.file &&
      (!ownerStillRunning(record) || owned.get(directory)?.nonce === record.nonce)) {
    if (JSON.stringify(readOwner(directory)) !== JSON.stringify(record)) throw unavailable;
    for (const p of record.processes) p.jobDrained = true;
    writeOwner(directory, record); owned.set(directory, record);
    recordAntigravityQuotaOutput(directory, identity, original);
    if (!releaseTemporaryCredentials(directory)) throw unavailable;
    return;
  }
  // The identity lock excludes an active AGS query. Leftover PIDs (including a reused
  // group) cannot prove a writer is finished. Preserve its files and allow a new login.
  if (writersRemain(record) || (!persisted?.intent.recoveryDigest && ownerStillRunning(record) && owned.get(directory)?.nonce !== record.nonce)) {
    throw new PendingQuotaConflict(true, 'recovery-owner-unknown');
  }
  const alreadyStored = record.recoveryDigest === digest || persisted?.intent.recoveryDigest === digest;
  function checkOwner() {
    const current = readOwner(directory);
    if (!current || JSON.stringify(current) !== JSON.stringify(record) || writersRemain(current)) throw unavailable;
  }
  return {
    directory, savedOutput: persisted?.intent.output ? Buffer.from(persisted.intent.output, 'base64') : undefined,
    launched: !!persisted || record.processes.length > 0, alreadyStored, exactInput: record.inputDigest === bytesDigest(original),
    matchesInput: (bytes: Buffer, token?: string) => record.inputDigest === bytesDigest(bytes) || matchesGrant(record.refreshInput, token),
    checkOutput(bytes: Buffer | undefined) {
      const expected = persisted?.intent.recoveryDigest ?? record.recoveryDigest;
      if (expected && !bytes) throw new PendingQuotaConflict(true, 'recovery-missing');
      if (expected && bytes && expected !== outputDigest(identity, bytes)) throw unavailable;
    },
    beforeStore(bytes: Buffer) {
      checkOwner();
      record.inputDigest ??= bytesDigest(original);
      record.recoveryDigest = outputDigest(identity, bytes);
      if (persisted?.intent.recoveryDigest !== record.recoveryDigest) {
        record.quotaIdentity = bytesDigest(Buffer.from(identity));
        const file = quotaIntentFile(record)!;
        const intent: QuotaIntent = { name: path.basename(directory), nonce: record.nonce, inputDigest: record.inputDigest,
          recoveryDigest: record.recoveryDigest, output: bytes.toString('base64') };
        writeQuotaIntent(file, intent, !persisted);
        persisted = { file, intent };
      }
      writeOwner(directory, record);
    },
    finish() {
      checkOwner();
      owned.set(directory, record);
      if (!releaseTemporaryCredentials(directory)) throw unavailable;
      if (persisted && !record.quotaIdentity) finishQuotaIntent(persisted.file, record.nonce);
    },
  };
}

/** A trusted replacement or final removal holds the identity and store locks.
 * Earlier releases only recorded a hash of the old grant in the temporary home. */
export function discardSupersededQuota(agent: string, identity: string, oldTokens: (string | undefined)[], replacing: boolean, currentToken?: string) {
  const { store } = roots();
  const prefix = agent === 'agy' ? 'ags-agy-quota-' : 'ags-quota-';
  const identityHash = bytesDigest(Buffer.from(identity));
  const inputs = new Set(oldTokens.filter((token): token is string => !!token && token !== currentToken)
    .map(token => refreshDigest(prefix, identity, token)));
  const superseded = (input: string | undefined, boundIdentity: boolean) =>
    !!input && (inputs.has(input) || !replacing && boundIdentity);
  const parents = quotaRoots(prefix);
  for (const temporary of parents) {
    for (const name of quotaDirectoryNames(temporary, prefix, true)) {
      if (!name.startsWith(prefix) || !temporaryName.test(name)) continue;
      const directory = path.join(temporary, name);
      try {
        const owner = readOwner(directory);
        if (!owner?.pendingCommit || (owner.quotaIdentity && owner.quotaIdentity !== identityHash) ||
            !superseded(owner.refreshInput, owner.quotaIdentity === identityHash) || writersRemain(owner) ||
            (ownerStillRunning(owner) && owned.get(directory)?.nonce !== owner.nonce)) continue;
        const file = quotaIntentFile(owner), intent = file && readQuotaIntent(file);
        if (intent && (intent.nonce !== owner.nonce || intent.name !== name)) continue;
        owned.set(directory, owner);
        releaseTemporaryCredentials(directory);
      } catch { /* Unknown ownership or storage failure preserves the only recovery copy. */ }
    }
  }
  if (agent !== 'agy' || !fs.existsSync(store)) return;
  const filePrefix = quotaFilePrefix(identityHash);
  for (const name of fs.readdirSync(store)) {
    if (!name.startsWith(filePrefix)) continue;
    const input = name.slice(filePrefix.length);
    if (!/^[0-9a-f]{64}$/.test(input) || !superseded(input, true)) continue;
    const file = path.join(store, name);
    try {
      const intent = readQuotaIntent(file);
      // Without the owner directory, only an authenticated, drained output proves completion.
      if (intent?.recoveryDigest && parents.every(parent => !fs.lstatSync(path.join(parent, intent.name), { throwIfNoEntry: false })))
        finishQuotaIntent(file, intent.nonce);
    } catch { /* Ambiguous ownership must survive this cleanup. */ }
  }
}

/** A query can rotate a token before the account pool accepts it. Preserve its only disk copy. */
export function markTemporaryCredentialsPending(directory: string, identity?: string, refreshToken?: string, original?: Buffer, verification = false): void {
  const owner = owned.get(directory);
  if (!owner || readOwner(directory)?.nonce !== owner.nonce) throw new Error('临时凭据目录状态已变化');
  if (identity && refreshToken) {
    const prefix = path.basename(directory).startsWith('ags-agy-quota-') ? 'ags-agy-quota-' : 'ags-quota-';
    const input = refreshDigest(prefix, identity, refreshToken);
    const conflict = quotaRoots(prefix).flatMap(parent => matchingPending(parent, prefix, input)).find(entry => entry.directory !== directory);
    if (conflict) {
      const error = new PendingQuotaConflict(!(writersRemain(conflict.record) || ownerStillRunning(conflict.record)));
      if (verification || conflict.record.verification) error.message += ` 恢复副本保留在 ${conflict.directory}`;
      throw error;
    }
    if (verification) owner.verification = true;
    if (original && prefix === 'ags-agy-quota-') {
      const quotaIdentity = bytesDigest(Buffer.from(identity));
      if (fs.lstatSync(path.join(roots().store, quotaFilePrefix(quotaIdentity) + input), { throwIfNoEntry: false })) throw new PendingQuotaConflict();
      owner.quotaIdentity = quotaIdentity;
    }
    owner.refreshInput = input;
    if (original) owner.inputDigest = bytesDigest(original);
  }
  owner.pendingCommit = true;
  writeOwner(directory, owner);
}

/** A later restart can match a verified pool write even after its refresh token changed. */
export function recordAntigravityQuotaOutput(directory: string, identity: string, bytes: Buffer | null): void {
  const record = readOwner(directory);
  if (!record?.pendingCommit || owned.get(directory)?.nonce !== record.nonce) throw new PendingQuotaConflict();
  if (writersRemain(record)) throw new PendingQuotaConflict(false);
  if (!bytes) {
    if (record.processes.length) throw new PendingQuotaConflict(true, 'recovery-missing');
    return;
  }
  record.recoveryDigest = outputDigest(identity, bytes);
  const file = quotaIntentFile(record);
  if (file) {
    const intent = readQuotaIntent(file);
    // Failures proven to occur before process creation have no outstanding authorization request.
    if (!intent && !record.processes.length) return;
    if (!intent || intent.nonce !== record.nonce) throw new PendingQuotaConflict();
    writeQuotaIntent(file, { ...intent, recoveryDigest: record.recoveryDigest,
      output: bytesDigest(bytes) === intent.inputDigest ? undefined : bytes.toString('base64') });
  }
  writeOwner(directory, record);
  owned.set(directory, record);
}

/** A locally plausible token pair must never override an explicit identity rejection from the service. */
export function quarantineCodexQuota(directory: string): void {
  const owner = owned.get(directory);
  if (!owner || readOwner(directory)?.nonce !== owner.nonce) throw new PendingQuotaConflict();
  owner.verification = true;
  writeOwner(directory, owner);
}

/** Record the accepted bytes before the first write. Recovery separately confirms all writers have exited. */
export function recordCodexQuotaOutput(directory: string, revision: string | undefined, output: Buffer): void {
  const owner = owned.get(directory);
  if (!owner?.refreshInput || !path.basename(directory).startsWith('ags-quota-')) return;
  if (readOwner(directory)?.nonce !== owner.nonce) throw new PendingQuotaConflict();
  // Only ordinary refresh submits accepted output here; external replacement candidates have their own commit path.
  delete owner.verification;
  owner.recoveryDigest = bytesDigest(output);
  owner.inputRevision = revision;
  writeOwner(directory, owner);
}

/** Release only after a verified write-back, or after proving no credentials changed. */
export function releaseTemporaryCredentials(directory: string): boolean {
  try {
    const owner = owned.get(directory);
    if (!owner || readOwner(directory)?.nonce !== owner.nonce) return false;
    const file = quotaIntentFile(owner);
    if ((file || (owner.pendingCommit && process.platform !== 'win32')) && writersRemain(owner)) return false;
    const released = { ...owner, pendingCommit: false };
    writeOwner(directory, released);
    owned.set(directory, released);
    if (!removeTemporaryCredentials(directory)) return false;
    if (file) finishQuotaIntent(file, owner.nonce);
    return true;
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
  const { temporary, store } = roots();
  for (const parent of [...quotaRoots('ags-agy-quota-'), store]) {
    const entries = quotaDirectoryNames(parent, 'ags-agy-quota-', true);
    const names = entries.filter(name => parent === store ? importName.test(name) :
      temporaryName.test(name) && (parent === temporary || name.startsWith('ags-agy-quota-')));
    for (const name of names) {
      const directory = path.join(parent, name);
      try {
        const owner = readOwner(directory);
        if (!owner || owner.pendingCommit || ownerStillRunning(owner) || writersRemain(owner)) {
          result.retained.push(directory); continue;
        }
        fs.rmSync(directory, { recursive: true });
        result.removed.push(directory);
      } catch { result.retained.push(directory); }
    }
  }
  return result;
}
