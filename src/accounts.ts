import fs from 'fs';
import path from 'path';
import { BaseAgent, StatusResult, Identity } from './agents/base';
import { CodexAgent, codexAgent } from './agents/codex';
import { claudeAgent } from './agents/claude';
import { AntigravityAgent, antigravityAgent } from './agents/antigravity';
import { listProfiles, getActiveProfile, setActiveProfile, clearActiveProfile, profileDir, profileExists, readProfileMeta, writeProfileMeta, withStoreLock, validateName } from './store';
import { replaceFiles, readBuffer, fingerprint } from './utils';
import { runningClients } from './clients';
import { logoutSupport, assertLogoutReady, clearClientCredentials } from './client-logout';
import { createTemporaryCredentials, removeTemporaryCredentials } from './temporary-credentials';
import { MIN_REFRESH_INTERVAL_MS, quotaRefreshAt } from './quota-refresh';
import { credentialState, credentialStateFromFiles, credentialOrder, snapshotForCredentials, CredentialChangedError } from './credential-state';
import { assertCredentialWriteReady } from './credential-vault';

export const ALL_AGENTS: BaseAgent[] = [codexAgent, antigravityAgent, claudeAgent];
export function resolveAgent(id: string): BaseAgent {
  const agent = ALL_AGENTS.find(a => a.id === id);
  if (!agent) throw new Error('未知平台');
  return agent;
}
const liveCache = new Map<string, { identity: string; status: StatusResult }>();
const pendingQueries = new Map<string, Promise<StatusResult>>();
const loginDirs = new Map<string, string>();
function releaseLoginDirectory(agent: BaseAgent): void {
  const dir = loginDirs.get(agent.id);
  if (!dir) return;
  // Saving has already committed. A background plugin clone may still write
  // here after app-server exits; never turn cleanup into a failed account save.
  loginDirs.delete(agent.id);
  try { removeTemporaryCredentials(dir); }
  catch {
    console.warn('独立登录临时目录清理未完成；已保存的账号不受影响');
  }
}
function creditBalance(value?: string): number | undefined {
  if (!value) return undefined;
  const amount = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(amount) ? amount : undefined;
}

export function isSameIdentity(
  a?: { id?: string; email?: string } | null,
  b?: { id?: string; email?: string } | null
): boolean {
  if (!a || !b) return false;
  // A single email may have separate personal and organization identities.
  // Never merge or synchronize credentials when their stable IDs disagree.
  if (a.id && b.id) {
    return a.id === b.id;
  }
  const emailA = a.email?.trim().toLowerCase();
  const emailB = b.email?.trim().toLowerCase();
  if (emailA && emailB) {
    return emailA === emailB;
  }
  return false;
}

export function getProfileIdentity(agent: BaseAgent, name: string): { id?: string; email?: string } | undefined {
  const dir = profileDir(agent.id, name);
  let idObj: { id: string; email?: string } | undefined;
  try { idObj = agent.identity(dir); } catch {}
  const meta = readProfileMeta(agent.id, name);
  const email = idObj?.email || meta.email;
  if (!idObj && !email) return undefined;
  return { id: idObj?.id, email };
}

export function findExistingProfile(
  agent: BaseAgent,
  identity: { id?: string; email?: string },
  excludeProfile?: string
): { name: string; email?: string } | undefined {
  for (const name of listProfiles(agent.id)) {
    if (name === excludeProfile || /^backup-\d+$/.test(name)) continue;
    const target = getProfileIdentity(agent, name);
    if (target && isSameIdentity(identity, target)) {
      return { name, email: target.email || identity.email };
    }
  }
  return undefined;
}

export function activeProfile(agent: BaseAgent): string | undefined {
  const identity = agent.identity();
  if (!identity) return undefined;
  const names = listProfiles(agent.id);
  const preferred = getActiveProfile(agent.id);
  const matching = names.filter(name => {
    const target = agent.identity(profileDir(agent.id, name));
    return target && isSameIdentity(identity, target);
  });
  return preferredMatch(matching, preferred);
}

function preferredMatch(matching: string[], preferred?: string) {
  if (preferred && matching.includes(preferred)) {
    if (!/^backup-\d+$/.test(preferred) || !matching.some(m => !/^backup-\d+$/.test(m))) {
      return preferred;
    }
  }
  const nonBackup = matching.find(m => !/^backup-\d+$/.test(m));
  return nonBackup || matching[0];
}

async function syncCurrent(agent: BaseAgent, saveUnmanaged = true): Promise<void> {
  if (!agent.identity()) return;
  const active = activeProfile(agent);
  const name = active || `backup-${Date.now()}`;
  await syncCopies(agent, agent.homeDir);
  if (!active && saveUnmanaged) await agent.save(name);
  if (!active && saveUnmanaged) writeProfileMeta(agent.id, name, { email: agent.identity()?.email, savedAt: new Date().toISOString() });
}

async function syncCopies(agent: BaseAgent, source: string, previousRevision?: string, strict = true, expectedRevision?: string): Promise<void> {
  const identity = agent.identity(source);
  if (!identity) return;
  const sourceState = credentialState(agent, source);
  if (expectedRevision && sourceState.revision !== expectedRevision) throw new CredentialChangedError();
  // With no rotation or timestamp no other generation can be proven older.
  if (!strict && sourceState.updatedAt === undefined && previousRevision === sourceState.revision) return;
  const writes: string[] = [];
  for (const name of listProfiles(agent.id)) {
    const dest = profileDir(agent.id, name);
    if (dest !== source) {
      // Email metadata alone cannot authorize a credential write.
      const target = agent.identity(dest);
      if (target?.id === identity.id) {
        const order = agent.management().quota ? credentialOrder(sourceState, credentialState(agent, dest), previousRevision) : 'newer';
        if (order === 'unknown' && strict) throw new Error(`「${name}」存在不同版本的凭据，无法确认新旧，已保留两份凭据并取消操作`);
        if (order === 'newer') writes.push(name);
      }
    }
  }
  for (const name of writes) {
    if (credentialState(agent, source).revision !== sourceState.revision) throw new CredentialChangedError();
    await agent.save(name, source);
  }
}

export async function saveAccount(agent: BaseAgent, name: string, validateLogin?: () => void): Promise<{ ok: true; files: string[]; warnings: string[]; profile?: string; updated?: boolean }> {
  return withStoreLock(async () => {
    validateLogin?.();
    validateName(name);
    const source = loginDirs.get(agent.id) || agent.homeDir;
    if (source === agent.homeDir && !agent.management().canSaveCurrent) throw new Error(agent.switchSupport() || '当前登录不支持保存为文件凭据');
    const identity = agent.identity(source);
    if (!identity) throw new Error('尚未检测到登录凭据，请完成登录后再保存');

    const existingProfile = findExistingProfile(agent, identity);
    const update = existingProfile && availableCredentialUpdateTarget(agent, existingProfile.name);
    if (update) {
      const files = Object.keys(agent.credentials(source));
      replaceAccountCredentialsLocked(update, source);
      if (source === agent.homeDir) setActiveProfile(agent.id, update.profile);
      else releaseLoginDirectory(agent);
      return { ok: true, files, warnings: [], profile: update.profile, updated: true };
    }

    const duplicate = findExistingProfile(agent, identity, name);
    if (duplicate) {
      const emailStr = identity.email ? `（${identity.email}）` : '';
      throw new Error(`该账号${emailStr}已存在于「${duplicate.name}」，无需重复添加`);
    }

    if (profileExists(agent.id, name)) {
      const existing = getProfileIdentity(agent, name);
      if (existing && !isSameIdentity(existing, identity)) {
        throw new Error('该名称已属于另一个账号，请使用新名称');
      }
      if (agent.management().quota && agent.identity(profileDir(agent.id, name))) {
        const order = credentialOrder(credentialState(agent, source), credentialState(agent, profileDir(agent.id, name)));
        if (order === 'older' || order === 'unknown') throw new Error('保存的凭据可能早于账号池中的版本，已取消覆盖');
      }
    }

    await syncCopies(agent, source);
    if (!/^backup-\d+$/.test(name)) {
      for (const p of listProfiles(agent.id)) {
        if (/^backup-\d+$/.test(p)) {
          const pIdentity = getProfileIdentity(agent, p);
          if (pIdentity && isSameIdentity(pIdentity, identity)) {
            fs.rmSync(profileDir(agent.id, p), { recursive: true, force: true });
          }
        }
      }
    }
    const result = await agent.save(name, source);
    const meta = readProfileMeta(agent.id, name);
    writeProfileMeta(agent.id, name, { ...meta, email: identity.email, savedAt: new Date().toISOString(),
      snapshot: snapshotForCredentials(meta.snapshot, credentialState(agent, source).revision) });
    liveCache.delete(agent.id);
    if (source === agent.homeDir) setActiveProfile(agent.id, name);
    else releaseLoginDirectory(agent);
    return { ...result, ok: true };
  });
}

export function needsUnmanagedChoice(agent: BaseAgent, name: string): boolean {
  return !!agent.identity() && !activeProfile(agent) && agent.identity()?.id !== agent.identity(profileDir(agent.id, name))?.id;
}

export async function useAccount(agent: BaseAgent, name: string, options: { saveUnmanaged?: boolean; expectedCurrentRevision?: string } = {}) {
  return withStoreLock(async () => {
    const unsupported = agent.switchSupport();
    if (unsupported) throw new Error(unsupported);
    const target = profileDir(agent.id, name);
    agent.credentials(target); // Validate before backing up or changing anything.
    const clients = await runningClients(agent.id);
    if (clients.length) throw new Error(`请先退出 ${clients.join('、')}，完成切换后重新打开`);
    const targetIdentity = getProfileIdentity(agent, name);
    const liveIdentity = agent.identity();
    const liveRevision = credentialState(agent).revision;
    if (options.expectedCurrentRevision && liveRevision !== options.expectedCurrentRevision) {
      throw new Error('确认期间当前凭据已变化，未执行切换，请重新核对');
    }
    const targetRevision = credentialState(agent, target).revision;
    const alreadySelected = isSameIdentity(liveIdentity, targetIdentity);
    if (needsUnmanagedChoice(agent, name) && typeof options.saveUnmanaged !== 'boolean') {
      throw new Error('当前账号未保存在 AGS，请明确选择保存后切换或不保存并切换（CLI：--save-current / --discard-current）');
    }
    await syncCurrent(agent, options.saveUnmanaged !== false);
    if (credentialState(agent).revision !== liveRevision || agent.identity()?.id !== liveIdentity?.id) throw new CredentialChangedError();
    if (!alreadySelected && credentialState(agent, target).revision !== targetRevision) throw new CredentialChangedError();
    if (alreadySelected) {
      const order = credentialOrder(credentialState(agent, target), credentialState(agent));
      if (order === 'unknown') throw new Error('当前登录与账号池凭据版本不同，无法确认新旧，已取消覆盖');
      if (order !== 'newer') { setActiveProfile(agent.id, name); return { ok: true, files: [], warnings: [] }; }
    }
    const previous = agent.readCredentials();
    const appliedRevision = credentialState(agent, target).revision;
    try {
      const result = await agent.use(name);
      if (credentialState(agent).revision !== appliedRevision) throw new CredentialChangedError();
      setActiveProfile(agent.id, name);
      liveCache.delete(agent.id);
      return result;
    } catch (error) {
      // A concurrent external login owns its new credentials, including during rollback.
      if (credentialState(agent).revision === appliedRevision) agent.writeCredentials(agent.homeDir, previous);
      throw error;
    }
  });
}
export interface RemovalPreview {
  agent: string; profile: string; profiles: string[]; current: boolean; logoutUnsupported?: string;
  identity?: string; signature: string; liveRevision?: string;
}

function removalPreview(agent: BaseAgent, name: string): RemovalPreview {
  if (!profileExists(agent.id, name)) throw new Error('账号不存在');
  const identity = agent.identity(profileDir(agent.id, name));
  const profiles = listProfiles(agent.id).filter(profile => profile === name ||
    !!identity && agent.identity(profileDir(agent.id, profile))?.id === identity.id);
  const states = profiles.map(profile => {
    const dir = profileDir(agent.id, profile), stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) throw new Error('账号目录无效');
    const allowed = [...agent.authFiles, '_meta.json', 'config.toml', 'settings.json', 'settings.local.json'];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!allowed.includes(entry.name) || !entry.isFile()) throw new Error(`「${profile}」含非账号管理文件，已保留，请先核对`);
    }
    // Credential rotation may finish while the confirmation is open. Stable
    // identity and directory incarnation bind removal, not expiring tokens.
    return [profile, stat.dev, stat.ino, stat.birthtimeMs, agent.identity(dir)?.id || credentialState(agent, dir).revision];
  });
  let live: Identity | undefined, unsupported: string | undefined;
  try { live = agent.identity(); unsupported = logoutSupport(agent); }
  catch { unsupported = '无法可靠确认客户端登录，请在官方客户端退出'; }
  const current = !!identity && live?.id === identity.id;
  return { agent: agent.id, profile: name, profiles, identity: identity?.id,
    signature: fingerprint(JSON.stringify(states)), current, logoutUnsupported: unsupported,
    liveRevision: current ? credentialState(agent).revision : undefined };
}

export async function previewRemoveAccount(agent: BaseAgent, name: string): Promise<RemovalPreview> {
  return withStoreLock(async () => removalPreview(agent, name));
}

export async function removeAccount(agent: BaseAgent, name: string, options: { preview?: RemovalPreview; logout?: boolean } = {}) {
  const expected = options.preview || await previewRemoveAccount(agent, name);
  if (expected.agent !== agent.id || expected.profile !== name) throw new Error('删除范围已变化，请重新核对');
  // Same ordering as quota refresh: identity lock, then the short mutation lock.
  // A rotating token is committed before removal can touch its pool copies.
  return withStoreLock(async () => {
    return withStoreLock(async () => {
      if (options.logout) await assertLogoutReady(agent);
      const latest = removalPreview(agent, name);
      if (latest.signature !== expected.signature || latest.identity !== expected.identity) throw new Error('账号或备份范围已变化，请重新核对后删除');
      if (options.logout && (!expected.current || !latest.current || latest.logoutUnsupported)) {
        throw new Error(latest.logoutUnsupported || '客户端当前账号已变化，未退出或删除，请重新核对');
      }
      // Re-read after all awaits; never log out another identity. A completed
      // refresh of this same identity is allowed and its latest revision is used.
      if (options.logout) clearClientCredentials(agent, latest.identity!, latest.liveRevision);
      const removed: string[] = [];
      try {
        if (latest.profiles.includes(getActiveProfile(agent.id) || '')) clearActiveProfile(agent.id);
        for (const profile of latest.profiles) {
          fs.rmSync(profileDir(agent.id, profile), { recursive: true });
          removed.push(profile);
        }
      } catch {
        throw new Error(`${options.logout ? '客户端已退出；' : ''}已移除 ${removed.length} 条备份，其余已保留，请重新核对后重试`);
      } finally { liveCache.delete(agent.id); }
      return { ok: true, removed, loggedOut: options.logout === true };
    });
  }, expected.identity || profileDir(agent.id, name));
}
export async function renameAccount(agent: BaseAgent, oldName: string, newName: string) {
  return withStoreLock(async () => {
    validateName(newName);
    const source = profileDir(agent.id, oldName);
    if (!profileExists(agent.id, oldName)) throw new Error('账号不存在');
    if (oldName === newName) return { ok: true, name: newName };
    const destination = profileDir(agent.id, newName);
    if (profileExists(agent.id, newName)) throw new Error('该名称已被使用');
    const meta = readProfileMeta(agent.id, oldName);
    const wasPreferred = getActiveProfile(agent.id) === oldName;
    fs.renameSync(source, destination);
    try {
      if (meta.label) writeProfileMeta(agent.id, newName, { ...meta, label: newName });
      if (wasPreferred) setActiveProfile(agent.id, newName);
    } catch (error) {
      fs.renameSync(destination, source);
      if (meta.label) writeProfileMeta(agent.id, oldName, meta);
      if (wasPreferred && getActiveProfile(agent.id) !== oldName) setActiveProfile(agent.id, oldName);
      throw error;
    }
    return { ok: true, name: newName };
  });
}

export interface CredentialUpdateTarget { agent: string; profile: string; identity: Identity; revision?: string }
export function credentialUpdateTarget(agent: BaseAgent, name: string): CredentialUpdateTarget {
  if (!profileExists(agent.id, name)) throw new Error('账号不存在，请重新选择');
  const identity = agent.identity(profileDir(agent.id, name));
  if (!identity) throw new Error('无法确认原账号身份，不能替换凭据');
  const live = liveCache.get(agent.id);
  const dir = profileDir(agent.id, name);
  const revision = credentialState(agent, dir).revision;
  const status = isSameIdentity(agent.identity(), identity) && live?.identity === identity.id &&
    live.status.credentialRevision === revision && live.status.credentialRevision === credentialState(agent).revision
    ? live.status : readProfileMeta(agent.id, name).snapshot;
  if (status?.credentialRevision && status.credentialRevision !== revision) throw new Error('账号凭据已变化，请刷新后重试');
  const authUnresolved = status?.state === 'error' && ['authentication-rejected', 'account-unavailable'].includes(status.authFailure || '');
  if (!status?.authExpired && status?.state !== 'expired' && !authUnresolved) throw new Error('此账号当前未标记为认证异常，请刷新后重试');
  return { agent: agent.id, profile: name, identity, revision };
}

export function availableCredentialUpdateTarget(agent: BaseAgent, name: string): CredentialUpdateTarget | undefined {
  try { return credentialUpdateTarget(agent, name); }
  catch { return undefined; }
}

export async function updateAccountCredentials(target: CredentialUpdateTarget, source: string, validateLogin?: () => void) {
  return withStoreLock(async () => {
    validateLogin?.();
    return replaceAccountCredentialsLocked(target, source).result;
  });
}

/** Caller must hold the store lock. Imports use rollback to keep the whole batch atomic. */
export function replaceAccountCredentialsLocked(target: CredentialUpdateTarget, source: string) {
  const agent = resolveAgent(target.agent);
  const current = credentialUpdateTarget(agent, target.profile);
  if (!isSameIdentity(current.identity, target.identity)) throw new Error('原账号已变化，请重新选择');
  if (current.revision !== target.revision) throw new Error('原账号凭据已变化，请重新选择');
  const files = agent.credentials(source);
  const incoming = agent.identity(source)!;
  if (!isSameIdentity(current.identity, incoming)) throw new Error('凭据不属于此账号或工作区，未进行更新');
  const dir = profileDir(agent.id, target.profile);
  // Only replace the same failed generation in the client. A separate login
  // may already have installed different credentials there.
  const isLive = agent.management().canSaveCurrent && isSameIdentity(agent.identity(), current.identity) &&
    credentialState(agent).revision === current.revision;
  const meta = readProfileMeta(agent.id, target.profile);
  // Retain history and user metadata, but never call newly imported data verified.
  const snapshot: StatusResult = {
    ...meta.snapshot, available: true, account: incoming.email || meta.email,
    state: 'unverified', authExpired: false, extra: undefined, checkedAt: undefined,
    refreshFailures: undefined, creditActivity: undefined,
    credentialRevision: credentialState(agent, source).revision, authFailure: undefined,
  };
  const writes = [
    { dir, files: { ...files, '_meta.json': Buffer.from(JSON.stringify({ ...meta, email: incoming.email || meta.email, snapshot }, null, 2)) } },
    ...(isLive ? [{ dir: agent.homeDir, files }] : []),
  ];
  const previous = writes.map(write => ({ dir: write.dir, files: write.dir === agent.homeDir ? agent.readCredentials() : Object.fromEntries(Object.keys(write.files).map(file => [file, readBuffer(path.join(write.dir, file))])) }));
  const apply = (write: { dir: string; files: Record<string, Buffer | null> }) => write.dir === agent.homeDir
    ? agent.writeCredentials(write.dir, write.files) : replaceFiles(write.dir, write.files);
  let applied = 0;
  try {
    for (const write of writes) { apply(write); applied++; }
  } catch (error) {
    for (let i = applied - 1; i >= 0; i--) apply(previous[i]);
    throw error;
  }
  const cached = liveCache.get(agent.id);
  if (isLive) liveCache.delete(agent.id);
  return {
    result: { ok: true, agent: agent.id, profile: target.profile },
    rollback() {
      for (const write of [...previous].reverse()) apply(write);
      if (isLive && cached) liveCache.set(agent.id, cached);
      else if (isLive) liveCache.delete(agent.id);
    },
  };
}

export function dashboard() {
  return ALL_AGENTS.map(agent => {
    const management = agent.management();
    const profiles = listProfiles(agent.id).map(name => {
      const dir = profileDir(agent.id, name);
      const meta = readProfileMeta(agent.id, name);
      const stored = meta.snapshot;
      let saved: Identity | undefined, snapshot: StatusResult | undefined;
      if (agent.management().quota) {
        const bytes = agent.readCredentials(dir)[agent.authFiles[0]];
        let auth;
        try { auth = bytes && JSON.parse(bytes.toString()); } catch { /* Incomplete login. */ }
        saved = agent.identityFromAuth(auth);
        snapshot = snapshotForCredentials(stored, credentialStateFromFiles(agent.id, [[agent.authFiles[0], bytes]]).revision);
      } else {
        saved = agent.identity(dir);
        snapshot = agent.credentialStatus(dir);
      }
      if (saved?.email && !meta.email) {
        meta.email = saved.email;
        writeProfileMeta(agent.id, name, meta);
      }
      return { name, meta: { ...meta, snapshot }, stored, saved };
    });
    const switchUnsupported = agent.switchSupport();
    let active: string | undefined, status: StatusResult;
    try {
      const identity = agent.identity();
      const matches = profiles.filter(p => isSameIdentity(identity, p.saved)).map(p => p.name);
      if (management.canSaveCurrent && !switchUnsupported && matches.length) active = preferredMatch(matches, getActiveProfile(agent.id));
      if (management.quota) {
        const live = liveCache.get(agent.id);
        const cached = live && identity?.id === live.identity ? live.status : profiles.find(p => p.name === active)?.stored;
        status = (identity && snapshotForCredentials(cached, credentialState(agent).revision)) || {
          available: !!identity, account: identity?.email, state: identity ? 'unverified' : 'signed-out', extra: switchUnsupported,
        };
      } else {
        status = agent.displayStatus();
      }
    } catch (error) { status = { available: false, state: 'error', extra: (error as Error).message }; }
    return {
      id: agent.id, label: agent.label, active, status, management, switchUnsupported, refreshAt: quotaRefreshAt(status, true),
      profiles: profiles.map(({ name, meta }) => ({ name, meta, isActive: name === active, refreshAt: quotaRefreshAt(meta.snapshot, name === active) })),
    };
  });
}

export function refreshAccount(agent: BaseAgent, name?: string, force = false): Promise<StatusResult> {
  if (!(agent instanceof CodexAgent || agent instanceof AntigravityAgent && agent.management().quota)) {
    if (name && !profileExists(agent.id, name)) return Promise.reject(new Error('账号不存在'));
    return name ? Promise.resolve(agent.credentialStatus(profileDir(agent.id, name))) : agent.status();
  }
  const requested = name ? profileDir(agent.id, name) : agent.homeDir;
  const identity = agent.identity(requested);
  const isLive = !name || (!!identity && agent.identity()?.id === identity.id);
  const dir = isLive ? agent.homeDir : requested;
  const key = JSON.stringify([agent.id, name, dir, credentialState(agent, dir).revision]);
  const pending = pendingQueries.get(key);
  if (pending) return pending;
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await withStoreLock(async () => {
        if (name && !profileExists(agent.id, name)) throw new Error('账号不存在');
        if (agent.identity(requested)?.id !== identity?.id || agent.identity(dir)?.id !== identity?.id) throw new CredentialChangedError();
        const profile = name || activeProfile(agent);
        const original = agent.readCredentials(dir)[agent.authFiles[0]];
        const { revision } = credentialStateFromFiles(agent.id, [[agent.authFiles[0], original]]);
        const live = liveCache.get(agent.id);
        const stored = profile ? readProfileMeta(agent.id, profile).snapshot : live?.identity === identity?.id ? live?.status : undefined;
        return { profile, original, revision, cached: snapshotForCredentials(stored, revision) };
      });
      const { profile, original, revision, cached } = snapshot;
      // Check after acquiring the identity lock, including for manual requests
      // queued behind another process. Changed credentials have no checkedAt.
      const refreshAt = force
        ? Date.parse(cached?.checkedAt || '') + MIN_REFRESH_INTERVAL_MS
        : quotaRefreshAt(cached, isLive);
      if (cached && refreshAt > Date.now()) return cached;
      if (profile) assertCredentialWriteReady(path.join(profileDir(agent.id, profile), agent.authFiles[0]));
      const query = await agent.queryCredential(original);
      try {
        return await withStoreLock(async () => {
          if (name && (!profileExists(agent.id, name) || agent.identity(profileDir(agent.id, name))?.id !== identity?.id)) throw new CredentialChangedError();
          if (agent.identity(dir)?.id !== identity?.id || (name && !isLive && identity && agent.identity()?.id === identity.id)) throw new CredentialChangedError();
          const status = agent.commitQuery(dir, revision, query);
          return recordRefresh(agent, dir, profile, isLive, identity, revision, cached, status);
        });
      } catch (error) {
        if (query.temporaryDirectory && error instanceof Error && !error.message.includes(query.temporaryDirectory)) {
          error.message += `；未写回的凭据已保留在 ${query.temporaryDirectory}，恢复前请勿清理该目录`;
        }
        // Retry once only for a newer generation of the originally requested account.
        if (!(error instanceof CredentialChangedError) || attempt || !identity ||
            agent.identity(dir)?.id !== identity.id || credentialState(agent, dir).revision === revision) throw error;
      }
    }
  };
  const query = withStoreLock(run, identity?.id || dir).finally(() => pendingQueries.delete(key));
  pendingQueries.set(key, query);
  return query;
}

async function recordRefresh(agent: BaseAgent, dir: string, profile: string | undefined, isLive: boolean,
    identity: Identity | undefined, previousRevision: string | undefined, cached: StatusResult | undefined, status: StatusResult) {
  if ((status.state === 'error' || status.state === 'expired') && cached?.quota) {
    // Retain history and plan grouping; expired credentials are rendered as
    // a login error, never as currently usable quota.
    status = { ...status, quota: cached.quota, plan: cached.plan, fetchedAt: cached.fetchedAt };
  }
  if (status.state === 'ok') {
    const previous = cached?.quota?.credits?.balance;
    const current = status.quota?.credits?.balance;
    const previousAmount = creditBalance(previous);
    const currentAmount = creditBalance(current);
    if (previousAmount !== undefined && currentAmount !== undefined && currentAmount < previousAmount) {
      status.creditActivity = { lastDecreaseAt: new Date().toISOString(), previousBalance: previous!, currentBalance: current! };
    } else if (previousAmount !== undefined && currentAmount === previousAmount && cached?.creditActivity && Date.now() - Date.parse(cached.creditActivity.lastDecreaseAt) < 300000) {
      status.creditActivity = cached.creditActivity;
    }
  }
  status.checkedAt = new Date().toISOString();
  if (status.state === 'error') status.refreshFailures = (cached?.refreshFailures || 0) + 1;
  // An old imported alias may contain a revoked refresh token. Never spread
  // failed credentials back to other copies of an otherwise healthy account.
  if (identity && status.state === 'ok') await syncCopies(agent, dir, previousRevision, false, status.credentialRevision);
  if (credentialState(agent, dir).revision !== status.credentialRevision) throw new CredentialChangedError();
  if (isLive && identity) liveCache.set(agent.id, { identity: identity.id, status });
  // Old imported aliases share a result only for the same identity and exact
  // credential generation. Their labels and other metadata remain independent.
  for (const name of listProfiles(agent.id)) {
    const target = profileDir(agent.id, name);
    if (name !== profile && (!identity || agent.identity(target)?.id !== identity.id)) continue;
    if (credentialState(agent, target).revision !== status.credentialRevision) continue;
    const meta = readProfileMeta(agent.id, name);
    writeProfileMeta(agent.id, name, { ...meta, email: identity?.email || meta.email, snapshot: status });
  }
  return status;
}

export async function prepareLogin(agent: BaseAgent): Promise<string | undefined> {
  return withStoreLock(async () => {
    if (!agent.management().isolatedLogin) {
      if (agent.management().canSaveCurrent) {
        if (agent.identity() && !activeProfile(agent)) throw new Error('当前账号未保存在 AGS，请先明确保存或在官方客户端退出，再开始新登录');
        await syncCurrent(agent, false);
      }
      return undefined;
    }
    const existing = loginDirs.get(agent.id);
    if (existing) return existing;
    const dir = createTemporaryCredentials('login');
    loginDirs.set(agent.id, dir);
    return dir;
  });
}
export function loginStatus(agent: BaseAgent) {
  const dir = loginDirs.get(agent.id) || agent.homeDir;
  const identity = agent.management().canSaveCurrent ? agent.identity(dir) : undefined;
  const duplicate = identity ? findExistingProfile(agent, identity) : undefined;
  return {
    account: agent.management().canSaveCurrent ? identity?.email || (identity ? '已检测到凭据' : undefined) : agent.displayStatus().account,
    email: identity?.email,
    ready: !!identity && agent.management().canSaveCurrent,
    isolated: dir !== agent.homeDir,
    existingProfile: duplicate?.name,
    existingProfileUpdatable: !!duplicate && !!availableCredentialUpdateTarget(agent, duplicate.name),
  };
}

export function cancelLogin(agent?: BaseAgent): void {
  const agents = agent ? [agent] : ALL_AGENTS;
  for (const a of agents) releaseLoginDirectory(a);
}
