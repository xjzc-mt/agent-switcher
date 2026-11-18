import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto';

const MAGIC = Buffer.from('AGS-CREDENTIALS-1\n');
const PREFIX = Buffer.from('AGS-CREDENTIALS-');
const credentialNames: Record<string, string> = { codex: 'auth.json', claude: '.credentials.json', agy: 'jetski-standalone-oauth-token' };
const service = 'com.agent-switcher.credentials.v1';
const account = 'master-key';
const poolRoot = () => path.join(os.homedir(), '.agent-switcher');

export interface CredentialKeyProvider {
  read(): Buffer | null;
  create(key: Buffer): void;
}

function regularFile(file: string): Buffer | null {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('凭据必须是普通文件');
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function checkDirectories(file: string) {
  const root = poolRoot();
  let current = path.dirname(file);
  while (current === root || current.startsWith(root + path.sep)) {
    if (fs.existsSync(current) && !fs.lstatSync(current).isDirectory()) throw new Error('账号目录必须是普通目录，不能是符号链接');
    if (current === root) break;
    current = path.dirname(current);
  }
}

/** Only AGS-owned credential files are encrypted; clients and temporary official homes use their native format. */
export function managedCredentialKind(file: string): string | undefined {
  const relative = path.relative(poolRoot(), path.resolve(file));
  const parts = relative.split(path.sep);
  if (parts[0]?.startsWith('.import-')) parts.shift();
  if (parts.length !== 3 || !parts[1] || credentialNames[parts[0]] !== parts[2]) return undefined;
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
        const bytes = regularFile(path.join(poolRoot(), '.vault-key.dpapi'));
        return bytes ? decodeKey(dpapi(bytes.toString('base64'), false)) : null;
      }
      if (process.platform === 'linux') {
        try {
          const value = systemCommand('secret-tool', ['lookup', 'application', service, 'account', account]);
          return value ? decodeKey(value) : null;
        } catch (error) { if ((error as { status?: number }).status === 1) return null; throw error; }
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

function poolFiles(includeStaging = false): string[] {
  const root = poolRoot(), roots = [root];
  checkDirectories(path.join(root, '_'));
  if (!fs.existsSync(root)) return [];
  if (includeStaging) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.import-') && entry.isDirectory()) roots.push(path.join(root, entry.name));
    }
  }
  const files: string[] = [];
  for (const base of roots) {
    for (const [agent, name] of Object.entries(credentialNames)) {
      const directory = path.join(base, agent);
      if (!fs.existsSync(directory)) continue;
      checkDirectories(path.join(directory, '_'));
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('账号目录不能是符号链接');
        if (!entry.isDirectory()) continue;
        const file = path.join(directory, entry.name, name);
        checkDirectories(file);
        if (regularFile(file)) files.push(file);
      }
    }
  }
  return files;
}

function sealed(bytes: Buffer): boolean { return bytes.subarray(0, PREFIX.length).equals(PREFIX); }

function loadKey(create: boolean, fresh = false): Buffer {
  const root = poolRoot(), cached = readKeys.get(root);
  if (cached && !fresh) return cached;
  let key = keyProvider.read();
  if (key) {
    if (key.length !== 32) throw new Error('账号池密钥无效，已保留原凭据');
    if (cached && !key.equals(cached)) throw new Error('系统账号池密钥已变化，已停止写入；请先导出仍可读取的账号并恢复原密钥');
    return key;
  }
  if (cached || !create || poolFiles(true).some(file => sealed(regularFile(file)!))) {
    throw new Error(cached
      ? '账号池密钥不存在，已停止写入；当前会话仍可导出已解锁账号，请先导出备份并恢复密钥'
      : '账号池密钥不存在，无法读取已有加密凭据；请恢复系统密钥或导入备份，原文件已保留');
  }
  const lock = path.join(root, '.vault-key.lock');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  checkDirectories(path.join(root, '_'));
  const previousLock = regularFile(lock);
  if (previousLock) {
    const pid = Number(previousLock.toString());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH' && regularFile(lock)?.equals(previousLock)) fs.rmSync(lock);
      }
    }
  }
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('账号池密钥正在初始化，请稍后重试；无法确认锁归属时不会覆盖它'); }
  try {
    key = keyProvider.read();
    if (!key) {
      const proposed = randomBytes(32);
      keyProvider.create(proposed);
      key = keyProvider.read();
      if (!key?.equals(proposed)) throw new Error('账号池密钥保存后校验失败，原凭据未修改');
    }
    if (key.length !== 32) throw new Error('账号池密钥无效，已保留原凭据');
    return key;
  } finally { fs.rmSync(lock, { force: true }); }
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

export function decodeCredentialFile(file: string, bytes: Buffer, freshKey = false): Buffer {
  const kind = managedCredentialKind(file);
  if (!kind) return bytes;
  if (sealed(bytes)) {
    const key = loadKey(false, freshKey), plaintext = decrypt(bytes, kind, key);
    if (!readKeys.has(poolRoot())) readKeys.set(poolRoot(), Buffer.from(key));
    return plaintext;
  }
  try { JSON.parse(bytes.toString()); }
  catch { throw new Error('账号池凭据格式异常，原文件已保留；请检查文件或从备份恢复'); }
  return bytes;
}

function writeKey(file: string, kind: string): Buffer {
  const key = loadKey(true, true), previous = regularFile(file);
  // A replaced/lost key or damaged envelope must not destroy the previous generation.
  if (previous) {
    if (sealed(previous)) decrypt(previous, kind, key);
    else decodeCredentialFile(file, previous);
  }
  return key;
}

/** Check before an operation can rotate tokens; a cached read key cannot authorize renewal. */
export function assertCredentialWriteReady(file: string): void {
  const kind = managedCredentialKind(file);
  if (kind) writeKey(file, kind);
}

export function encodeCredentialFile(file: string, bytes: Buffer): Buffer {
  const kind = managedCredentialKind(file);
  if (!kind) return bytes;
  const key = writeKey(file, kind);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(kind)]));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function verifyCredentialWrite(file: string, written: Buffer, original: Buffer): void {
  if (managedCredentialKind(file) && !decodeCredentialFile(file, written, true).equals(original)) throw new Error('加密凭据写入后校验失败，原文件已保留');
}

/** Caller holds the account-store lock. Each original survives until the encrypted disk copy has been verified. */
export function migrateCredentialPool(): { migrated: number } {
  let migrated = 0;
  for (const file of poolFiles()) {
    const original = regularFile(file)!;
    if (sealed(original)) { decodeCredentialFile(file, original, true); continue; }
    decodeCredentialFile(file, original);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, encodeCredentialFile(file, original), { flag: 'wx', mode: 0o600 });
      verifyCredentialWrite(file, regularFile(temp)!, original);
      if (!regularFile(file)?.equals(original)) throw new Error('迁移期间凭据发生变化，已保留现有文件，请重试');
      fs.renameSync(temp, file);
      migrated++;
    } finally { fs.rmSync(temp, { force: true }); }
  }
  return { migrated };
}
