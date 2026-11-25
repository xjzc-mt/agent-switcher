import { importPool } from './import-pool';
import path from 'path';
import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import { resolveAgent, availableCredentialUpdateTarget, CredentialUpdateTarget } from './accounts';
import { ParsedBackup, emptyCredentialBackup, appendCredentialEntry, installBackup, ImportResult } from './backup';
import { profileNameError, profileNameKey } from './store';
import { parseCredentialDocument } from './credential-document';

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
export interface CredentialImportItem {
  key: string;
  agent?: string;
  profile: string;
  email?: string;
  fileName?: string;
  sourceIndex?: number;
  state: 'ready' | 'update' | 'duplicate' | 'error';
  duplicate?: { key: string; profile: string; source: 'pool' | 'batch' };
  error?: string;
}
export interface CredentialBatch {
  parsed: ParsedBackup;
  items: CredentialImportItem[];
  updates: Map<string, CredentialUpdateTarget>;
}
function defaultName(fileName: string | undefined, email: string | undefined, agent: string): string {
  const stem = fileName?.replace(/\.(?:json|jsonl|ndjson|jsonc)$/i, '').replace(/^\./, '').trim();
  const generic = /^(?:auth|credentials?|session|oauth|tokens?|jetski-standalone-oauth-token)(?:[-_ ]*\d+|\s*\(\d+\)|[-_ ]copy|[-_ ]副本)?$/i;
  const raw = stem && !generic.test(stem) ? stem : email?.split('@')[0] || `${agent}-账号`;
  const name = raw.replace(/[\\/\x00-\x1f\x7f]/g, '-').replace(/\.{2,}/g, '-').trim().slice(0, 80).trim();
  return !name || name === '.' ? `${agent}-账号` : name;
}

/** Only identity metadata is exposed to the renderer. Credential bytes stay in the main process. */
function classify(batch: CredentialBatch): void {
  const pool = importPool();
  const parsedItems = new Map(batch.parsed.items.map(item => [item.key, item]));
  for (const item of batch.items) {
    if (item.state === 'error' || !item.agent) continue;
    const agent = resolveAgent(item.agent);
    const { names: used, byIdentity } = pool(agent);
    const identity = batch.parsed.identities.get(item.key)!;
    const duplicate = byIdentity.get(identity.id);
    const update = duplicate?.source === 'pool' ? availableCredentialUpdateTarget(agent, duplicate.profile) : undefined;
    item.state = update ? 'update' : duplicate ? 'duplicate' : 'ready';
    item.duplicate = duplicate && !update ? { key: duplicate.key, profile: duplicate.profile, source: duplicate.source } : undefined;
    if (update) {
      item.profile = update.profile;
      batch.updates.set(item.key, update);
    } else if (!duplicate) {
      const original = item.profile;
      let suffix = 2;
      while (used.has(profileNameKey(item.profile))) item.profile = `${original.slice(0, 80)} (${suffix++})`;
      used.add(profileNameKey(item.profile));
      parsedItems.get(item.key)!.profile = item.profile;
    }
    if (update || !duplicate) byIdentity.set(identity.id, { key: item.key, profile: item.profile, source: 'batch' });
  }
}

type CredentialDocument = ReturnType<typeof parseCredentialDocument>;

/** Older backups with nonportable names use the existing editable import preview. */
export function editableBackup(parsed: ParsedBackup): CredentialBatch | undefined {
  if (!parsed.items.some(item => profileNameError(item.profile))) return;
  const batch: CredentialBatch = { parsed, updates: new Map(), items: parsed.items.map(item => ({ ...item, state: 'ready' })) };
  classify(batch);
  return batch;
}

async function parseForPreview(data: Buffer, agent?: string): Promise<CredentialDocument> {
  if (data.length < 256 * 1024) return parseCredentialDocument(data, agent);
  const worker = new Worker(path.join(__dirname, 'credential-worker.js'), { workerData: { data, agent } });
  const document = await new Promise<CredentialDocument>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', () => reject(new Error('凭据解析中断，请重试')));
  });
  for (const entry of document.entries) {
    if (entry.data) entry.data = Buffer.from(entry.data);
  }
  return document;
}

/** Each preview is one pasted document or one file; a document may contain many accounts. */
export async function parseCredentialBatch(data: Buffer, agent?: string, fileName?: string): Promise<CredentialBatch> {
  if (agent) resolveAgent(agent);
  if (data.length > MAX_DOCUMENT_BYTES) throw new Error('凭据文件超过 32 MB');
  const document = await parseForPreview(data, agent);
  const batch: CredentialBatch = {
    items: [], updates: new Map(),
    parsed: emptyCredentialBackup(),
  };
  for (const [index, entry] of document.entries.entries()) {
    const sourceIndex = document.collection ? index + 1 : undefined;
    try {
      const item = appendCredentialEntry(batch.parsed, entry, { key: randomUUID() });
      // A bundle filename is not an account name. Prefer per-account metadata or identity.
      item.profile = entry.name || defaultName(document.collection ? undefined : fileName, item.email, item.agent);
      batch.items.push({ ...item, fileName, sourceIndex, state: 'ready' });
    } catch (error) {
      batch.items.push({ key: randomUUID(), profile: '', fileName, sourceIndex, state: 'error', error: (error as Error).message });
    }
  }
  classify(batch);
  return batch;
}

export async function installCredentialBatch(batch: CredentialBatch, keys: string[], names: Record<string, string>): Promise<ImportResult & { failed: Array<{ fileName?: string; sourceIndex?: number; error: string }> }> {
  if (!Array.isArray(keys) || new Set(keys).size !== keys.length || keys.some(key => !batch.items.some(item => item.key === key && ['ready', 'update'].includes(item.state)))) throw new Error('请选择有效的导入账号');
  if (!names || typeof names !== 'object' || Array.isArray(names) || Object.keys(names).length !== keys.length || keys.some(key => !Object.hasOwn(names, key))) throw new Error('请为所选账号填写名称');
  const renamed = new Map<string, string>();
  for (const key of keys) {
    if (batch.updates.has(key) && names[key] !== batch.updates.get(key)!.profile) throw new Error('更新凭据会保留原账号名称');
    renamed.set(key, names[key]);
  }
  const result = keys.length ? await installBackup(batch.parsed, keys, renamed, batch.updates) : { imported: [], skipped: [] };
  return {
    ...result,
    skipped: [...batch.items.filter(item => item.state === 'duplicate').map(item => ({ key: item.key, existing: item.duplicate!.key })), ...result.skipped],
    failed: batch.items.filter(item => item.state === 'error').map(item => ({ fileName: item.fileName, sourceIndex: item.sourceIndex, error: item.error! })),
  };
}
