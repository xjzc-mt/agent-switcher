import { importPool } from './import-pool';
import fs from 'fs';
import path from 'path';
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'crypto';
import { buffer } from 'stream/consumers';
import { promisify, isDeepStrictEqual } from 'util';
import { ZipFile } from 'yazl';
import unzipper from 'unzipper';
import { isSameIdentity, resolveAgent, credentialUpdateTarget, availableCredentialUpdateTarget, replaceAccountCredentialsLocked, updateAccountCredentials, CredentialUpdateTarget, withProfileCredentialLocks, preparedProfileCredentials } from './accounts';
import type { BaseAgent, Identity } from './agents/base';
import { STORE_DIR, profileDir, profileExists, profileNameKey, readProfileMeta, validateName, validatePoolName } from './store';
import { atomicWrite, ensureDir } from './utils';
import { createTemporaryCredentials, removeTemporaryCredentials } from './temporary-credentials';
import { parseCredentialDocument, type CredentialEntry } from './credential-document';
import { parseCredentialJson } from './credential-json';
import { createImportCredentialWriter } from './credential-vault';
const derive = promisify(scrypt);
const MAGIC_V1 = Buffer.from('AGS1');
const MAGIC_V2 = Buffer.from('AGS2');
const KDF_PROFILE = Buffer.from([1, 16, 8, 1]);
const MAX_BACKUP = 32 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_ENTRIES = 10000;
export type BackupItem = { agent: string; profile: string };
export interface ImportResult {
  imported: string[];
  updated?: string[];
  skipped: Array<{ key: string; existing: string }>;
}

function unsealAgs(aad: Buffer, iv: Buffer, tag: Buffer, body: Buffer, key: Buffer): Buffer {
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]);
}

export async function encryptBackup(zip: Buffer, password: string): Promise<Buffer> {
  if (typeof password !== 'string' || password.length < 6 || !password.trim()) throw new Error('备份密码至少需要 6 个字符');
  const salt = randomBytes(16), iv = randomBytes(12), header = Buffer.concat([MAGIC_V2, KDF_PROFILE]);
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (err, derived) => err ? reject(err) : resolve(derived)));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const data = Buffer.concat([cipher.update(zip), cipher.final()]);
    return Buffer.concat([header, salt, iv, cipher.getAuthTag(), data]);
  } finally { key.fill(0); }
}
export async function decryptBackup(data: Buffer, password?: string): Promise<Buffer> {
  const magic = data.subarray(0, 4);
  if (magic.equals(MAGIC_V2)) {
    if (data.length < 52) throw new Error('加密备份文件已损坏');
    const version = data[4], logN = data[5], r = data[6], p = data[7];
    if (version !== 1 || logN < 14 || logN > 17 || r !== 8 || (p !== 1 && p !== 2)) {
      throw new Error('备份文件加密版本或参数不受支持');
    }
    if (!password) throw new Error('请输入备份密码');
    const N = 1 << logN, maxmem = 256 * 1024 * 1024;
    const key = await new Promise<Buffer>((resolve, reject) =>
      scrypt(password.normalize('NFC'), data.subarray(8, 24), 32, { N, r, p, maxmem }, (err, derived) => err ? reject(err) : resolve(derived)));
    try { return unsealAgs(data.subarray(0, 8), data.subarray(24, 36), data.subarray(36, 52), data.subarray(52), key); }
    catch { throw new Error('密码不正确或备份文件已损坏'); }
    finally { key.fill(0); }
  }
  if (!magic.equals(MAGIC_V1)) return data; // Legacy plain ZIP import.
  if (data.length < 48) throw new Error('加密备份文件已损坏');
  if (!password) throw new Error('请输入备份密码');
  const candidates = [...new Set([password, password.normalize('NFC')])];
  for (const secret of candidates) {
    const key = await derive(secret, data.subarray(4, 20), 32) as Buffer;
    try { return unsealAgs(MAGIC_V1, data.subarray(20, 32), data.subarray(32, 48), data.subarray(48), key); }
    catch {} finally { key.fill(0); }
  }
  throw new Error('密码不正确或备份文件已损坏');
}
export async function exportBackup(items: BackupItem[], password: string): Promise<Buffer> {
  if (!Array.isArray(items) || !items.length) throw new Error('没有可导出的账号');
  const profiles = items.map(({ agent, profile }) => ({ agent: resolveAgent(agent), profile }));
  const files = await withProfileCredentialLocks(profiles, async () => {
    let size = 0;
    const selected = new Set<string>();
    // The official client may have changed accounts since AGS last switched.
    // All selected profiles compare with the same live observation.
    const liveCredentials = new Map<BaseAgent, { bytes: Buffer | null } | { error: unknown }>();
    const readCurrent = (agent: BaseAgent) => {
      let observed = liveCredentials.get(agent);
      if (!observed) {
        try {
          observed = { bytes: agent.readSwitchableCredentials().files[agent.authFiles[0]] };
        } catch (error) { observed = { error }; }
        liveCredentials.set(agent, observed);
      }
      if ('error' in observed) throw observed.error;
      return observed.bytes;
    };
    // Collect first, so a validation failure never leaves a live archive stream behind.
    const files: Array<{ name: string; data: Buffer }> = [];
    const collect = (name: string, data: Buffer) => {
      if (data.length > MAX_FILE) throw new Error('备份中的文件过大');
      if (files.length >= MAX_ENTRIES) throw new Error('备份文件包含过多条目');
      size += data.length;
      if (size > MAX_BACKUP) throw new Error('备份数据过大');
      files.push({ name, data });
    };
    for (const { agent, profile } of profiles) {
      const dir = profileDir(agent.id, profile);
      const stat = fs.statSync(dir, { bigint: true });
      const selectionKey = stat.ino ? `${stat.dev}:${stat.ino}` : fs.realpathSync(dir);
      if (selected.has(selectionKey)) throw new Error('重复选择了同一个导出账号');
      selected.add(selectionKey);
      const credentials = preparedProfileCredentials(agent, profile, readCurrent);
      for (const [name, data] of Object.entries(credentials)) {
        if (data) {
          collect(`${agent.id}/${profile}/${name}`, data);
          if (name === agent.authFiles[0]) parseCredentialJson(data.toString());
        }
      }
      const meta = readProfileMeta(agent.id, profile);
      const email = meta.email || agent.identity(dir, credentials)?.email;
      const metaBytes = Buffer.from(JSON.stringify({ label: meta.label, email, savedAt: meta.savedAt }));
      collect(`${agent.id}/${profile}/_meta.json`, metaBytes);
    }
    return files;
  });
  const archive = new ZipFile();
  for (const file of files) archive.addBuffer(file.data, file.name, { compressionLevel: 9 });
  archive.end();
  const encrypted = await encryptBackup(await buffer(archive.outputStream), password);
  if (encrypted.length > MAX_BACKUP) throw new Error('备份文件过大');
  return encrypted;
}

export interface ParsedBackup {
  groups: Map<string, Map<string, Buffer>>;
  items: Array<BackupItem & { key: string; email?: string }>;
  identities: Map<string, Identity>;
  skippedProfiles?: number;
}
export const isEncryptedBackup = (data: Buffer) => data.subarray(0, 4).equals(MAGIC_V1) || data.subarray(0, 4).equals(MAGIC_V2);

/** Native client credentials only; browser cookies are not interchangeable with CLI OAuth. */
export async function parseCredentials(data: Buffer, agentId?: string, name?: string): Promise<ParsedBackup> {
  if (data.length > MAX_FILE) throw new Error('凭据文件过大');
  const doc = parseCredentialDocument(data, agentId);
  if (doc.collection || doc.entries.length !== 1) throw new Error('请选择单个账号的客户端凭据 JSON');
  const parsed = emptyCredentialBackup();
  appendCredentialEntry(parsed, doc.entries[0], { name, original: data });
  return parsed;
}

export function emptyCredentialBackup(): ParsedBackup {
  return { groups: new Map(), items: [], identities: new Map() };
}

/** The document parser has already validated field names, aliases and per-account limits. */
export function appendCredentialEntry(parsed: ParsedBackup, entry: CredentialEntry, options: { name?: string; original?: Buffer; key?: string }) {
  const { name, original } = options;
  if (entry.error || !entry.data || !entry.agent) throw new Error(entry.error || '请提供完整的客户端凭据 JSON；单段 Session / Cookie 暂不支持');
  const normalized = JSON.parse(entry.data.toString());
  let direct: unknown;
  if (original) {
    try { direct = JSON.parse(original.toString()); } catch { /* Wrapped or nonstandard input uses the normalized bytes. */ }
  }
  const stored = original && isDeepStrictEqual(direct, normalized) ? original : entry.data;
  const agent = resolveAgent(entry.agent);
  const identity = agent.identityFromAuth(normalized);
  if (!identity) throw new Error(`${agent.label} 没有可用的认证凭据`);
  const profile = name?.trim() || entry.name || identity.email?.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70) || `${agent.id}-import-${Date.now()}`;
  // This key stays in memory. New destinations are checked by installBackup; updates keep their existing name.
  validateName(profile, false);
  const key = `${agent.id}/${options.key ?? profile}`;
  const files = new Map([[agent.authFiles[0], stored], ['_meta.json', Buffer.from(JSON.stringify({email:identity.email,savedAt:new Date().toISOString()}))]]);
  const item = { key, agent: agent.id, profile, email: identity.email };
  parsed.groups.set(key, files);
  parsed.identities.set(key, identity);
  parsed.items.push(item);
  return item;
}

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Bound central-directory entry count and declared sizes before unzipper allocates entry objects. */
function validateZipBuffer(zip: Buffer): number {
  if (zip.length < 22) throw new Error('备份文件已损坏');
  if (zip.readUInt32LE(0) === 0x34327243) throw new Error('备份文件格式无效或已损坏');
  let eocd = -1;
  const minOffset = Math.max(0, zip.length - 65557);
  for (let i = zip.length - 22; i >= minOffset; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || zip.subarray(eocd + 22).includes(EOCD_SIGNATURE)) {
    throw new Error('备份文件格式无效或已损坏');
  }
  const diskNumber = zip.readUInt16LE(eocd + 4);
  const diskStart = zip.readUInt16LE(eocd + 6);
  const diskEntries = zip.readUInt16LE(eocd + 8);
  const totalEntries = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || diskStart !== 0 || diskEntries !== totalEntries ||
      diskEntries === 0xffff || totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff ||
      (eocd >= 20 && zip.readUInt32LE(eocd - 20) === 0x07064b50)) {
    throw new Error('备份文件不支持分卷或 ZIP64 归档');
  }
  if (totalEntries > MAX_ENTRIES) throw new Error('备份文件包含过多条目');
  if (cdOffset > eocd || cdSize > eocd - cdOffset) throw new Error('备份文件目录表已损坏');
  let cursor = cdOffset, count = 0, declaredTotal = 0;
  while (cursor < cdOffset + cdSize) {
    if (++count > MAX_ENTRIES) throw new Error('备份文件包含过多条目');
    if (cursor + 46 > cdOffset + cdSize || zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('备份文件目录表已损坏');
    }
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const entryDisk = zip.readUInt16LE(cursor + 34);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLen + extraLen + commentLen;
    if (nextCursor > cdOffset + cdSize) throw new Error('备份文件目录表已损坏');
    if (entryDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('备份文件不支持分卷或 ZIP64 归档');
    }
    let extraCursor = cursor + 46 + nameLen;
    const extraEnd = extraCursor + extraLen;
    while (extraCursor < extraEnd) {
      if (extraCursor + 4 > extraEnd) throw new Error('备份文件目录表已损坏');
      const headerId = zip.readUInt16LE(extraCursor);
      const partSize = zip.readUInt16LE(extraCursor + 2);
      if (headerId === 0x0001) throw new Error('备份文件不支持分卷或 ZIP64 归档');
      if (extraCursor + 4 + partSize > extraEnd) throw new Error('备份文件目录表已损坏');
      extraCursor += 4 + partSize;
    }
    if (localOffset + 30 > cdOffset || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('备份文件目录表已损坏');
    }
    if (uncompressedSize > MAX_FILE) throw new Error('备份中的文件过大');
    if (compressedSize > MAX_BACKUP) throw new Error('备份文件过大');
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_BACKUP) throw new Error('备份解压后过大');
    cursor = nextCursor;
  }
  if (cursor !== cdOffset + cdSize || count !== totalEntries) throw new Error('备份文件目录表已损坏');
  return zip.length - eocd;
}

export async function parseBackup(data: Buffer, password?: string): Promise<ParsedBackup> {
  if (data.length > MAX_BACKUP) throw new Error('备份文件过大');
  const plainZip = await decryptBackup(data, password);
  const tailSize = validateZipBuffer(plainZip);
  const openZip = unzipper.Open as unknown as { buffer(b: Buffer, opts?: { tailSize?: number }): ReturnType<typeof unzipper.Open.buffer> };
  const zip = await openZip.buffer(plainZip, { tailSize });
  if (zip.files.length > MAX_ENTRIES) throw new Error('备份文件包含过多条目');
  const groups = new Map<string, Map<string, Buffer>>();
  const skippedProfiles = new Set<string>();
  const legacyConfig = ['config.toml', 'settings.json', 'settings.local.json'];
  let size = 0;
  for (const entry of zip.files) {
    if (entry.type === 'Directory') continue;
    const parts = entry.path.split('/');
    if (parts.length !== 3) throw new Error('备份中存在非法路径');
    const [id, name, file] = parts;
    // Archive keys are inspected in memory. Legacy names can be corrected in the preview.
    validateName(name, false);
    const mode = entry.externalFileAttributes >>> 16;
    if ((mode & 0o170000) === 0o120000) throw new Error('备份不能包含符号链接');
    // Skip archived accounts of the retired provider without opening their credential streams.
    if (id === 'claude') {
      if (file !== '.credentials.json' && file !== '_meta.json' && !legacyConfig.includes(file)) throw new Error('备份包含不支持的文件');
      skippedProfiles.add(name);
      continue;
    }
    const agent = resolveAgent(id);
    // Old configuration snapshots are intentionally not restored into working environments.
    if (!agent.authFiles.includes(file) && file !== '_meta.json' && !legacyConfig.includes(file)) throw new Error('备份包含不支持的文件');
    if (entry.uncompressedSize > MAX_FILE) throw new Error('备份中的文件过大');
    const chunks: Buffer[] = [];
    let fileSize = 0;
    for await (const chunk of entry.stream()) {
      fileSize += chunk.length; size += chunk.length;
      if (fileSize > MAX_FILE || size > MAX_BACKUP) throw new Error('备份解压后过大');
      chunks.push(chunk);
    }
    if (legacyConfig.includes(file)) continue;
    const key = `${id}/${name}`;
    const files = groups.get(key) || new Map<string, Buffer>();
    if (files.has(file)) throw new Error('备份包含重复文件');
    files.set(file, Buffer.concat(chunks)); groups.set(key, files);
  }
  if (!groups.size) throw new Error(skippedProfiles.size ? '备份中没有受支持的平台账号' : '备份中没有账号');
  const items: ParsedBackup['items'] = [];
  const identities = new Map<string, Identity>();
  for (const [key, files] of groups) {
    const [id, name] = key.split('/');
    const metadata = files.get('_meta.json');
    if (metadata) {
      const old = JSON.parse(metadata.toString());
      const meta: Record<string, string> = {};
      for (const field of ['label', 'email', 'savedAt']) if (typeof old?.[field] === 'string') meta[field] = old[field].slice(0, 200);
      files.set('_meta.json', Buffer.from(JSON.stringify(meta)));
    }
    const agent = resolveAgent(id);
    const authBytes = files.get(agent.authFiles[0]) || null;
    if (authBytes) parseCredentialJson(authBytes.toString());
    const identity = agent.identityFromBytes(authBytes);
    if (!identity) throw new Error(`${agent.label} 没有可用的认证凭据`);
    identities.set(key, identity);
    items.push({ key, agent: id, profile: name, email: identity.email });
  }
  return { groups, items, identities, skippedProfiles: skippedProfiles.size };
}

export async function installBackup(parsed: ParsedBackup, keys: string[], names?: ReadonlyMap<string, string>, updates?: ReadonlyMap<string, CredentialUpdateTarget>): Promise<ImportResult> {
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length || keys.some(key => !parsed.groups.has(key))) throw new Error('请选择有效的导入账号');
  if (names && (names.size !== keys.length || keys.some(key => !names.has(key)))) throw new Error('请为所选账号填写名称');
  const destinationNames = names ?? new Map(parsed.items.map(item => [item.key, item.profile]));
  const destinations = new Set<string>();
  for (const key of keys) {
    const name = destinationNames.get(key)!;
    const update = updates?.get(key);
    validatePoolName(name, update?.profile === name);
    if (names) {
      const destination = `${key.split('/')[0]}/${profileNameKey(name)}`;
      if (destinations.has(destination)) throw new Error(`账号名称「${name}」重复，请修改后导入`);
      destinations.add(destination);
    }
  }
  const entries = keys.map(key => {
    const agent = resolveAgent(key.split('/')[0]), files = parsed.groups.get(key)!;
    const id = agent.identityFromBytes(files.get(agent.authFiles[0]) ?? null)?.id;
    if (!id) throw new Error(`${agent.label} 没有可用的认证凭据`);
    return { key, agent, files, id };
  });
  return withProfileCredentialLocks([], async lockedIds => {
    ensureDir(STORE_DIR);
    const staging = createTemporaryCredentials('import', { store: true });
    const installed: string[] = [];
    const updated: string[] = [];
    const rollbackUpdates: Array<() => void> = [];
    const skipped: ImportResult['skipped'] = [];
    const pool = importPool();
    let writer: Awaited<ReturnType<typeof createImportCredentialWriter>> | undefined;
    try {
      writer = await createImportCredentialWriter(staging);
      for (const [index, { agent, files }] of entries.entries()) {
        for (const [file, bytes] of files) atomicWrite(path.join(staging, agent.id, String(index), file), bytes, writer);
      }
      await writer.verifySystemKey();
      for (const [index, { key, agent }] of entries.entries()) {
        const { id } = agent, original = destinationNames.get(key)!;
        const source = path.join(staging, id, String(index));
        const files = agent.readCredentials(source);
        const identity = agent.identity(source, files);
        if (!identity) throw new Error(`${agent.label} 没有可用的认证凭据`);
        if (!lockedIds.has(identity.id)) throw new Error('待导入账号身份已变化，请重新解析凭据');
        const expected = updates?.get(key);
        if (expected && (expected.agent !== id || !isSameIdentity(agent.identity(profileDir(id, expected.profile)), expected.identity))) {
          throw new Error('待更新账号已变化，请重新解析凭据');
        }
        const { byIdentity, byProfile, names: taken } = pool(agent);
        const duplicate = expected ? byProfile.get(expected.profile) : byIdentity.get(identity.id);
        if (duplicate) {
          const profile = duplicate.profile;
          const target = (!updates || expected) && availableCredentialUpdateTarget(agent, profile);
          if (target) {
            const importWriter = writer.forReplacement(profileDir(id, profile));
            const replacement = await replaceAccountCredentialsLocked(expected || target, files, { importWriter });
            if (replacement.rollback) rollbackUpdates.push(replacement.rollback);
            updated.push(`${id}/${replacement.result.profile}`);
          } else skipped.push({ key, existing: duplicate.key });
          continue;
        }
        if (names && (taken.has(profileNameKey(original)) || profileExists(id, original))) throw new Error(`账号名称「${original}」已被使用，请修改后导入`);
        let name = original, suffix = 1;
        while (taken.has(profileNameKey(name)) || profileExists(id, name)) name = `${original.slice(0, 80)}-import-${suffix++}`;
        const dest = profileDir(id, name);
        ensureDir(path.dirname(dest));
        fs.renameSync(source, dest);
        taken.add(profileNameKey(name));
        installed.push(`${id}/${name}`);
        // Include earlier imports in this batch, not only the initial pool.
        const entry = { key: `${id}/${name}`, profile: name, source: 'batch' as const };
        byIdentity.set(identity.id, entry);
        byProfile.set(name, entry);
      }
      // A key can be revoked during installation too. Roll back while the store lock is held.
      await writer.verifySystemKey();
      return { imported: installed, ...(updated.length ? { updated } : {}), skipped };
    } catch (error) {
      for (const key of installed) { const [id, name] = key.split('/'); fs.rmSync(profileDir(id, name), { recursive: true, force: true }); }
      for (const rollback of rollbackUpdates.reverse()) rollback();
      throw error;
    } finally {
      writer?.close();
      removeTemporaryCredentials(staging);
    }
  }, entries.map(entry => entry.id));
}

export async function previewCredentialUpdate(data: Buffer, id: string, name: string) {
  const parsed = await parseCredentials(data, id, name);
  const agent = resolveAgent(id), target = credentialUpdateTarget(agent, name);
  const stored = parsed.groups.get(parsed.items[0].key)?.get(agent.authFiles[0]) || null;
  const identity = agent.identityFromBytes(stored);
  if (!identity) throw new Error(`${agent.label} 没有可用的认证凭据`);
  if (!isSameIdentity(target.identity, identity)) throw new Error('凭据不属于此账号或工作区，未进行更新');
  return { parsed, target };
}

export async function installCredentialUpdate(parsed: ParsedBackup, target: CredentialUpdateTarget) {
  if (parsed.items.length !== 1 || parsed.items[0].agent !== target.agent) throw new Error('凭据平台不匹配');
  const files = parsed.groups.get(parsed.items[0].key);
  if (!files) throw new Error('请重新选择凭据');
  const input = Object.fromEntries(resolveAgent(target.agent).authFiles.map(name => [name, files.get(name) ?? null]));
  return updateAccountCredentials(target, input);
}
