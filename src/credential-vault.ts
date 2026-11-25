import { withKeyCreationLock } from './file-lock';
import { hasUnsafeParent, readRegularFile, replacePrivateFile } from './private-files';
import { agentMetadata } from './agents/metadata';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Worker, isMainThread } from 'worker_threads';

const MAGIC = Buffer.from('AGS-CREDENTIALS-1\n');
const PREFIX = Buffer.from('AGS-CREDENTIALS-');
export const STAGED_CREDENTIAL_SUFFIX = '.pending';
export const ANTIGRAVITY_SWITCH_FILE = '.antigravity-switch.pending';
const quotaRecoveryFile = /^\.antigravity-quota-[0-9a-f]{64}-[0-9a-f]{64}$/;
const credentialNames: Record<string, string> = Object.fromEntries(Object.entries(agentMetadata).map(([id, meta]) => [id, meta.credential]));
const service = 'com.agent-switcher.credentials.v1';
const account = 'master-key';
const poolRoot = () => path.join(os.homedir(), '.agent-switcher');

/** The temporary rotation output may be removed immediately after a pool credential is replaced. */
export function commitsAntigravityQuota(file: string): boolean {
  const name = path.basename(file);
  return name === credentialNames.agy || name === credentialNames.agy + STAGED_CREDENTIAL_SUFFIX || quotaRecoveryFile.test(name);
}

export interface CredentialKeyProvider {
  read(): Buffer | null;
  create(key: Buffer): void;
}

function checkDirectories(file: string) {
  if (hasUnsafeParent(file, poolRoot())) throw new Error('账号目录必须是普通目录，不能是符号链接');
}

/** Only AGS-owned credential files are encrypted; clients and temporary official homes use their native format. */
export function managedCredentialKind(file: string): string | undefined {
  const relative = path.relative(poolRoot(), path.resolve(file));
  if (quotaRecoveryFile.test(relative)) {
    checkDirectories(path.resolve(file));
    return relative;
  }
  if (isSwitchRecord(relative)) {
    checkDirectories(path.resolve(file));
    return ANTIGRAVITY_SWITCH_FILE;
  }
  const parts = relative.split(path.sep);
  if (parts[0]?.startsWith('.import-')) parts.shift();
  const expected = credentialNames[parts[0]];
  if (parts.length !== 3 || !parts[1] || !expected || (parts[2] !== expected && parts[2] !== expected + STAGED_CREDENTIAL_SUFFIX)) return undefined;
  checkDirectories(path.resolve(file));
  return `${parts[0]}/${parts[2]}`;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32 || key.toString('base64') !== value.trim()) throw new Error('系统保存的账号池密钥格式无效，已保留原凭据');
  return key;
}

function systemCommand(command: string, args: string[], input?: string): string {
  return execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 65536 }).trim();
}

function dpapi(input: string, protect: boolean): string {
  const method = protect ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $ErrorActionPreference='Stop'; ` +
    `$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
    `$result=[Security.Cryptography.ProtectedData]::${method}($bytes,[Text.Encoding]::UTF8.GetBytes('${service}'),[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($result))`;
  return systemCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);
}

const systemProvider: CredentialKeyProvider = {
  read() {
    try {
      if (process.platform === 'darwin') {
        try { return decodeKey(systemCommand('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'])); }
        catch (error) { if ((error as { status?: number }).status === 44) return null; throw error; }
      }
      if (process.platform === 'win32') {
        const bytes = readRegularFile(path.join(poolRoot(), '.vault-key.dpapi'));
        return bytes ? decodeKey(dpapi(bytes.toString('base64'), false)) : null;
      }
      if (process.platform === 'linux') {
        try {
          const value = systemCommand('secret-tool', ['lookup', 'application', service, 'account', account]);
          return value ? decodeKey(value) : null;
        } catch (error) {
          const failure = error as { status?: number; stderr?: string };
          if (failure.status === 1 && !String(failure.stderr || '').trim()) return null;
          throw error;
        }
      }
      throw new Error('unsupported');
    } catch { throw new Error('无法读取系统安全存储中的账号池密钥；请解锁系统密钥存储后重试，原凭据未修改'); }
  },
  create(key) {
    try {
      if (process.platform === 'darwin') {
        // No -U: never replace an existing key. stdin keeps key material out of process arguments.
        systemCommand('/usr/bin/security', ['-i'], `add-generic-password -s ${service} -a ${account} -w "${key.toString('base64')}"\n`);
      } else if (process.platform === 'win32') {
        const bytes = Buffer.from(dpapi(key.toString('base64'), true), 'base64');
        if (!bytes.length) throw new Error('empty');
        fs.writeFileSync(path.join(poolRoot(), '.vault-key.dpapi'), bytes, { flag: 'wx', mode: 0o600 });
      } else if (process.platform === 'linux') {
        systemCommand('secret-tool', ['store', '--label=AgentSwitcher credentials', 'application', service, 'account', account], key.toString('base64'));
      } else throw new Error('unsupported');
    } catch { throw new Error('无法创建受系统保护的账号池密钥；请检查系统安全存储，未回退为明文保存'); }
  },
};

let keyProvider = systemProvider;
// Already unlocked credentials stay readable for this session, including recovery
// export after a Keychain problem. Writes and migration always recheck the system.
const readKeys = new Map<string, Buffer>();
function clearReadKeys() { for (const key of readKeys.values()) key.fill(0); readKeys.clear(); }
/** Process-local dependency injection; production has no environment-variable plaintext bypass. */
export function setCredentialKeyProvider(provider: CredentialKeyProvider): () => void {
  const previous = keyProvider;
  clearReadKeys();
  keyProvider = provider;
  return () => { clearReadKeys(); keyProvider = previous; };
}

function poolFiles(includeStaging = false, corrupted?: string[]): string[] {
  const root = poolRoot(), roots = [root];
  checkDirectories(path.join(root, '_'));
  if (!fs.existsSync(root)) return [];
  if (includeStaging) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.import-') && entry.isDirectory()) roots.push(path.join(root, entry.name));
    }
  }
  const files: string[] = [];
  // Retired ciphertext still needs the original vault key. Only inspect it when checking for key loss.
  const names = includeStaging ? { ...credentialNames, claude: '.credentials.json' } : credentialNames;
  for (const base of roots) {
    for (const [agent, name] of Object.entries(names)) {
      const directory = path.join(base, agent);
      if (!fs.existsSync(directory)) continue;
      checkDirectories(path.join(directory, '_'));
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          if (!corrupted) throw new Error('账号目录不能是符号链接');
          corrupted.push(path.join(directory, entry.name));
          continue;
        }
        if (!entry.isDirectory()) continue;
        const candidates = [name, name + STAGED_CREDENTIAL_SUFFIX];
        if (includeStaging) {
          // Even an unrecognized encrypted sidecar belongs to the previous master key.
          // Look for private regular files only; never adopt them as managed credentials.
          const profile = path.join(directory, entry.name);
          checkDirectories(path.join(profile, '_'));
          candidates.push(...fs.readdirSync(profile, { withFileTypes: true })
            .filter(file => file.isFile() && file.name.startsWith('.') && !candidates.includes(file.name)).map(file => file.name));
        }
        for (const candidate of candidates) {
          const file = path.join(directory, entry.name, candidate);
          checkDirectories(file);
          const stat = fs.lstatSync(file, { throwIfNoEntry: false });
          if (!stat) continue;
          if (stat.isFile()) files.push(file);
          else if (corrupted) corrupted.push(file);
          else throw new Error('凭据必须是普通文件');
        }
      }
    }
  }
  return files;
}

function sealed(bytes: Buffer): boolean { return bytes.subarray(0, PREFIX.length).equals(PREFIX); }

/** Key creation only needs the envelope marker, including for retired profiles. */
function hasCredentialEnvelope(file: string): boolean {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('凭据必须是普通文件');
    const prefix = Buffer.alloc(PREFIX.length);
    return fs.readSync(fd, prefix, 0, prefix.length, 0) === prefix.length && prefix.equals(PREFIX);
  } finally { fs.closeSync(fd); }
}

function isSwitchRecord(name: string): boolean {
  return name === ANTIGRAVITY_SWITCH_FILE || /^\.antigravity-switch\.retained-[a-f0-9-]{36}$/.test(name);
}

function loadKey(create: boolean, fresh = false): Buffer {
  const root = poolRoot(), cached = readKeys.get(root);
  if (cached && !fresh) return cached;
  let key = keyProvider.read();
  if (key) {
    if (key.length !== 32) throw new Error('账号池密钥无效，已保留原凭据');
    if (cached && !key.equals(cached)) throw new Error('系统账号池密钥已变化，已停止写入；请先导出仍可读取的账号并恢复原密钥');
    return key;
  }
  if (cached || !create || poolFiles(true).some(hasCredentialEnvelope) ||
      (fs.existsSync(root) && fs.readdirSync(root).some(name => isSwitchRecord(name) || quotaRecoveryFile.test(name)))) {
    throw new Error(cached
      ? '账号池密钥不存在，已停止写入；当前会话仍可导出已解锁账号，请先导出备份并恢复密钥'
      : '账号池密钥不存在，无法读取已有加密凭据；请恢复系统密钥或导入备份，原文件已保留');
  }
  const lock = path.join(root, '.vault-key.lock');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  checkDirectories(path.join(root, '_'));
  return withKeyCreationLock(lock, () => {
    key = keyProvider.read();
    if (!key) {
      const proposed = randomBytes(32);
      keyProvider.create(proposed);
      key = keyProvider.read();
      if (!key?.equals(proposed)) throw new Error('账号池密钥保存后校验失败，原凭据未修改');
    }
    if (key.length !== 32) throw new Error('账号池密钥无效，已保留原凭据');
    return key;
  });
}

/** The worker uses the same system provider, cross-process creation lock and read-back as ordinary writes. */
export function loadImportKeyInWorker(root: string, create: boolean): Buffer {
  if (isMainThread || root !== poolRoot()) throw new Error('批量导入密钥工作线程的账号目录不匹配');
  return loadKey(create, true);
}

async function loadImportKey(create: boolean): Promise<Buffer> {
  if (process.platform !== 'darwin' || keyProvider !== systemProvider) return Buffer.from(loadKey(create, true));
  const root = poolRoot();
  const worker = new Worker(path.join(__dirname, 'credential-key-worker.js'), {
    workerData: { root, create: create && !readKeys.has(root) },
  });
  const key = await new Promise<Buffer>((resolve, reject) => {
    let received = false;
    worker.once('message', (bytes: Uint8Array) => {
      received = true;
      resolve(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
    worker.once('error', reject);
    worker.once('exit', () => { if (!received) reject(new Error('批量导入密钥工作线程未返回结果')); });
  });
  const cached = readKeys.get(root);
  if (root !== poolRoot() || key.length !== 32 || (cached && !key.equals(cached))) {
    key.fill(0);
    throw new Error('系统账号池密钥已变化，已停止导入');
  }
  return key;
}

function decrypt(bytes: Buffer, kind: string, key: Buffer): Buffer {
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes.length < MAGIC.length + 28) throw new Error('加密凭据格式无效或版本不受支持，原文件已保留');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
    cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(kind)]));
    cipher.setAuthTag(bytes.subarray(MAGIC.length + 12, MAGIC.length + 28));
    return Buffer.concat([cipher.update(bytes.subarray(MAGIC.length + 28)), cipher.final()]);
  } catch { throw new Error('加密凭据校验失败，可能损坏或密钥不匹配；原文件已保留'); }
}

function decryptForRead(bytes: Buffer, kind: string, key: Buffer): Buffer {
  const plaintext = decrypt(bytes, kind, key);
  if (!readKeys.has(poolRoot())) readKeys.set(poolRoot(), Buffer.from(key));
  return plaintext;
}

export function decodeCredentialFile(file: string, bytes: Buffer, freshKey = false): Buffer {
  const kind = managedCredentialKind(file);
  if (!kind) return bytes;
  if (sealed(bytes)) return decryptForRead(bytes, kind, loadKey(false, freshKey));
  if (quotaRecoveryFile.test(kind)) throw new Error('额度恢复记录未通过加密校验，已保留现场');
  if (kind === ANTIGRAVITY_SWITCH_FILE) throw new Error('切换恢复记录未通过加密校验，已保留现场');
  try { JSON.parse(bytes.toString()); }
  catch { throw new Error('账号池凭据格式异常，原文件已保留；请检查文件或从备份恢复'); }
  return bytes;
}

function writeKey(file: string, kind: string, key = loadKey(true, true)): Buffer {
  const previous = readRegularFile(file);
  // A replaced/lost key or damaged envelope must not destroy the previous generation.
  if (previous) {
    if (sealed(previous)) decrypt(previous, kind, key);
    else decodeCredentialFile(file, previous);
  }
  if (!readKeys.has(poolRoot())) readKeys.set(poolRoot(), Buffer.from(key));
  return key;
}

/** Check before an operation can rotate tokens; a cached read key cannot authorize renewal. */
export function assertCredentialWriteReady(file: string): void {
  const kind = managedCredentialKind(file);
  if (kind) writeKey(file, kind);
}

function encrypt(bytes: Buffer, kind: string, key: Buffer): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(kind)]));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function encodeCredentialFile(file: string, bytes: Buffer): Buffer {
  const kind = managedCredentialKind(file);
  return kind ? encrypt(bytes, kind, writeKey(file, kind)) : bytes;
}

function verifyEncryptedWrite(kind: string, written: Buffer, original: Buffer, key: Buffer): void {
  if (!decrypt(written, kind, key).equals(original)) throw new Error('加密凭据写入后校验失败，原文件已保留');
}

export function verifyCredentialWrite(file: string, written: Buffer, original: Buffer): void {
  const kind = managedCredentialKind(file);
  if (kind) verifyEncryptedWrite(kind, written, original, loadKey(false, true));
}

/** A single locked install stages encrypted accounts and unverified replacements. */
export async function createImportCredentialWriter(staging: string) {
  const root = poolRoot();
  if (path.dirname(staging) !== root || !path.basename(staging).startsWith('.import-')) throw new Error('导入暂存目录无效');
  const key = await loadImportKey(true);
  let active = true;
  function kindFor(file: string, replacementDir?: string) {
    const dest = path.resolve(file), inStaging = !replacementDir && dest.startsWith(staging + path.sep);
    const parts = path.relative(inStaging ? staging : root, dest).split(path.sep);
    const authFile = credentialNames[parts[0]];
    const allowed = (inStaging || path.dirname(dest) === replacementDir) && parts.length === 3 && authFile &&
      (parts[2] === '_meta.json' || parts[2] === (inStaging ? authFile : authFile + STAGED_CREDENTIAL_SUFFIX));
    if (!active || root !== poolRoot() || !allowed) {
      throw new Error('凭据文件不在本次导入范围内');
    }
    return managedCredentialKind(dest);
  }
  function writerFor(replacementDir?: string) {
    return {
      encodeCredentialFile(file: string, bytes: Buffer): Buffer {
        const kind = kindFor(file, replacementDir);
        return kind ? encrypt(bytes, kind, writeKey(file, kind, key)) : bytes;
      },
      verifyCredentialWrite(file: string, written: Buffer, original: Buffer): void {
        const kind = kindFor(file, replacementDir);
        if (kind) verifyEncryptedWrite(kind, written, original, key);
      },
    };
  }
  return {
    ...writerFor(),
    forReplacement: (dir: string) => writerFor(dir),
    async verifySystemKey(): Promise<void> {
      const current = await loadImportKey(false);
      try {
        if (!active || root !== poolRoot() || !current.equals(key)) throw new Error('导入期间账号池密钥已变化，已停止导入');
      } finally { current.fill(0); }
    },
    close(): void { active = false; key.fill(0); },
  };
}

function isPerFileCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith('账号池凭据格式异常') || message.startsWith('加密凭据格式无效') || message.startsWith('加密凭据校验失败');
}

/** Caller holds the account-store lock. Each original survives until the encrypted disk copy has been verified. */
export function migrateCredentialPool(options: { isolateFileErrors?: boolean } = {}): { migrated: number; corrupted?: string[] } {
  let migrated = 0;
  let scanKey: Buffer | undefined;
  const corrupted: string[] = [];
  for (const file of poolFiles(false, options.isolateFileErrors ? corrupted : undefined)) {
    const original = readRegularFile(file)!;
    if (sealed(original)) scanKey ??= loadKey(false, true);
    try {
      if (sealed(original)) {
        decryptForRead(original, managedCredentialKind(file)!, scanKey!);
        continue;
      }
      decodeCredentialFile(file, original);
    } catch (error) {
      if (!options.isolateFileErrors || !isPerFileCorruption(error)) throw error;
      corrupted.push(file);
      continue;
    }
    replacePrivateFile(file, encodeCredentialFile(file, original), temp => {
      verifyCredentialWrite(file, readRegularFile(temp)!, original);
      if (!readRegularFile(file)?.equals(original)) throw new Error('迁移期间凭据发生变化，已保留现有文件，请重试');
    });
    migrated++;
  }
  return options.isolateFileErrors ? { migrated, corrupted } : { migrated };
}
