import fs from 'fs';
import path from 'path';
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'crypto';
import { buffer } from 'stream/consumers';
import { promisify } from 'util';
import { ZipFile } from 'yazl';
import unzipper from 'unzipper';
import { isSameIdentity, resolveAgent, credentialUpdateTarget, availableCredentialUpdateTarget, replaceAccountCredentialsLocked, updateAccountCredentials, CredentialUpdateTarget } from './accounts';
import type { Identity } from './agents/base';
import { STORE_DIR, listProfiles, profileDir, profileExists, readProfileMeta, withStoreLock, validateName } from './store';
import { atomicWrite, ensureDir } from './utils';
import { createTemporaryCredentials, removeTemporaryCredentials } from './temporary-credentials';
const derive = promisify(scrypt);
const MAGIC = Buffer.from('AGS1');
const MAX_BACKUP = 32 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
export type BackupItem = { agent: string; profile: string };
export interface ImportResult {
  imported: string[];
  updated?: string[];
  skipped: Array<{ key: string; existing: string }>;
}

export async function encryptBackup(zip: Buffer, password: string): Promise<Buffer> {
  if (typeof password !== 'string' || password.length < 8) throw new Error('备份密码至少需要 8 个字符');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await derive(password, salt, 32) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const data = Buffer.concat([cipher.update(zip), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), data]);
}
export async function decryptBackup(data: Buffer, password?: string): Promise<Buffer> {
  if (!data.subarray(0, 4).equals(MAGIC)) return data; // Legacy ZIP import.
  if (data.length < 48) throw new Error('加密备份文件已损坏');
  if (!password) throw new Error('请输入备份密码');
  try {
    const key = await derive(password, data.subarray(4, 20), 32) as Buffer;
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(20, 32));
    cipher.setAAD(MAGIC); cipher.setAuthTag(data.subarray(32, 48));
    return Buffer.concat([cipher.update(data.subarray(48)), cipher.final()]);
  } catch { throw new Error('密码不正确或备份文件已损坏'); }
}
export async function exportBackup(items: BackupItem[], password: string): Promise<Buffer> {
  const files = await withStoreLock(async () => {
    if (!Array.isArray(items) || !items.length) throw new Error('没有可导出的账号');
    let size = 0;
    // Collect first, so a validation failure never leaves a live archive stream behind.
    const files: Array<{ name: string; data: Buffer }> = [];
    for (const item of items) {
      const agent = resolveAgent(item.agent);
      const dir = profileDir(agent.id, item.profile);
      for (const [name, data] of Object.entries(agent.credentials(dir))) {
        if (data) { size += data.length; files.push({ name: `${agent.id}/${item.profile}/${name}`, data }); }
      }
      const meta = readProfileMeta(agent.id, item.profile);
      files.push({ name: `${agent.id}/${item.profile}/_meta.json`, data: Buffer.from(JSON.stringify({ label: meta.label, email: meta.email, savedAt: meta.savedAt })) });
    }
    if (size > MAX_BACKUP) throw new Error('备份数据过大');
    return files;
  });
  const archive = new ZipFile();
  for (const file of files) archive.addBuffer(file.data, file.name, { compressionLevel: 9 });
  archive.end();
  return encryptBackup(await buffer(archive.outputStream), password);
}

export interface ParsedBackup {
  groups: Map<string, Map<string, Buffer>>;
  items: Array<BackupItem & { key: string; email?: string }>;
  identities?: Map<string, Identity>;
}
export const isEncryptedBackup = (data: Buffer) => data.subarray(0, 4).equals(MAGIC);

/** Native client credentials only; browser cookies are not interchangeable with CLI OAuth. */
export async function parseCredentials(data: Buffer, agentId?: string, name?: string): Promise<ParsedBackup> {
  if (data.length > MAX_FILE) throw new Error('凭据文件过大');
  let raw: any;
  try { raw = JSON.parse(data.toString()); }
  catch { throw new Error('请提供完整的客户端凭据 JSON；单段 Session / Cookie 暂不支持'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请提供完整的客户端凭据 JSON');
  const detected = raw.OPENAI_API_KEY || raw.tokens ? 'codex' : raw.claudeAiOauth ? 'claude' : raw.token || raw.refresh_token ? 'agy' : undefined;
  if (!detected || (agentId && agentId !== detected)) throw new Error('无法识别该平台的客户端凭据；浏览器 Session / Cookie 不能直接作为 Agent 登录凭据');
  const agent = resolveAgent(detected);
  const identity = agent.identityFromAuth(raw);
  if (!identity) throw new Error(`${agent.label} 没有可用的认证凭据`);
  const profile = name?.trim() || identity.email?.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70) || `${agent.id}-import-${Date.now()}`;
  validateName(profile);
  const key = `${agent.id}/${profile}`;
  const files = new Map([[agent.authFiles[0], data], ['_meta.json', Buffer.from(JSON.stringify({email:identity.email,savedAt:new Date().toISOString()}))]]);
  return { groups: new Map([[key, files]]), items: [{key,agent:agent.id,profile,email:identity.email}], identities: new Map([[key, identity]]) };
}

export async function parseImport(data: Buffer): Promise<ParsedBackup> {
  return data.subarray(0, 2).toString() === 'PK' ? parseBackup(data) : parseCredentials(data);
}

export async function parseBackup(data: Buffer, password?: string): Promise<ParsedBackup> {
  if (data.length > MAX_BACKUP) throw new Error('备份文件过大');
  const zip = await unzipper.Open.buffer(await decryptBackup(data, password));
  const groups = new Map<string, Map<string, Buffer>>();
  let size = 0;
  for (const entry of zip.files) {
    if (entry.type === 'Directory') continue;
    const parts = entry.path.split('/');
    if (parts.length !== 3) throw new Error('备份中存在非法路径');
    const [id, name, file] = parts;
    const agent = resolveAgent(id);
    validateName(name);
    const mode = entry.externalFileAttributes >>> 16;
    if ((mode & 0o170000) === 0o120000) throw new Error('备份不能包含符号链接');
    // Old configuration snapshots are intentionally not restored into working environments.
    const legacyConfig = ['config.toml', 'settings.json', 'settings.local.json'];
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
  if (!groups.size) throw new Error('备份中没有账号');
  const items: ParsedBackup['items'] = [];
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
    const identity = agent.identityFromBytes(files.get(agent.authFiles[0]) || null);
    if (!identity) throw new Error(`${agent.label} 没有可用的认证凭据`);
    items.push({ key, agent: id, profile: name, email: identity.email });
  }
  return { groups, items };
}

export async function installBackup(parsed: ParsedBackup, keys: string[], names?: ReadonlyMap<string, string>, updates?: ReadonlyMap<string, CredentialUpdateTarget>): Promise<ImportResult> {
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length || keys.some(key => !parsed.groups.has(key))) throw new Error('请选择有效的导入账号');
  if (names) {
    if (names.size !== keys.length || keys.some(key => !names.has(key))) throw new Error('请为所选账号填写名称');
    const destinations = new Set<string>();
    for (const key of keys) {
      const name = names.get(key)!;
      validateName(name);
      const destination = `${key.split('/')[0]}/${name}`;
      if (destinations.has(destination)) throw new Error(`账号名称「${name}」重复，请修改后导入`);
      destinations.add(destination);
    }
  }
  const groups = new Map(keys.map(key => [key, parsed.groups.get(key)!]));
  return withStoreLock(async () => {
    ensureDir(STORE_DIR);
    const staging = createTemporaryCredentials('import', { store: true });
    const installed: string[] = [];
    const updated: string[] = [];
    const rollbackUpdates: Array<() => void> = [];
    const skipped: ImportResult['skipped'] = [];
    const identities = new Map<string, Array<{ key: string; identity: Identity }>>();
    try {
      for (const [key, files] of groups) {
        for (const [file, bytes] of files) {
          atomicWrite(path.join(staging, key, file), bytes);
        }
      }
      for (const key of groups.keys()) {
        const id = key.split('/')[0];
        const original = names?.get(key) || parsed.items.find(item => item.key === key)?.profile || key.split('/')[1];
        const agent = resolveAgent(id);
        const source = path.join(staging, key);
        agent.credentials(source);
        const identity = agent.identity(source)!;
        const expected = updates?.get(key);
        if (expected && (expected.agent !== id || !isSameIdentity(agent.identity(profileDir(id, expected.profile)), expected.identity))) {
          throw new Error('待更新账号已变化，请重新解析凭据');
        }
        if (!identities.has(id)) {
          const saved = listProfiles(id).flatMap(name => {
            const identity = agent.identity(profileDir(id, name));
            return identity ? [{ key: `${id}/${name}`, identity }] : [];
          });
          identities.set(id, saved);
        }
        const saved = identities.get(id)!;
        const duplicate = expected
          ? saved.find(item => item.key === `${id}/${expected.profile}`)
          : saved.find(item => isSameIdentity(item.identity, identity));
        if (duplicate) {
          const profile = duplicate.key.slice(id.length + 1);
          const target = availableCredentialUpdateTarget(agent, profile);
          if (target) {
            const replacement = replaceAccountCredentialsLocked(expected || target, source);
            rollbackUpdates.push(replacement.rollback);
            updated.push(`${id}/${replacement.result.profile}`);
          } else skipped.push({ key, existing: duplicate.key });
          continue;
        }
        if (names && profileExists(id, original)) throw new Error(`账号名称「${original}」已被使用，请修改后导入`);
        let name = original, suffix = 1;
        while (profileExists(id, name)) name = `${original.slice(0, 80)}-import-${suffix++}`;
        const dest = profileDir(id, name);
        ensureDir(path.dirname(dest));
        fs.renameSync(source, dest);
        installed.push(`${id}/${name}`);
        // Include earlier imports in this batch, not only the initial pool.
        saved.push({ key: `${id}/${name}`, identity });
      }
      return { imported: installed, ...(updated.length ? { updated } : {}), skipped };
    } catch (error) {
      for (const key of installed) { const [id, name] = key.split('/'); fs.rmSync(profileDir(id, name), { recursive: true, force: true }); }
      for (const rollback of rollbackUpdates.reverse()) rollback();
      throw error;
    } finally { removeTemporaryCredentials(staging); }
  });
}

async function withCredentialSource<T>(parsed: ParsedBackup, work: (source: string) => Promise<T>): Promise<T> {
  if (parsed.items.length !== 1) throw new Error('请选择单个账号的客户端凭据 JSON');
  const item = parsed.items[0], agent = resolveAgent(item.agent);
  const files = parsed.groups.get(item.key);
  if (!files) throw new Error('请重新选择凭据');
  const source = createTemporaryCredentials('update');
  try {
    for (const file of agent.authFiles) {
      const data = files.get(file);
      if (data) atomicWrite(path.join(source, file), data);
    }
    agent.credentials(source);
    return await work(source);
  } finally { removeTemporaryCredentials(source); }
}

export async function previewCredentialUpdate(data: Buffer, id: string, name: string) {
  const parsed = await parseCredentials(data, id, name);
  const agent = resolveAgent(id), target = credentialUpdateTarget(agent, name);
  const identity = agent.identityFromBytes(data);
  if (!identity) throw new Error(`${agent.label} 没有可用的认证凭据`);
  if (!isSameIdentity(target.identity, identity)) throw new Error('凭据不属于此账号或工作区，未进行更新');
  return { parsed, target };
}

export async function installCredentialUpdate(parsed: ParsedBackup, target: CredentialUpdateTarget) {
  if (parsed.items.length !== 1 || parsed.items[0].agent !== target.agent) throw new Error('凭据平台不匹配');
  return withCredentialSource(parsed, source => updateAccountCredentials(target, source));
}
