import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { BaseAgent, StatusResult, Identity, type CredentialFiles, type CredentialQuery, type CredentialTracker } from './agents/base';
import { codexAgent } from './agents/codex';
import { codexQuotaRecovery, RecoveredCodexIdentity } from './codex-quota-recovery';
import { antigravityAgent } from './agents/antigravity';
import { resolveSavedNativeIdentity, withNativeReadSnapshot } from './antigravity-native';
import { listProfiles, getActiveProfile, setActiveProfile, clearActiveProfile, profileDir, profileExists, readProfileMeta, writeProfileMeta, withStoreLock, validateName, sameProfileName, PENDING_RENAME_FILE, setInProcessRename, ProfileMeta } from './store';
import { atomicWrite, replaceFiles, readBuffer, extractRefreshToken, fingerprint, differentEmail, type CredentialWriter } from './utils';
import { runningClients } from './clients';
import { logoutSupport, assertLogoutReady, clearClientCredentials } from './client-logout';
import { discardSupersededQuota, PendingQuotaConflict, ConsumedCodexRotation, recordCodexQuotaOutput, createTemporaryCredentials, releaseTemporaryCredentials, removeTemporaryCredentials } from './temporary-credentials';
import { MIN_REFRESH_INTERVAL_MS, refreshPeriodMs, quotaRefreshTimes, spareQuotaActivity } from './quota-refresh';
import { readRefreshIntervals } from './settings';
import { credentialState, credentialStateFromFiles, credentialOrder, snapshotForCredentials, CredentialChangedError, QuotaBearerRejected, LiveWriteDeferred } from './credential-state';
import { assertCredentialWriteReady, STAGED_CREDENTIAL_SUFFIX } from './credential-vault';
import { resultDiagnostic, stepDiagnostic } from './diagnostics';

export const ALL_AGENTS: BaseAgent[] = [codexAgent, antigravityAgent];
export function resolveAgent(id: string): BaseAgent {
  const agent = ALL_AGENTS.find(a => a.id === id);
  if (!agent) throw new Error('未知平台');
  return agent;
}
const liveCache = new Map<string, { identity: string; status: StatusResult }>();
const pendingQueries = new Map<string, Promise<StatusResult>>();
const refreshWriteFailures = new Map<string, { at: number; message: string }>();
const loginDirs = new Map<string, string>();
let criticalCommitTracker: CredentialTracker = work => work();
let sharedRenewalTracker = criticalCommitTracker;
export function setCriticalCommitTracker(commit: CredentialTracker, startSharedRenewal: CredentialTracker = commit): void {
  criticalCommitTracker = commit;
  sharedRenewalTracker = startSharedRenewal;
}

const stagedFileName = (agent: BaseAgent) => `${agent.authFiles[0]}${STAGED_CREDENTIAL_SUFFIX}`;
const stagedFilePath = (agent: BaseAgent, dir: string) => path.join(dir, stagedFileName(agent));
const stagedClientBusy = '客户端正在运行，为避免续期冲突暂不验证新凭据；请先关闭客户端后刷新验证';
const nativeSourcesUnknown = '无法确认 Antigravity 的全部登录来源，已暂停续期。请检查官方登录存储后重试';
function readStagedBytes(agent: BaseAgent, dir: string): Buffer | null {
  return readBuffer(stagedFilePath(agent, dir));
}

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
  if (a.id && b.id) return a.id === b.id;
  const email = a.email?.trim().toLowerCase();
  return !!email && email === b.email?.trim().toLowerCase();
}

function safeIdentity(agent: BaseAgent, dir?: string): Identity | undefined {
  try { return agent.identity(dir); } catch { return undefined; }
}

function conflictingQuotaEmail(registered?: string, observed?: string, status?: StatusResult): boolean {
  const reported = status?.account;
  return differentEmail(registered, observed) ||
    differentEmail(registered || observed, reported?.includes('@') ? reported : undefined);
}

function quotaSnapshot(agent: BaseAgent, revision?: string, registered?: string, observed?: string, stored?: StatusResult, localOnly = false): StatusResult | undefined {
  if (agent.bindsQuotaEmail && conflictingQuotaEmail(registered, observed, stored)) {
    const account = registered || observed;
    const checked = revision && stored?.credentialRevision === revision && stored.state === 'error' && account &&
      stored.account?.trim().toLowerCase() === account.trim().toLowerCase();
    return { available: true, account, state: 'error' as const, credentialRevision: revision,
      checkedAt: checked ? stored?.checkedAt : undefined, refreshFailures: checked ? stored?.refreshFailures : undefined,
      extra: '额度身份与账号记录不一致，请刷新核对' };
  }
  // Offline mode may retain a known plan as an account label across credential generations.
  const keepPlan = localOnly && !conflictingQuotaEmail(registered, observed, stored);
  const history = !keepPlan && stored?.plan && !stored.quota && (!revision || revision !== stored.credentialRevision)
    ? { ...stored, plan: undefined } : stored;
  const snapshot = snapshotForCredentials(history, revision);
  return snapshot && agent.sharedQuotaLogin ? agent.sharedQuotaLogin.normalizeQuotaHistory(snapshot) : snapshot;
}

function reportedQuotaHistory(status?: StatusResult) {
  return {
    ...(status?.plan ? { plan: status.plan } : {}),
    ...(status?.quota ? { quota: status.quota, fetchedAt: status.fetchedAt } : {}),
  };
}

function currentQuotaSnapshot(revision: string | undefined, saved?: StatusResult, live?: StatusResult) {
  if (revision && live?.credentialRevision === revision) {
    if (saved?.credentialRevision !== revision || live.refreshConsumed) return live;
    if (!saved.refreshConsumed && Date.parse(live.checkedAt || '') > (Date.parse(saved.checkedAt || '') || 0)) return live;
  }
  return saved || live;
}

export function getProfileIdentity(agent: BaseAgent, name: string): { id?: string; email?: string } | undefined {
  const dir = profileDir(agent.id, name);
  const idObj = safeIdentity(agent, dir);
  if (!idObj || idObj.email) return idObj;
  let meta: ProfileMeta = {};
  try { meta = readProfileMeta(agent.id, name); } catch {}
  return { id: idObj.id, email: idObj.email || meta.email };
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

function matchingProfiles(agent: BaseAgent, identity: Identity, login?: CredentialFiles): string[] {
  const native = login && agent.sharedQuotaLogin;
  return listProfiles(agent.id).filter(name => {
    const dir = profileDir(agent.id, name);
    if (native) {
      const file = agent.authFiles[0];
      try { return agent.compareSessionCopies?.(login[file], agent.readCredentials(dir)[file]) !== undefined; }
      catch { return false; }
    }
    const target = safeIdentity(agent, dir);
    return target && isSameIdentity(identity, target);
  });
}

function nextBackupName(agentId: string): string {
  let timestamp = Date.now();
  while (profileExists(agentId, `backup-${timestamp}`)) timestamp++;
  return `backup-${timestamp}`;
}

export function activeProfile(agent: BaseAgent): string | undefined {
  const identity = safeIdentity(agent);
  if (!identity) return undefined;
  const matches = matchingProfiles(agent, identity).filter(name => {
    try { return !readProfileMeta(agent.id, name).pendingLiveRevision || credentialState(agent, profileDir(agent.id, name)).revision === credentialState(agent).revision; }
    catch { return false; }
  });
  return preferredMatch(agent, matches);
}

function preferredMatch(agent: BaseAgent, matching: string[], liveRevision?: string) {
  const preferred = getActiveProfile(agent.id);
  const nonBackup = matching.find(m => !/^backup-\d+$/.test(m));
  if (preferred && matching.includes(preferred)) {
    if (!nonBackup || !/^backup-\d+$/.test(preferred)) return preferred;
    if (agent.sharedQuotaLogin && credentialState(agent, profileDir(agent.id, preferred)).revision ===
        (liveRevision ?? credentialState(agent).revision)) return preferred;
  }
  return nonBackup || matching[0];
}

export function clientSwitchRevision(agent: BaseAgent): string {
  return agent.switchFingerprint() || fileSwitchRevision(agent, agent.readSwitchableCredentials());
}

/** Keep the same lock order as quota refresh, including when a backup selects multiple accounts. */
export async function withProfileCredentialLocks<T>(
  profiles: { agent: BaseAgent; profile?: string; source?: string }[],
  work: (lockedIds: ReadonlySet<string>) => Promise<T>,
  inputIds: readonly string[] = [],
): Promise<T> {
  const observe = ({ agent, profile, source }: typeof profiles[number]) => {
    const dir = source ?? (profile === undefined ? agent.homeDir : profileDir(agent.id, profile));
    return safeIdentity(agent, dir)?.id ?? dir;
  };
  const { observed, ids } = withNativeReadSnapshot(() => {
    const observed = profiles.map(observe);
    const ids = new Set([...observed, ...inputIds]);
    for (const { agent, profile, source } of profiles) {
      if (!source && profile === undefined) {
        try { for (const aux of agent.auxiliaryCredentials()) ids.add(aux.identity.id); }
        catch { /* syncCurrent will require every source it modifies to be readable and locked. */ }
      }
    }
    return { observed, ids };
  });
  const locked = () => withStoreLock(() => withNativeReadSnapshot(() => {
    if (profiles.some((item, i) => observe(item) !== observed[i])) throw new CredentialChangedError();
    return work(ids);
  }));
  try {
    return await [...ids].sort().reduceRight<() => Promise<T>>((next, id) => () => withStoreLock(() => Promise.resolve().then(next), id), locked)();
  } catch (error) {
    if (error instanceof RecoveredCodexIdentity) return withProfileCredentialLocks(profiles, work, inputIds);
    throw error;
  }
}

/** Called under the selected identities' locks and the pool lock; never renews or writes to a client. */
export function preparedProfileCredentials(agent: BaseAgent, name: string, readCurrent?: (agent: BaseAgent) => Buffer | null, preview = false): CredentialFiles {
  const dir = profileDir(agent.id, name), files = agent.credentials(dir);
  const shared = agent.sharedQuotaLogin;
  const file = agent.authFiles[0], original = files[file]!, identity = agent.identityFromBytes(original)!;
  try {
    if (!shared) {
      const recovery = codexQuotaRecovery(agent, dir, name, identity.id, original);
      return recovery ? { ...files, [file]: preview ? recovery.selected : recovery.apply() } : files;
    }
    const recovered = shared.recoverProfileCredential(dir, identity.id, original, preview);
    if (recovered.readOnly) throw new PendingQuotaConflict();
    // A saved active profile may lag an official refresh. Only the same login's
    // verifiably newer bearer may be copied; independent logins keep their own files.
    const preferred = getActiveProfile(agent.id) === name;
    let current: Buffer | null = null;
    try {
      current = readCurrent ? readCurrent(agent) : agent.readSwitchableCredentials().files[file];
    } catch (error) {
      if (preferred) throw error;
    }
    const superseded = readProfileMeta(agent.id, name).pendingLiveRevision;
    const selected = current && (!superseded || superseded !== credentialStateFromFiles(agent.id, [[file, current]]).revision) &&
      (agent.compareSessionCopies?.(current, recovered.bytes) ?? 0) > 0
      ? current : resolveSavedNativeIdentity(recovered.bytes, current);
    if (!preview && !selected.equals(recovered.bytes)) {
      if (!agent.readCredentials(dir)[file]?.equals(recovered.bytes)) throw new CredentialChangedError();
      agent.writeCredentials(dir, { [file]: selected });
      if (!agent.readCredentials(dir)[file]?.equals(selected)) throw new Error('未能确认当前登录已同步到账号池');
    }
    return { ...files, [file]: selected };
  } catch (error) {
    if (error instanceof Error) error.message = `「${name}」${error.message}`;
    throw error;
  }
}

function inspectSwitchTarget(agent: BaseAgent, name: string, expectedCurrentRevision?: string, preview = false) {
  return withNativeReadSnapshot(() => {
    const current = agent.readSwitchableCredentials();
    const target = preparedProfileCredentials(agent, name, a => current.files[a.authFiles[0]], preview);
    const bytes = target[agent.authFiles[0]], live = current.files[agent.authFiles[0]];
    const alreadySelected = !!bytes && !!live?.equals(bytes) && !current.corrupted && !agent.hasPendingSwitchCleanup() &&
      (!expectedCurrentRevision || clientSwitchRevision(agent) === expectedCurrentRevision);
    if (alreadySelected && !preview) setActiveProfile(agent.id, name);
    return { target, alreadySelected };
  });
}

/** Observe switch consent without applying quota recovery, updating aliases or selecting a profile. */
export async function previewTraySwitch(agent: BaseAgent, name: string) {
  const assertStableNames = () => {
    if (fs.existsSync(PENDING_RENAME_FILE)) throw new Error('账号正在重命名，请稍后重试');
  };
  assertStableNames();
  const dir = profileDir(agent.id, name), identity = agent.identity(dir)?.id;
  const observe = () => withNativeReadSnapshot(() => {
    assertStableNames();
    const currentRevision = clientSwitchRevision(agent);
    const interrupted = agent.hasInterruptedSwitch?.() === true;
    // Partial desktop/CLI files can disagree until the verified switch journal is restored.
    const unmanaged = !interrupted && needsUnmanagedChoice(agent, name);
    const prepared = interrupted ? undefined : inspectSwitchTarget(agent, name, undefined, true);
    const target = prepared?.target ?? agent.credentials(dir);
    const targetRevision = credentialStateFromFiles(agent.id, Object.entries(target)).revision;
    const alreadySelected = !!agent.sharedQuotaLogin && prepared?.alreadySelected === true;
    const migration = !interrupted && !alreadySelected && agent.needsFileMigration?.(target[agent.authFiles[0]]) === true;
    return { currentRevision, targetRevision, interrupted, unmanaged, migration, alreadySelected };
  });
  // A live quota writer can leave a temporarily incomplete recovery file. Wait for its identity lock.
  const state = await withStoreLock(async () => {
    if (agent.identity(dir)?.id !== identity) throw new CredentialChangedError();
    return observe();
  }, identity ?? dir);
  return { state, recheck() {
    if (!isDeepStrictEqual(observe(), state)) throw new CredentialChangedError();
  } };
}

export function prepareSwitchTarget(agent: BaseAgent, name: string, expectedCurrentRevision?: string) {
  return withProfileCredentialLocks([{ agent, profile: name }], async () => inspectSwitchTarget(agent, name, expectedCurrentRevision));
}

function fileSwitchRevision(agent: BaseAgent, { files, corrupted }: ReturnType<BaseAgent['readSwitchableCredentials']>): string {
  const primaryRev = corrupted ? 'corrupt' : credentialStateFromFiles(agent.id, Object.entries(files)).revision || 'none';
  const auxRevs = agent.auxiliaryCredentials().map(aux =>
    `${aux.identity.id}:${credentialStateFromFiles(agent.id, Object.entries(aux.files)).revision || ''}`).sort();
  return fingerprint(JSON.stringify([primaryRev, auxRevs]));
}

async function syncCurrent(agent: BaseAgent, saveUnmanaged = true, skipPrimary = false, lockedIds?: ReadonlySet<string>): Promise<Map<string, string | undefined>> {
  const [primaryFiles, auxiliaries] = withNativeReadSnapshot(() => [skipPrimary ? undefined : agent.readCredentials(), agent.auxiliaryCredentials()] as const);
  const primaryIdentity = primaryFiles && agent.identity(agent.homeDir, primaryFiles);
  if (agent.usesCredentialRevisions) {
    const allSources = [
      ...(primaryIdentity && primaryFiles ? [{ identity: primaryIdentity, files: primaryFiles }] : []),
      ...auxiliaries,
    ];
    if (lockedIds && agent.sharedQuotaLogin && allSources.some(source => !lockedIds.has(source.identity.id))) {
      throw new CredentialChangedError();
    }
    for (let i = 0; i < allSources.length; i++) {
      const stateA = credentialStateFromFiles(agent.id, Object.entries(allSources[i].files));
      for (let j = i + 1; j < allSources.length; j++) {
        if (!isSameIdentity(allSources[i].identity, allSources[j].identity)) continue;
        const stateB = credentialStateFromFiles(agent.id, Object.entries(allSources[j].files));
        const file = agent.authFiles[0];
        const independent = !!agent.sharedQuotaLogin &&
          extractRefreshToken(allSources[i].files[file]) !== extractRefreshToken(allSources[j].files[file]);
        if (independent || credentialOrder(stateA, stateB) === 'unknown') {
          const label = allSources[i].identity.email || allSources[i].identity.id;
          throw new Error(`检测到账号「${label}」在客户端多处认证存储中存在无法确认新旧的独立凭据，已保留原凭据并取消操作`);
        }
      }
    }
  }
  if (primaryIdentity && primaryFiles) {
    const active = preferredMatch(agent, matchingProfiles(agent, primaryIdentity, primaryFiles));
    await syncCopies(agent, agent.homeDir, { files: primaryFiles, liveProfile: active });
    if (!active && saveUnmanaged) {
      const name = nextBackupName(agent.id);
      await agent.save(name, agent.homeDir, primaryFiles);
      writeProfileMeta(agent.id, name, { email: primaryIdentity.email, savedAt: new Date().toISOString() });
    }
  }
  const updated = new Map<string, string | undefined>();
  for (const aux of auxiliaries) {
    let matches = matchingProfiles(agent, aux.identity);
    if (matches.length && agent.sharedQuotaLogin) {
      const file = agent.authFiles[0];
      matches = matches.filter(name => agent.compareSessionCopies?.(aux.files[file], agent.readCredentials(profileDir(agent.id, name))[file]) !== undefined);
      if (!matches.length) throw new Error('客户端认证回退文件与池内同账号的凭据无法确认新旧，已保留两个登录并取消切换');
    }
    if (matches.length) {
      const auxState = credentialStateFromFiles(agent.id, Object.entries(aux.files));
      for (const name of matches) {
        const dest = profileDir(agent.id, name);
        const order = agent.usesCredentialRevisions ? poolCopyOrder(agent, aux.files, agent.readCredentials(dest)) : 'newer';
        if (order === 'unknown') {
          throw new Error(`「${name}」与客户端认证回退文件存在不同版本的凭据，无法确认新旧，已保留两份凭据并取消操作`);
        }
        if (order === 'newer') {
          agent.writeCredentials(dest, aux.files);
          updated.set(name, auxState.revision);
        }
      }
    } else if (saveUnmanaged) {
      const backup = nextBackupName(agent.id);
      agent.writeCredentials(profileDir(agent.id, backup), aux.files);
      writeProfileMeta(agent.id, backup, { email: aux.identity.email, savedAt: new Date().toISOString() });
    }
  }
  return updated;
}

function poolCopyOrder(agent: BaseAgent, source: CredentialFiles, target: CredentialFiles,
  order = credentialOrder(credentialStateFromFiles(agent.id, Object.entries(source)), credentialStateFromFiles(agent.id, Object.entries(target))),
  confirmedSuccessor = false) {
  if (!agent.compareSessionCopies) return order;
  const file = agent.authFiles[0], preference = agent.compareSessionCopies(source[file], target[file]);
  if (preference === undefined) return agent.usesCredentialRevisions && !confirmedSuccessor ? 'unknown' : order;
  if (preference > 0) return 'newer';
  if (preference < 0) return 'older';
  return order === 'unknown' ? 'same' : order;
}

async function syncCopies(
  agent: BaseAgent,
  source: string,
  options: { files?: CredentialFiles; previousRevision?: string; strict?: boolean; expectedRevision?: string; liveProfile?: string;
    upgradedFrom?: { id: string; revision?: string } } = {},
): Promise<void> {
  const { files = agent.readCredentials(source), previousRevision, strict = true, expectedRevision, upgradedFrom } = options;
  const identity = agent.identity(source, files);
  if (!identity) return;
  const sourceState = credentialStateFromFiles(agent.id, Object.entries(files));
  if (expectedRevision && sourceState.revision !== expectedRevision) throw new CredentialChangedError();
  // With no rotation or timestamp no other generation can be proven older.
  if (!strict && sourceState.updatedAt === undefined && previousRevision === sourceState.revision) return;
  const writes: Array<{ name: string; revision?: string }> = [];
  for (const name of listProfiles(agent.id)) {
    const dest = profileDir(agent.id, name);
    if (dest === source) continue;
    // Email metadata alone cannot authorize a credential write.
    let target: Identity | undefined;
    let targetState: ReturnType<typeof credentialState>;
    let copy: CredentialFiles;
    try {
      copy = agent.readCredentials(dest);
      target = agent.identity(dest, copy);
      targetState = credentialStateFromFiles(agent.id, Object.entries(copy));
    } catch { continue; }
    if (!target) continue;
    const sameAccount = target.id === identity.id ||
      Boolean(upgradedFrom?.revision && target.id === upgradedFrom.id && targetState.revision === upgradedFrom.revision);
    if (!sameAccount) continue;
    if (source === agent.homeDir && readProfileMeta(agent.id, name).pendingLiveRevision) continue;
    if (strict && agent.sharedQuotaLogin && name !== options.liveProfile) {
      const file = agent.authFiles[0];
      if (agent.compareSessionCopies?.(files[file], copy[file]) === undefined) continue;
    }
    // A background query may update other copies only from its exact previous generation.
    if (!strict && name !== options.liveProfile && targetState.revision !== previousRevision) continue;
    const successor = !!previousRevision && targetState.revision === previousRevision && sourceState.revision !== previousRevision;
    const order = agent.usesCredentialRevisions ? poolCopyOrder(agent, files, copy, credentialOrder(sourceState, targetState, previousRevision), successor) : 'newer';
    if (order === 'unknown' && strict) throw new Error(`「${name}」存在不同版本的凭据，无法确认新旧，已保留两份凭据并取消操作`);
    if (order === 'newer') {
      if (expectedRevision && agent.bindsQuotaEmail && differentEmail(readProfileMeta(agent.id, name).email, identity.email)) continue;
      writes.push({ name, revision: targetState.revision });
    }
  }
  for (const { name, revision } of writes) {
    if (credentialState(agent, source).revision !== sourceState.revision ||
        credentialState(agent, profileDir(agent.id, name)).revision !== revision) throw new CredentialChangedError();
    await agent.save(name, source, files);
  }
}

export async function saveAccount(agent: BaseAgent, name: string, validateLogin?: () => void): Promise<{ ok: true; files: string[]; warnings: string[]; profile?: string; updated?: boolean }> {
  const isolatedSource = loginDirs.get(agent.id);
  const source = isolatedSource || agent.homeDir;
  return withProfileCredentialLocks([{ agent, source }], async lockedIds => {
    validateLogin?.();
    if (isolatedSource !== loginDirs.get(agent.id)) throw new CredentialChangedError();
    validateName(name);
    if (source === agent.homeDir && !agent.management().canSaveCurrent) throw new Error(agent.switchSupport() || '当前登录不支持保存为文件凭据');
    const captured = agent.readCredentials(source);
    const identity = agent.identity(source, captured);
    if (!identity) throw new Error('尚未检测到登录凭据，请完成登录后再保存');
    if (!lockedIds.has(identity.id)) throw new CredentialChangedError();
    const sourceState = credentialStateFromFiles(agent.id, Object.entries(captured));
    const finishSave = (profile: string) => {
      if (source !== agent.homeDir) releaseLoginDirectory(agent);
      else if (credentialState(agent).revision === sourceState.revision) setActiveProfile(agent.id, profile);
    };

    const existingProfile = findExistingProfile(agent, identity);
    const update = existingProfile && availableCredentialUpdateTarget(agent, existingProfile.name, { allowStaged: Boolean(isolatedSource) });
    if (update) {
      const files = Object.keys(captured);
      const { result } = await replaceAccountCredentialsLocked(update, source, { trusted: Boolean(isolatedSource), sourceFiles: captured });
      finishSave(update.profile);
      return { ok: true, files, warnings: result.warning ? [result.warning] : [], profile: update.profile, updated: true };
    }

    const duplicate = existingProfile?.name === name ? findExistingProfile(agent, identity, name) : existingProfile;
    if (duplicate) {
      const emailStr = identity.email ? `（${identity.email}）` : '';
      throw new Error(`该账号${emailStr}已存在于「${duplicate.name}」，无需重复添加`);
    }

    const destination = profileDir(agent.id, name);
    if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
      const existing = getProfileIdentity(agent, name);
      if (!existing) throw new Error('无法确认同名账号的原凭据，已保留原件，请使用新名称');
      if (!isSameIdentity(existing, identity)) {
        throw new Error('该名称已属于另一个账号，请使用新名称');
      }
      if (fs.lstatSync(stagedFilePath(agent, destination), { throwIfNoEntry: false })) {
        throw new Error('此账号已有待验证凭据，请刷新验证或使用「重新登录」');
      }
      if (agent.usesCredentialRevisions) {
        const order = poolCopyOrder(agent, captured, agent.readCredentials(destination));
        if (order === 'older' || order === 'unknown') throw new Error('保存的凭据可能早于账号池中的版本，已取消覆盖');
      }
    }

    const isBackup = /^backup-\d+$/.test(name);
    if (isBackup) await syncCopies(agent, source, { files: captured });
    const result = await agent.save(name, source, captured);
    const saved = agent.credentials(destination);
    const meta = readProfileMeta(agent.id, name);
    writeProfileMeta(agent.id, name, { ...meta, email: identity.email, savedAt: new Date().toISOString(),
      snapshot: snapshotForCredentials(meta.snapshot, credentialStateFromFiles(agent.id, Object.entries(saved)).revision) });
    liveCache.delete(agent.id);
    finishSave(name);
    if (!isBackup) {
      // The named profile is durable. Only remove backups whose full credential bytes it preserves.
      for (const backup of listProfiles(agent.id).filter(p => /^backup-\d+$/.test(p) && !sameProfileName(p, name))) {
        try {
          const dir = profileDir(agent.id, backup);
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          if (entries.some(entry => !entry.isFile() || (entry.name !== '_meta.json' && !agent.authFiles.includes(entry.name)))) continue;
          const copy = agent.readCredentials(dir);
          if (!isDeepStrictEqual(saved, copy)) continue;
          for (const entry of entries) fs.unlinkSync(path.join(dir, entry.name));
          fs.rmdirSync(dir);
        } catch { result.warnings.push(`账号已保存，自动备份「${backup}」未完成清理`); }
      }
    }
    return { ...result, ok: true };
  });
}

export function needsUnmanagedChoice(agent: BaseAgent, name: string): boolean {
  const { files, corrupted } = agent.readSwitchableCredentials();
  const acceptedPrevious = readProfileMeta(agent.id, name).pendingLiveRevision;
  const replacingPrevious = !!acceptedPrevious && acceptedPrevious === credentialStateFromFiles(agent.id, Object.entries(files)).revision;
  const live = corrupted ? undefined : agent.identityFromBytes(files[agent.authFiles[0]]);
  const targetId = agent.identity(profileDir(agent.id, name))?.id;
  const native = agent.sharedQuotaLogin;
  if (!replacingPrevious && live && (native || live.id !== targetId) && !matchingProfiles(agent, live, files).length) return true;
  return agent.auxiliaryCredentials().some(aux =>
    aux.identity.id !== live?.id && aux.identity.id !== targetId && !matchingProfiles(agent, aux.identity).length);
}

export async function useAccount(agent: BaseAgent, name: string, options: { saveUnmanaged?: boolean; expectedCurrentRevision?: string; allowFileMigration?: boolean; recheckConfirmation?: () => void } = {}) {
  return withProfileCredentialLocks([{ agent, profile: name }, { agent }], async lockedIds => {
    const unsupported = agent.switchSupport();
    if (unsupported) throw new Error(unsupported);
    const target = profileDir(agent.id, name);
    options.recheckConfirmation?.();
    if (agent.hasInterruptedSwitch?.()) await agent.recoverInterruptedSwitch?.();
    if (agent.sharedQuotaLogin && inspectSwitchTarget(agent, name, options.expectedCurrentRevision).alreadySelected) {
      return { ok: true, files: [], warnings: [] };
    }
    await agent.assertSwitchSessions?.();
    const clients = await runningClients(agent.id, { failClosed: !!agent.compareSessionCopies && options.allowFileMigration === true });
    if (clients.length) throw new Error(`请先退出 ${clients.join('、')}，完成切换后重新打开`);
    if (agent.canRecoverQuotaRotation) preparedProfileCredentials(agent, name);
    const { initialSwitchRev, targetRevision, alreadySelected, acceptingUpdate, syncing } = withNativeReadSnapshot(() => {
      const targetIdentity = getProfileIdentity(agent, name);
      const nativeFingerprint = agent.switchFingerprint();
      const currentLogin = agent.readSwitchableCredentials();
      const initialSwitchRev = nativeFingerprint || fileSwitchRevision(agent, currentLogin);
      const { files: liveFiles, corrupted: liveCorrupted } = currentLogin;
      const liveIdentity = liveCorrupted ? undefined : agent.identityFromBytes(liveFiles[agent.authFiles[0]]);
      const liveRevision = liveCorrupted ? undefined : credentialStateFromFiles(agent.id, Object.entries(liveFiles)).revision;
      if (options.expectedCurrentRevision && initialSwitchRev !== options.expectedCurrentRevision &&
          (nativeFingerprint || liveRevision !== options.expectedCurrentRevision)) {
        throw new Error('确认期间当前凭据已变化，未执行切换，请重新核对');
      }
      const targetRevision = credentialState(agent, target).revision;
      const native = agent.sharedQuotaLogin;
      const alreadySelected = !liveCorrupted && isSameIdentity(liveIdentity, targetIdentity) &&
        (!native || agent.compareSessionCopies?.(liveFiles[agent.authFiles[0]], agent.readCredentials(target)[agent.authFiles[0]]) !== undefined);
      if (needsUnmanagedChoice(agent, name) && typeof options.saveUnmanaged !== 'boolean') {
        throw new Error('当前账号未保存在 AGS，请明确选择保存后切换或不保存并切换（CLI：--save-current / --discard-current）');
      }
      const acceptingUpdate = !!liveRevision && readProfileMeta(agent.id, name).pendingLiveRevision === liveRevision && isSameIdentity(liveIdentity, targetIdentity);
      const syncing = syncCurrent(agent, options.saveUnmanaged !== false, liveCorrupted === true || acceptingUpdate, lockedIds);
      return { initialSwitchRev, targetRevision, alreadySelected, acceptingUpdate, syncing };
    });
    const syncedAuxiliary = await syncing;
    if (options.recheckConfirmation) {
      const reopened = await runningClients(agent.id, { failClosed: !!agent.sharedQuotaLogin });
      if (reopened.length) throw new Error(`${reopened.join('、')} 已重新打开，请重新确认切换`);
    }
    if (clientSwitchRevision(agent) !== initialSwitchRev) throw new CredentialChangedError();
    const expectedTargetRevision = syncedAuxiliary.has(name) ? syncedAuxiliary.get(name) : targetRevision;
    if (!alreadySelected && credentialState(agent, target).revision !== expectedTargetRevision) throw new CredentialChangedError();
    if (alreadySelected && !acceptingUpdate) {
      const order = poolCopyOrder(agent, agent.readCredentials(target), agent.readCredentials());
      if (order === 'unknown') throw new Error('当前登录与账号池凭据版本不同，无法确认新旧，已取消覆盖');
      if (order !== 'newer' && !agent.hasPendingSwitchCleanup()) {
        setActiveProfile(agent.id, name);
        return { ok: true, files: [], warnings: [] };
      }
    }
    const appliedRevision = credentialState(agent, target).revision;
    const journal = agent.createMutationJournal();
    let undoPreference: (() => void) | undefined;
    try {
      const result = await agent.use(name, { expectedSwitchFingerprint: initialSwitchRev, allowFileMigration: options.allowFileMigration, journal });
      if (journal.commitPrepared) {
        // Retire the old Keychain entry only once the selected profile is durable.
        const previous = getActiveProfile(agent.id);
        setActiveProfile(agent.id, name);
        undoPreference = () => previous === undefined ? clearActiveProfile(agent.id) : setActiveProfile(agent.id, previous);
        journal.commitPrepared();
        undoPreference = undefined;
      } else {
        if (credentialState(agent).revision !== appliedRevision) throw new CredentialChangedError();
        setActiveProfile(agent.id, name);
      }
      liveCache.delete(agent.id);
      if (acceptingUpdate) {
        try { writeProfileMeta(agent.id, name, { ...readProfileMeta(agent.id, name), pendingLiveRevision: undefined }); }
        catch { result.warnings.push('新登录已生效，待应用标记暂未清除'); }
      }
      try { journal.finish?.(); }
      catch { result.warnings.push('账号已切换，下次切换时将核对并清理恢复记录'); }
      return result;
    } catch (error) {
      let preferenceError = '';
      if (undoPreference) {
        try { undoPreference(); }
        catch { preferenceError = '；未能恢复原活动账号标记'; }
      }
      if (journal.hasMutations()) {
        try {
          journal.restore();
        } catch (rollbackError) {
          const baseMsg = (error as Error).message;
          const restoreMsg = (rollbackError as Error).message;
          if (!baseMsg.includes('恢复原登录状态未完成')) {
            throw new Error(`${baseMsg}；且恢复原登录状态未完成：${restoreMsg}${preferenceError}`);
          }
        }
      }
      if (preferenceError) throw new Error(`${(error as Error).message}${preferenceError}`);
      throw error;
    }
  });
}

export interface RemovalPreview {
  agent: string; profile: string; profiles: string[]; current: boolean; logoutUnsupported?: string;
  identity?: string; signature: string; liveRevision?: string;
}

function safeProfileRevision(agent: BaseAgent, dir: string): string {
  try { return agent.identity(dir)?.id || credentialState(agent, dir).revision || 'empty'; }
  catch {
    const raw = agent.authFiles.map(f => {
      const p = path.join(dir, f);
      try { return fs.existsSync(p) && fs.lstatSync(p).isFile() ? fs.readFileSync(p).toString('base64') : ''; } catch { return 'err'; }
    });
    return `corrupt:${fingerprint(JSON.stringify(raw))}`;
  }
}

function removalPreview(agent: BaseAgent, name: string): RemovalPreview {
  if (!profileExists(agent.id, name)) throw new Error('账号不存在');
  const identity = safeIdentity(agent, profileDir(agent.id, name));
  const profiles = listProfiles(agent.id).filter(profile => profile === name ||
    !!identity && safeIdentity(agent, profileDir(agent.id, profile))?.id === identity.id);
  const states = profiles.map(profile => {
    const dir = profileDir(agent.id, profile), stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) throw new Error('账号目录无效');
    const confirmedFiles = [stagedFileName(agent)];
    const allowed = [...agent.authFiles, ...confirmedFiles, '_meta.json', 'config.toml', 'settings.json', 'settings.local.json'];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!allowed.includes(entry.name) || !entry.isFile()) throw new Error(`「${profile}」含非账号管理文件，已保留，请先核对`);
    }
    const revisions = confirmedFiles.map(name => {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? fingerprint(fs.readFileSync(file).toString('base64')) : null;
    });
    return [profile, stat.dev, stat.ino, stat.birthtimeMs, safeProfileRevision(agent, dir), ...revisions];
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
  return withProfileCredentialLocks([{ agent, profile: name }], async () => {
    if (options.logout) await assertLogoutReady(agent);
    const latest = removalPreview(agent, name);
    if (latest.signature !== expected.signature || latest.identity !== expected.identity) throw new Error('账号或备份范围已变化，请重新核对后删除');
    if (options.logout && (!expected.current || !latest.current || latest.liveRevision !== expected.liveRevision || latest.logoutUnsupported)) {
      throw new Error(latest.logoutUnsupported || '客户端当前账号已变化，未退出或删除，请重新核对');
    }
    if (options.logout) clearClientCredentials(agent, latest.identity!, expected.liveRevision);
    const formerTokens = latest.profiles.flatMap(profile => {
      const dir = profileDir(agent.id, profile);
      try { return [extractRefreshToken(agent.readCredentials(dir)[agent.authFiles[0]]), extractRefreshToken(readStagedBytes(agent, dir))]; }
      catch { return []; }
    });
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
    if (latest.identity) discardUnusedQuota(agent, latest.identity, formerTokens);
    return { ok: true, removed, loggedOut: options.logout === true };
  });
}

export async function renameAccount(agent: BaseAgent, oldName: string, newName: string) {
  return withStoreLock(async () => {
    validateName(newName);
    const existingProfiles = listProfiles(agent.id);
    if (!existingProfiles.includes(oldName)) throw new Error('账号不存在');
    if (oldName === newName) return { ok: true, name: newName };
    if (existingProfiles.some(p => p !== oldName && sameProfileName(p, newName))) throw new Error('该名称已被使用');
    const source = profileDir(agent.id, oldName);
    const destination = profileDir(agent.id, newName);
    const meta = readProfileMeta(agent.id, oldName);
    const wasPreferred = getActiveProfile(agent.id) === oldName;
    const isCaseOnly = sameProfileName(oldName, newName);
    const hop = isCaseOnly ? path.join(path.dirname(source), `.rename-${randomUUID()}`) : undefined;
    setInProcessRename(isCaseOnly);
    try {
      const move = (from: string, to: string, recordPending = false) => {
        if (!hop) { fs.renameSync(from, to); return; }
        if (recordPending) {
          atomicWrite(PENDING_RENAME_FILE, JSON.stringify({
            agentId: agent.id,
            oldName,
            newName,
            hopName: path.basename(hop),
            wasPreferred,
            hadLabel: Boolean(meta.label),
            oldLabel: meta.label,
          }));
        }
        try {
          fs.renameSync(from, hop);
        } catch (error) {
          if (recordPending) fs.rmSync(PENDING_RENAME_FILE, { force: true });
          throw error;
        }
        try {
          fs.renameSync(hop, to);
        } catch (error) {
          try {
            fs.renameSync(hop, from);
            if (recordPending) fs.rmSync(PENDING_RENAME_FILE, { force: true });
          } catch {
            throw new Error(`${(error as Error).message}；且原目录名恢复未完成（临时目录：${path.basename(hop)}）`);
          }
          throw error;
        }
      };
      move(source, destination, true);
      try {
        if (meta.label) writeProfileMeta(agent.id, newName, { ...meta, label: newName });
        if (wasPreferred) setActiveProfile(agent.id, newName);
        if (isCaseOnly) fs.rmSync(PENDING_RENAME_FILE, { force: true });
      } catch (error) {
        move(destination, source, false);
        if (meta.label) writeProfileMeta(agent.id, oldName, meta);
        if (wasPreferred && getActiveProfile(agent.id) !== oldName) setActiveProfile(agent.id, oldName);
        if (isCaseOnly) fs.rmSync(PENDING_RENAME_FILE, { force: true });
        throw error;
      }
      return { ok: true, name: newName };
    } finally {
      if (isCaseOnly) setInProcessRename(false);
    }
  });
}

export interface CredentialUpdateTarget { agent: string; profile: string; identity: Identity; revision?: string }
export function credentialUpdateTarget(agent: BaseAgent, name: string, options: { allowStaged?: boolean } = {}): CredentialUpdateTarget {
  if (!profileExists(agent.id, name)) throw new Error('账号不存在，请重新选择');
  const dir = profileDir(agent.id, name);
  const identity = agent.identity(dir);
  if (!identity) throw new Error('无法确认原账号身份，不能替换凭据');
  const revision = credentialState(agent, dir).revision;
  if (fs.lstatSync(stagedFilePath(agent, dir), { throwIfNoEntry: false })) {
    if (!options.allowStaged) throw new Error('此账号已有待验证凭据，请刷新验证或使用「重新登录」');
    return { agent: agent.id, profile: name, identity, revision };
  }
  const live = liveCache.get(agent.id);
  const status = live?.identity === identity.id && live.status.credentialRevision === revision &&
    isSameIdentity(safeIdentity(agent), identity) && live.status.credentialRevision === credentialState(agent).revision
    ? live.status : readProfileMeta(agent.id, name).snapshot;
  if (status?.credentialRevision && status.credentialRevision !== revision) throw new Error('账号凭据已变化，请刷新后重试');
  const authUnresolved = status?.state === 'error' && ['authentication-rejected', 'account-unavailable', 'quota-recovery-required'].includes(status.authFailure || '');
  if (!status?.authExpired && status?.state !== 'expired' && !authUnresolved) throw new Error('此账号当前未标记为认证异常，请刷新后重试');
  return { agent: agent.id, profile: name, identity, revision };
}

export function availableCredentialUpdateTarget(agent: BaseAgent, name: string, options: { allowStaged?: boolean } = {}): CredentialUpdateTarget | undefined {
  try { return credentialUpdateTarget(agent, name, options); }
  catch { return undefined; }
}

export async function updateAccountCredentials(
  target: CredentialUpdateTarget,
  source: string | CredentialFiles,
  validateLogin?: () => void,
  options: { trusted?: boolean } = {},
) {
  const agent = resolveAgent(target.agent);
  return withProfileCredentialLocks([{ agent, profile: target.profile }], async () => {
    validateLogin?.();
    return (await replaceAccountCredentialsLocked(target, source, options)).result;
  });
}

/**
 * Caller holds the identity lock followed by the store lock.
 * Official isolated browser re-login (`trusted: true`) updates directly;
 * external untrusted credentials (`trusted !== true`) are staged in `.pending`
 * without touching the pool or live login until server verification binds user + workspace.
 */
export async function replaceAccountCredentialsLocked(target: CredentialUpdateTarget, source: string | CredentialFiles, options: { trusted?: boolean; importWriter?: CredentialWriter; sourceFiles?: CredentialFiles } = {}) {
  const agent = resolveAgent(target.agent);
  const current = credentialUpdateTarget(agent, target.profile, { allowStaged: options.trusted === true });
  if (!isSameIdentity(current.identity, target.identity)) throw new Error('原账号已变化，请重新选择');
  if (current.revision !== target.revision) throw new Error('原账号凭据已变化，请重新选择');
  const files = typeof source === 'string' ? options.sourceFiles ?? agent.readCredentials(source) : source;
  const incoming = typeof source === 'string' ? agent.identity(source, files) : agent.identityFromBytes(files[agent.authFiles[0]]);
  if (!incoming) throw new Error(`${agent.label} 没有可用的认证凭据`);
  if (!isSameIdentity(current.identity, incoming)) throw new Error('凭据不属于此账号或工作区，未进行更新');
  const dir = profileDir(agent.id, target.profile);
  const originalBytes = agent.readCredentials(dir)[agent.authFiles[0]];
  const meta = readProfileMeta(agent.id, target.profile);
  const originalSnapshot = quotaSnapshot(agent, current.revision, meta.email, current.identity.email, meta.snapshot);
  const previousStaged = readStagedBytes(agent, dir);
  const previousStagedRevision = previousStaged && credentialStateFromFiles(agent.id, [[agent.authFiles[0], previousStaged]]).revision;
  const consumed = consumedLogin(meta.snapshot, originalBytes, current.revision, previousStagedRevision || undefined);
  if (consumed && extractRefreshToken(files[agent.authFiles[0]]) === extractRefreshToken(originalBytes)) {
    throw new Error('此续期凭据已被消耗，请重新授权后使用新的凭据');
  }

  if (!options.trusted) {
    if (agent.bindsQuotaEmail && differentEmail(meta.email, incoming.email)) {
      throw new Error('凭据与原账号登记的邮箱不符，已保留原凭据');
    }
    if (!agent.canVerifyReplacement(originalBytes)) {
      throw new Error('无法验证此外部凭据与原账号及工作区的绑定关系，已保留原凭据；请使用「重新登录」完成官方授权');
    }
    const candidateBytes = files[agent.authFiles[0]];
    const stagedRev = credentialStateFromFiles(agent.id, [[agent.authFiles[0], candidateBytes]]).revision;
    const snapshot: StatusResult = {
      ...originalSnapshot, available: true, account: incoming.email || meta.email,
      state: 'unverified', authExpired: false, extra: '待通过官方服务验证凭据归属后生效', checkedAt: undefined,
      refreshFailures: undefined, creditActivity: undefined, spareActivity: undefined,
      credentialRevision: stagedRev, stagedReplacement: true, authFailure: undefined,
    };
    const stagedName = stagedFileName(agent);
    const previousMeta = readBuffer(path.join(dir, '_meta.json'));
    replaceFiles(dir, {
      [stagedName]: candidateBytes,
      '_meta.json': Buffer.from(JSON.stringify({ ...meta, stagedCheck: undefined, email: meta.email || incoming.email, snapshot: consumed || snapshot }, null, 2)),
    }, options.importWriter);
    return {
      result: { ok: true, agent: agent.id, profile: target.profile, staged: true, warning: undefined },
      rollback() {
        replaceFiles(dir, { [stagedName]: previousStaged, '_meta.json': previousMeta });
      },
    };
  }

  const isLive = agent.management().canSaveCurrent && isSameIdentity(safeIdentity(agent), current.identity) &&
    credentialState(agent).revision === current.revision;
  const snapshot: StatusResult = {
    ...originalSnapshot, available: true, account: incoming.email || meta.email,
    state: 'unverified', authExpired: false, extra: undefined, checkedAt: undefined,
    refreshFailures: undefined, creditActivity: undefined, spareActivity: undefined,
    credentialRevision: credentialStateFromFiles(agent.id, Object.entries(files)).revision, stagedReplacement: undefined, authFailure: undefined,
    refreshConsumed: undefined, consumedRefreshFingerprint: undefined,
  };
  const stagedName = stagedFileName(agent);
  const originalMetaBytes = isLive && !agent.writeRenewedCredentials ? readBuffer(path.join(dir, '_meta.json')) : undefined;
  const savedMeta = { ...meta, stagedCheck: undefined, pendingLiveRevision: isLive ? current.revision : undefined, email: incoming.email || meta.email, snapshot };
  replaceFiles(dir, { ...files, [stagedName]: null, '_meta.json': Buffer.from(JSON.stringify(savedMeta, null, 2)) });
  let warning: string | undefined;
  if (isLive) {
    try { warning = await applyVerifiedLiveCredential(agent, files, current.revision); }
    catch (error) {
      // A failed file replacement left the original client login intact. The official login
      // directory still holds the new grant for retry until the trusted update succeeds.
      if (originalMetaBytes !== undefined && credentialState(agent).revision === current.revision) {
        replaceFiles(dir, { [agent.authFiles[0]]: originalBytes, [stagedName]: previousStaged, '_meta.json': originalMetaBytes });
        throw error;
      }
      warning = pendingClientSync;
    }
  }
  if (isLive && !warning) writeProfileMeta(agent.id, target.profile, { ...savedMeta, pendingLiveRevision: undefined });
  if (isLive) liveCache.delete(agent.id);
  const oldTokens = [extractRefreshToken(originalBytes), extractRefreshToken(previousStaged)];
  discardUnusedQuota(agent, current.identity.id, oldTokens, target.profile, extractRefreshToken(files[agent.authFiles[0]]));
  return { result: { ok: true, agent: agent.id, profile: target.profile, warning } };
}

const pendingClientSync = '账号池凭据已更新，客户端登录尚未同步。请切换到此账号以应用新凭据。';
async function applyVerifiedLiveCredential(agent: BaseAgent, files: CredentialFiles, expected?: string) {
  if (!expected || credentialState(agent).revision !== expected) return pendingClientSync;
  if (agent.writeRenewedCredentials) await agent.writeRenewedCredentials(files, expected);
  else agent.writeCredentials(agent.homeDir, files);
}

function discardUnusedQuota(agent: BaseAgent, id: string, oldTokens: (string | undefined)[], replaced?: string, currentToken?: string) {
  try {
    // An unreadable profile may still hold the grant. Preserve any recovery evidence.
    for (const name of listProfiles(agent.id, { includeInvalid: true })) {
      if (name === replaced) continue;
      const copy = agent.identity(profileDir(agent.id, name));
      if (!copy || copy.id === id) return;
    }
    discardSupersededQuota(agent.id, id, oldTokens, replaced !== undefined, currentToken);
  } catch { stepDiagnostic('storage-unavailable'); }
}

function stagedQuotaSnapshot(snapshot: StatusResult | undefined, revision: string | undefined, deferred: ProfileMeta['stagedCheck']): StatusResult {
  const checkedAt = deferred?.revision === revision ? deferred?.checkedAt : undefined;
  return { ...snapshot, available: true, state: 'unverified', stagedReplacement: true, checkedAt: checkedAt || snapshot?.checkedAt,
    extra: checkedAt ? (deferred?.sourcesUnavailable ? nativeSourcesUnknown : stagedClientBusy) : snapshot?.extra };
}

export function dashboard() {
  const now = Date.now();
  const intervals = readRefreshIntervals();
  return ALL_AGENTS.map(agent => {
    const management = agent.management();
    const versioned = agent.usesCredentialRevisions;
    const profiles = listProfiles(agent.id, { includeInvalid: true }).map(name => {
      let meta: ProfileMeta = {};
      try { meta = readProfileMeta(agent.id, name); } catch {}
      const stored = meta.snapshot;
      let saved: Identity | undefined, snapshot: StatusResult | undefined;
      try {
        const dir = profileDir(agent.id, name);
        if (versioned) {
          const bytes = agent.readCredentials(dir)[agent.authFiles[0]];
          saved = agent.identityFromBytes(bytes);
          if (!saved) throw new Error('账号池凭据缺失或格式异常，请检查文件或从备份恢复');
          const staged = readStagedBytes(agent, dir);
          const effectiveBytes = staged ?? bytes;
          const revision = credentialStateFromFiles(agent.id, [[agent.authFiles[0], effectiveBytes]]).revision;
          snapshot = quotaSnapshot(agent, revision, meta.email, saved.email, stored, !management.quota);
          if (staged) snapshot = stagedQuotaSnapshot(snapshot, revision, meta.stagedCheck);
        } else {
          saved = agent.identity(dir);
          snapshot = agent.credentialStatus(dir);
        }
      } catch (error) {
        const plan = conflictingQuotaEmail(meta.email, saved?.email, stored) ? undefined : stored?.plan || stored?.quota?.plan;
        snapshot = { available: false, account: meta.email, plan, state: 'error', extra: (error as Error).message };
      }
      return { name, meta: { ...meta, email: meta.email || saved?.email, snapshot }, stored, saved };
    });
    const switchUnsupported = agent.switchSupport();
    let active: string | undefined, liveId: string | undefined, status: StatusResult;
    try {
      const desktop = agent.sharedQuotaLogin?.desktopLogin();
      const liveFiles = desktop ? { [agent.authFiles[0]]: desktop } : versioned ? agent.readCredentials() : undefined;
      const identity = agent.identity(agent.homeDir, liveFiles);
      liveId = identity?.id;
      const revision = identity && liveFiles && credentialStateFromFiles(agent.id, Object.entries(liveFiles)).revision;
      const matches = profiles.filter(p => isSameIdentity(identity, p.saved) &&
        (!p.meta.pendingLiveRevision || revision === p.stored?.credentialRevision)).map(p => p.name);
      if (management.canSaveCurrent && !switchUnsupported && matches.length) active = preferredMatch(agent, matches, revision);
      if (versioned) {
        const live = liveCache.get(agent.id);
        const activeProfileEntry = profiles.find(p => p.name === active);
        const activeHasStaged = activeProfileEntry?.meta.snapshot?.stagedReplacement;
        const cached = currentQuotaSnapshot(revision, activeHasStaged ? undefined : activeProfileEntry?.stored,
          live && identity?.id === live.identity ? live.status : undefined);
        const registered = activeProfileEntry?.meta.email;
        let history = cached;
        if (desktop && cached?.credentialRevision !== revision) {
          const plan = cached?.plan || cached?.quota?.plan;
          history = !management.quota && plan && !conflictingQuotaEmail(registered, identity?.email, cached)
            ? { available: true, account: identity?.email, plan } : undefined;
        }
        status = (identity && quotaSnapshot(agent, revision, registered, identity.email, history, !management.quota)) || {
            available: !!identity, account: identity?.email, state: identity ? 'unverified' : 'signed-out', extra: switchUnsupported,
          };
      } else {
        status = agent.credentialStatus();
      }
    } catch (error) { status = { available: false, state: 'error', extra: (error as Error).message }; }
    return {
      id: agent.id, label: agent.label, active, status, management, switchUnsupported,
      refreshPeriods: { live: refreshPeriodMs[intervals.live], spare: refreshPeriodMs[intervals.spare] },
      ...quotaRefreshTimes(status, intervals.live, liveId || agent.id, false, now),
      profiles: profiles.map(({ name, meta, saved }) => ({ name, meta, isActive: name === active,
        ...quotaRefreshTimes(meta.snapshot, name === active ? intervals.live : intervals.spare, saved?.id || name, name !== active, now) })),
    };
  });
}

async function hasRunningLiveSession(agent: BaseAgent): Promise<boolean | 'unknown'> {
  try {
    const busy = (await runningClients(agent.id, { failClosed: true })).length > 0 || !!(await agent.sharedSessionIssue());
    if (busy) stepDiagnostic('live-session');
    return busy;
  } catch {
    stepDiagnostic('process-unknown');
    return 'unknown'; // Protect the login without starting another shared client.
  }
}

function appendRecoveryNotice(base: string | undefined, dirs: string[]): string {
  const missing = dirs.filter(d => !base?.includes(d));
  if (!missing.length) return base || '';
  const notice = `未写回的凭据已保留在 ${missing.join('、')}，恢复前请勿清理该目录`;
  return base ? `${base}；${notice}` : notice;
}

// A failed commit cannot advance checkedAt on disk. Retain its actual error for
// the minimum query interval, including manual requests for the same generation.
function checkRefreshWriteFailure(agent: BaseAgent, identity: Identity | undefined, revision?: string, email?: string, verifyFrom?: string): string {
  const now = Date.now();
  for (const [key, failure] of refreshWriteFailures) {
    if (now - failure.at >= MIN_REFRESH_INTERVAL_MS) refreshWriteFailures.delete(key);
  }
  const key = JSON.stringify([agent.id, identity?.id, revision, email ?? identity?.email, verifyFrom]);
  const failure = refreshWriteFailures.get(key);
  if (failure) {
    stepDiagnostic('cooldown');
    throw new Error(failure.message);
  }
  return key;
}

function rememberRefreshWriteFailure(key: string, error: unknown): void {
  if (error instanceof Error) refreshWriteFailures.set(key, { at: Date.now(), message: error.message });
}

function consumedLogin(status: StatusResult | undefined, bytes: Buffer | null, revision?: string, stagedRevision?: string): StatusResult | undefined {
  if (!status?.refreshConsumed || !revision) return;
  const token = extractRefreshToken(bytes);
  if (!token) return;
  const digest = fingerprint(token);
  // Older pending snapshots copied the original consumed flag to the staged file's revision.
  const legacyPending = stagedRevision && status.stagedReplacement && status.credentialRevision === stagedRevision;
  const matches = status.consumedRefreshFingerprint ? status.consumedRefreshFingerprint === digest :
    (status.state === 'expired' && status.credentialRevision === revision) || legacyPending;
  if (!matches) return;
  return { ...status, state: 'expired', authExpired: true, credentialRevision: revision, stagedReplacement: undefined,
    consumedRefreshFingerprint: digest };
}

function clientCredentialMatch(agent: BaseAgent, credentials: Array<Buffer | null>, quotaCopies?: Buffer[]): 'shared' | 'other-login' | 'unknown' | undefined {
  if (!agent.management().canSaveCurrent) return;
  try {
    const copies = agent.readClientCopies();
    let match: 'shared' | 'other-login' | undefined;
    for (const bytes of credentials) {
      const identity = agent.identityFromBytes(bytes);
      const token = extractRefreshToken(bytes);
      for (const copy of copies) {
        const sameIdentity = isSameIdentity(identity, agent.identityFromBytes(copy));
        const sameToken = token && token === extractRefreshToken(copy);
        if (!sameToken && !sameIdentity) continue;
        if (!sameToken && agent.sharedQuotaLogin) {
          match ??= 'other-login';
          continue;
        }
        if (!quotaCopies) return 'shared';
        match = 'shared';
        if (sameIdentity && sameToken && copy) quotaCopies.push(copy);
      }
    }
    return match;
  } catch {
    return agent.sharedQuotaLogin ? 'unknown' : 'shared';
  }
}

async function verifyStagedProfileCredential(agent: BaseAgent, name: string, lockedIdentity: string | undefined, sourcesUnavailable = false): Promise<StatusResult | undefined> {
  const targetDir = profileDir(agent.id, name);
  const snapshot = await withStoreLock(async () => {
    if (!profileExists(agent.id, name)) throw new Error('账号不存在');
    const staged = readStagedBytes(agent, targetDir);
    if (!staged) return undefined;
    const original = agent.readCredentials(targetDir)[agent.authFiles[0]];
    const preIdentity = agent.identityFromBytes(original);
    if (!preIdentity || preIdentity.id !== lockedIdentity) throw new CredentialChangedError();
    const originalRevision = credentialStateFromFiles(agent.id, [[agent.authFiles[0], original]]).revision;
    const stagedRevision = credentialStateFromFiles(agent.id, [[agent.authFiles[0], staged]]).revision;
    const meta = readProfileMeta(agent.id, name);
    const consumed = consumedLogin(meta.snapshot, original, originalRevision, stagedRevision);
    return { staged, original, preIdentity, originalRevision, stagedRevision, meta, consumed };
  });
  if (!snapshot) return undefined;

  const backendIssue = agent.switchSupport();
  const shared = sourcesUnavailable ? 'unknown' : !backendIssue && clientCredentialMatch(agent, [snapshot.original, snapshot.staged]);
  if (backendIssue || shared === 'unknown' || shared && await hasRunningLiveSession(agent)) {
    return withStoreLock(async () => {
      if (!profileExists(agent.id, name) ||
          credentialState(agent, targetDir).revision !== snapshot.originalRevision ||
          !readStagedBytes(agent, targetDir)?.equals(snapshot.staged)) throw new CredentialChangedError();
      const meta = readProfileMeta(agent.id, name);
      const checkedAt = new Date().toISOString();
      const deferredStatus: StatusResult = {
        ...meta.snapshot,
        available: true,
        account: snapshot.preIdentity?.email || meta.email,
        state: 'unverified',
        authExpired: false,
        refreshConsumed: undefined, consumedRefreshFingerprint: undefined,
        stagedReplacement: true,
        credentialRevision: snapshot.stagedRevision,
        extra: backendIssue || (shared === 'unknown' ? nativeSourcesUnknown : stagedClientBusy),
        checkedAt,
      };
      writeProfileMeta(agent.id, name, { ...meta, snapshot: snapshot.consumed || deferredStatus,
        stagedCheck: snapshot.stagedRevision ? { revision: snapshot.stagedRevision, checkedAt, sourcesUnavailable: shared === 'unknown' || undefined } : undefined });
      resultDiagnostic(backendIssue ? 'unsupported' : 'waiting', meta.snapshot?.fetchedAt);
      return deferredStatus;
    });
  }

  const repeatsConsumed = snapshot.consumed && extractRefreshToken(snapshot.staged) === extractRefreshToken(snapshot.original);
  if (!repeatsConsumed) assertRefreshWriteReady(path.join(targetDir, agent.authFiles[0]));
  const failureKey = checkRefreshWriteFailure(agent, snapshot.preIdentity, snapshot.stagedRevision, snapshot.meta.email, snapshot.originalRevision);
  const query: CredentialQuery = repeatsConsumed ? { status: { available: true, extra: '待验证的续期凭据已被消耗，请重新授权' } }
    : await agent.queryCredential!(snapshot.staged, { allowRefresh: true, verifyTarget: snapshot.original, expectedEmail: snapshot.meta.email });
  const replacementRefresh = extractRefreshToken(query.rotated ?? null);
  if (replacementRefresh && replacementRefresh !== extractRefreshToken(snapshot.staged)) stepDiagnostic('rotation');
  if (query.temporaryDirectory) stepDiagnostic('pending-commit');
  try {
    return await criticalCommitTracker(() => withStoreLock(async () => {
      if (!profileExists(agent.id, name)) {
        if (!query.rotated && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
        throw new Error('账号不存在');
      }
      const currentOriginal = agent.readCredentials(targetDir)[agent.authFiles[0]];
      const currentStaged = readStagedBytes(agent, targetDir);
      if ((agent.bindsQuotaEmail && readProfileMeta(agent.id, name).email !== snapshot.meta.email) ||
          credentialStateFromFiles(agent.id, [[agent.authFiles[0], currentOriginal]]).revision !== snapshot.originalRevision ||
          credentialStateFromFiles(agent.id, [[agent.authFiles[0], currentStaged]]).revision !== snapshot.stagedRevision) {
        throw new CredentialChangedError();
      }
      const stagedName = stagedFileName(agent);
      if (query.verifiedReplacement && query.status.state === 'ok' && query.rotated) {
        const liveBusy = await hasRunningLiveSession(agent);
        const isLiveSame = agent.management().canSaveCurrent &&
          isSameIdentity(safeIdentity(agent), snapshot.preIdentity) &&
          credentialState(agent).revision === snapshot.originalRevision;
        const newRev = credentialStateFromFiles(agent.id, [[agent.authFiles[0], query.rotated]]).revision;
        const committedStatus: StatusResult = {
          ...query.status, credentialRevision: newRev, stagedReplacement: undefined, checkedAt: new Date().toISOString(),
        };
        const meta = readProfileMeta(agent.id, name);
        const postIdentity = agent.identityFromBytes(query.rotated) || snapshot.preIdentity;
        stepDiagnostic('credential-write');
        replaceFiles(targetDir, {
          [agent.authFiles[0]]: query.rotated,
          [stagedName]: null,
          '_meta.json': Buffer.from(JSON.stringify({ ...meta, stagedCheck: undefined, pendingLiveRevision: isLiveSame ? snapshot.originalRevision : undefined, email: postIdentity?.email || meta.email, snapshot: committedStatus }, null, 2)),
        });
        try {
          if (isLiveSame) {
            const warning = liveBusy ? pendingClientSync : await applyVerifiedLiveCredential(agent, { [agent.authFiles[0]]: query.rotated }, snapshot.originalRevision).catch(() => pendingClientSync);
            if (warning) committedStatus.extra = warning;
            else {
              writeProfileMeta(agent.id, name, { ...readProfileMeta(agent.id, name), pendingLiveRevision: undefined });
              if (postIdentity) liveCache.set(agent.id, { identity: postIdentity.id, status: committedStatus });
            }
          }
          await syncCopies(agent, targetDir, { previousRevision: snapshot.originalRevision, strict: false, expectedRevision: newRev,
            upgradedFrom: snapshot.preIdentity ? { id: snapshot.preIdentity.id, revision: snapshot.originalRevision } : undefined });
        } catch {
          committedStatus.extra ??= '账号池凭据已更新，账号副本尚未全部同步。';
        } finally {
          if (query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
        }
        return committedStatus;
      }
      if (!query.rotated && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
      const baseExtra = query.status.extra || '未能验证新凭据属于原账号与工作区，已保留原凭据；请使用「重新登录」完成官方授权';
      const extra = query.rotated && query.temporaryDirectory
        ? appendRecoveryNotice(baseExtra, [query.temporaryDirectory])
        : baseExtra;
      const meta = readProfileMeta(agent.id, name);
      const previous = snapshot.meta.snapshot;
      const originalHistory = previous && (previous.credentialRevision === snapshot.originalRevision || previous.credentialRevision === snapshot.stagedRevision)
        && !conflictingQuotaEmail(meta.email, snapshot.preIdentity?.email, previous) ? previous : undefined;
      const failedStatus: StatusResult = {
        ...snapshot.consumed,
        ...reportedQuotaHistory(originalHistory),
        available: true,
        account: snapshot.preIdentity?.email || meta.email,
        state: 'expired',
        authExpired: true,
        stagedReplacement: undefined,
        extra: [extra, snapshot.consumed?.extra].filter(Boolean).join('；'),
        checkedAt: new Date().toISOString(),
        credentialRevision: snapshot.originalRevision,
      };
      replaceFiles(targetDir, {
        [stagedName]: null,
        '_meta.json': Buffer.from(JSON.stringify({ ...meta, stagedCheck: undefined, snapshot: failedStatus }, null, 2)),
      });
      return failedStatus;
    }));
  } catch (error) {
    if (query.rotated && query.temporaryDirectory && fs.existsSync(query.temporaryDirectory) && error instanceof Error) {
      error.message = appendRecoveryNotice(error.message, [query.temporaryDirectory]);
    }
    rememberRefreshWriteFailure(failureKey, error);
    throw error;
  }
}

function assertRefreshWriteReady(file: string): void {
  try { assertCredentialWriteReady(file); }
  catch (error) { stepDiagnostic('storage-unavailable'); throw error; }
}

export function refreshAccount(agent: BaseAgent, name?: string, force = false, automatic?: 'automatic' | 'on-open'): Promise<StatusResult> {
  if (!agent.management().quota) {
    if (name && !profileExists(agent.id, name)) return Promise.reject(new Error('账号不存在'));
    return Promise.resolve().then(() => agent.credentialStatus(name ? profileDir(agent.id, name) : agent.homeDir));
  }
  const requested = name ? profileDir(agent.id, name) : agent.homeDir;
  const staged = name ? readStagedBytes(agent, requested) : null;
  const shared = agent.sharedQuotaLogin;
  const desktop = shared?.desktopLogin();
  const file = agent.authFiles[0];
  // A file-only observation is scoped to this refresh. Mutations still read the complete native login.
  const readView = (dir: string, quotaCopies?: Buffer[]): CredentialFiles | undefined => {
    if (desktop && shared && dir === agent.homeDir) return { [file]: shared.confirmDesktopLogin(desktop, quotaCopies) };
  };
  const identityAt = (dir: string) => {
    const view = readView(dir);
    return view ? agent.identity(dir, view) : safeIdentity(agent, dir);
  };
  const revisionAt = (dir: string) => {
    const view = readView(dir);
    return (view ? credentialStateFromFiles(agent.id, Object.entries(view)) : credentialState(agent, dir)).revision;
  };
  const identity = agent.identity(requested, desktop && !name ? { [file]: desktop } : undefined);
  const usesLiveLogin = () => {
    if (!name) return true;
    if (staged || !identity) return false;
    let liveFiles: CredentialFiles;
    try { liveFiles = readView(agent.homeDir) ?? agent.readCredentials(); } catch { return false; }
    if (agent.identity(agent.homeDir, liveFiles)?.id !== identity.id) return false;
    if (credentialStateFromFiles(agent.id, Object.entries(liveFiles)).revision === credentialState(agent, requested).revision) return true;
    return !readProfileMeta(agent.id, name).pendingLiveRevision && name === preferredMatch(agent, matchingProfiles(agent, identity));
  };
  const isLive = usesLiveLogin();
  const dir = isLive ? agent.homeDir : requested;
  const dedupRev = staged
    ? credentialStateFromFiles(agent.id, [[agent.authFiles[0], staged]]).revision
    : revisionAt(dir);
  const fileOnly = Boolean(desktop && isLive);
  const key = JSON.stringify([agent.id, name, dir, dedupRev, Boolean(staged), fileOnly, automatic, force]);
  const pending = pendingQueries.get(key);
  if (pending) return pending;
  const supersededEntries: Array<{ dir: string; rotatedRevision?: string; rotatedToken?: string }> = [];
  const reconcileSuperseded = (persistedRevision: string | undefined, persistedFreshRotation: boolean, retryInput?: string): string[] => {
    const retained: typeof supersededEntries = [];
    for (const entry of supersededEntries) {
      const successor = persistedFreshRotation && (!shared || Boolean(entry.rotatedToken && entry.rotatedToken === retryInput));
      if (successor || (entry.rotatedRevision && persistedRevision === entry.rotatedRevision)) {
        releaseTemporaryCredentials(entry.dir);
      } else {
        retained.push(entry);
      }
    }
    supersededEntries.length = 0;
    supersededEntries.push(...retained);
    return retained.map(entry => entry.dir);
  };
  const persistNotice = async (profile: string | undefined, status: StatusResult) => {
    await withStoreLock(async () => {
      if (profile && profileExists(agent.id, profile)) {
        const meta = readProfileMeta(agent.id, profile);
        writeProfileMeta(agent.id, profile, { ...meta, snapshot: status });
      }
      if (isLive && identity) liveCache.set(agent.id, { identity: identity.id, status });
    });
  };
  const run = async () => {
    const intervals = readRefreshIntervals();
    const interval = isLive ? intervals.live : intervals.spare;
    const onOpen = automatic === 'on-open';
    const dueAt = (cached?: StatusResult) => {
      if (force && !onOpen) return Date.parse(cached?.checkedAt || '') + MIN_REFRESH_INTERVAL_MS;
      const times = quotaRefreshTimes(cached, interval, identity?.id || name || agent.id, !isLive);
      return onOpen ? times.hotRefreshAt : times.refreshAt;
    };
    const stagedNow = name && readStagedBytes(agent, requested);
    if ((onOpen && stagedNow) || (interval === 'manual' && (!force || automatic))) {
      const live = isLive && liveCache.get(agent.id);
      const meta = name ? readProfileMeta(agent.id, name) : undefined;
      const cached = currentQuotaSnapshot(dedupRev, meta?.snapshot, live && live.identity === identity?.id ? live.status : undefined);
      const status: StatusResult = { available: !!identity, account: identity?.email, state: identity ? 'unverified' : 'signed-out' };
      const snapshot = quotaSnapshot(agent, dedupRev, meta?.email, identity?.email, cached) ?? status;
      return stagedNow ? stagedQuotaSnapshot(snapshot, dedupRev, meta?.stagedCheck) : snapshot;
    }
    if (name && stagedNow) {
      const stagedResult = await verifyStagedProfileCredential(agent, name, identity?.id, Boolean(desktop));
      if (stagedResult) return stagedResult;
    }
    if (staged) throw new CredentialChangedError();
    try {
      for (let attempt = 0; ; attempt++) {
        const snapshot = await withStoreLock(async () => {
          if (name && !profileExists(agent.id, name)) throw new Error('账号不存在');
          if (identityAt(requested)?.id !== identity?.id || usesLiveLogin() !== isLive) throw new CredentialChangedError();
          const profile = name || (fileOnly && identity
            ? preferredMatch(agent, matchingProfiles(agent, identity)) : activeProfile(agent));
          if (isLive && identity && !fileOnly && shared) {
            await syncCopies(agent, agent.homeDir, { strict: false, liveProfile: profile });
          }
          const quotaCopies: Buffer[] = [];
          let original = (readView(dir, quotaCopies) ?? (agent.readCredentials(dir, quotaCopies)))[file];
          if (agent.identityFromBytes(original, isLive)?.id !== identity?.id) throw new CredentialChangedError();
          let pendingQuota = false;
          let recoveryReadOnly = false;
          let codexRecovered = false;
          if (original && identity && (agent.canRecoverQuotaRotation || (shared && !isLive && name))) {
            if (!isLive && name && readStagedBytes(agent, dir)) throw new CredentialChangedError();
            try {
              if (shared) {
                const recovered = shared.recoverProfileCredential(dir, identity.id, original);
                pendingQuota = recovered.pending;
                recoveryReadOnly = recovered.readOnly;
                original = recovered.bytes;
              } else {
                const plan = codexQuotaRecovery(agent, dir, profile, identity.id, original);
                if (plan) {
                  if (isLive && plan.changed && await hasRunningLiveSession(agent)) {
                    const busy = new PendingQuotaConflict(false);
                    busy.message = '客户端正在使用此登录，已保留上次续期结果；请在客户端续期或关闭后刷新';
                    throw busy;
                  }
                  original = plan.apply();
                  codexRecovered = true;
                }
              }
            } catch (error) {
              if (!(error instanceof PendingQuotaConflict)) throw error;
              const revision = credentialStateFromFiles(agent.id, [[file, original]]).revision;
              const saved = profile ? readProfileMeta(agent.id, profile).snapshot : undefined;
              const consumed = consumedLogin(saved, original, revision) ||
                (isLive && liveCache.get(agent.id)?.identity === identity.id ? consumedLogin(liveCache.get(agent.id)?.status, original, revision) : undefined);
              if (consumed) return { blocked: consumed };
              const cached = quotaSnapshot(agent, revision, identity.email, identity.email, saved);
              if (cached?.extra === error.message && dueAt(cached) > Date.now()) {
                stepDiagnostic('cached'); resultDiagnostic('cached', cached.fetchedAt);
                return { blocked: cached };
              }
              const status: StatusResult = { available: true, account: identity.email, credentialRevision: revision, extra: error.message,
                state: error.needsAuthorization ? 'error' : 'unverified', authFailure: error.needsAuthorization ? 'quota-recovery-required' : undefined };
              if (error instanceof ConsumedCodexRotation) Object.assign(status, { state: 'expired', authExpired: true,
                refreshConsumed: true, consumedRefreshFingerprint: fingerprint(extractRefreshToken(original)!) });
              return { blocked: await recordRefresh(agent, dir, profile, isLive, identity, identity, revision, cached, status) };
            }
          }
          const profileFiles = isLive && profile ? agent.readCredentials(profileDir(agent.id, profile)) : undefined;
          const profileState = profileFiles && credentialStateFromFiles(agent.id, Object.entries(profileFiles));
          const sourceState = credentialStateFromFiles(agent.id, [[agent.authFiles[0], original]]);
          const { revision } = sourceState;
          const saved = profileFiles?.[file];
          let separateLogin = !!profileState && ['older', 'unknown'].includes(credentialOrder(sourceState, profileState));
          if (shared && saved && identity) {
            separateLogin = agent.identityFromBytes(saved)?.id !== identity.id || extractRefreshToken(original) !== extractRefreshToken(saved);
          }
          const live = liveCache.get(agent.id);
          const meta = profile ? readProfileMeta(agent.id, profile) : undefined;
          const liveStatus = isLive && live?.identity === identity?.id ? live?.status : undefined;
          const stored = currentQuotaSnapshot(revision, meta?.snapshot, liveStatus);
          const consumed = consumedLogin(stored, original, revision) ||
            (isLive && live?.identity === identity?.id ? consumedLogin(live?.status, original, revision) : undefined);
          const history = fileOnly && stored?.credentialRevision !== revision ? undefined : stored;
          const cached = consumed || quotaSnapshot(agent, revision, meta?.email, identity?.email, history);
          if (shared && saved && original && !original.equals(saved)) quotaCopies.push(saved);
          return { profile, profileRevision: profileState?.revision, separateLogin, original, revision, expectedEmail: meta?.email, cached, quotaCopies, pendingQuota, recoveryReadOnly, codexRecovered };
        });
        if (snapshot.blocked) return snapshot.blocked;
        const { profile, original, revision, cached } = snapshot;
        const failureKey = checkRefreshWriteFailure(agent, identity, revision, snapshot.expectedEmail);
        const clearedRecovery = snapshot.codexRecovered && (cached?.authFailure === 'quota-recovery-required' || cached?.state === 'unverified');
        if (cached && (cached.refreshConsumed || (!clearedRecovery && dueAt(cached) > Date.now()))) {
          stepDiagnostic('cached');
          resultDiagnostic(cached.refreshConsumed ? 'expired' : 'cached', cached.fetchedAt);
          if (supersededEntries.length) {
            const retained = reconcileSuperseded(revision, false);
            if (!retained.length) return cached;
            const noticed = { ...cached, extra: appendRecoveryNotice(cached.extra, retained) };
            await persistNotice(profile, noticed);
            return noticed;
          }
          return cached;
        }
        // A rotation could give an independent older login a newer timestamp than the saved card.
        const copies = shared ? snapshot.quotaCopies : undefined;
        const validSpareBearer = !isLive && original && shared?.quotaBearer(original, [], false);
        const spareBearer = (cached?.plan || snapshot.pendingQuota) && validSpareBearer;
        const independentRead = snapshot.recoveryReadOnly || Boolean(spareBearer) || snapshot.separateLogin;
        const followsCurrent = isLive && !!shared;
        const sharesLogin = desktop ? 'unknown' : followsCurrent ? 'shared' :
          !independentRead && (isLive ? 'shared' : clientCredentialMatch(agent, [original], copies));
        // A separate grant for the same named account can use its own bearer while the client is open.
        const preferBearer = sharesLogin === 'other-login' && !!validSpareBearer;
        const liveSession = sharesLogin === 'unknown' ? 'unknown' : (sharesLogin === 'shared' || preferBearer) && await hasRunningLiveSession(agent);
        // Let the official Windows client persist its own renewal, including transitions beyond WinCred's blob limit.
        const officialRenewal = shared?.clientOwnsRenewal === true && followsCurrent && liveSession !== 'unknown' && !snapshot.separateLogin;
        let readOnly = independentRead || Boolean(liveSession) || officialRenewal;
        if (readOnly) stepDiagnostic('read-only');
        const readOnlyUsage = readOnly && !!shared;
        const poolFile = profile && path.join(profileDir(agent.id, profile), file);
        if (poolFile && !readOnly) assertRefreshWriteReady(poolFile);
        const separateBearer = followsCurrent && snapshot.separateLogin && liveSession === true && original
          ? shared?.quotaBearer(original, copies) : undefined;
        const retryRejected = (!!spareBearer || (preferBearer && readOnly) || (!!agent.canRecoverQuotaRotation && !readOnly)) && !snapshot.recoveryReadOnly && !snapshot.separateLogin && !desktop;
        const options = { allowRefresh: !readOnly, reportRejectedBearer: retryRejected, expectedEmail: snapshot.expectedEmail,
          withSharedRenewal: isLive && (liveSession === true || officialRenewal) && attempt === 0 ? sharedRenewalTracker : undefined,
          quotaCopies: snapshot.quotaCopies, allowUndatedBearer: !fileOnly && (!snapshot.separateLogin ||
            Boolean(separateBearer && !separateBearer.expiry && original && shared?.ownsQuotaLogin(original))) };
        let query: CredentialQuery;
        try {
          query = await agent.queryCredential!(original, options);
        } catch (error) {
          if (!(error instanceof QuotaBearerRejected) || !retryRejected) throw error;
          // The bearer was read-only. Before consuming its grant, recheck every live source and the saved generation.
          const sharing = clientCredentialMatch(agent, [original]);
          if (sharing === 'unknown' || (sharing === 'shared' && await hasRunningLiveSession(agent))) {
            query = { status: { available: true, account: identity?.email, state: 'error', extra: error.message } };
          } else {
            if (revisionAt(dir) !== revision || usesLiveLogin() !== isLive || (profile && isLive &&
                credentialState(agent, profileDir(agent.id, profile)).revision !== snapshot.profileRevision) ||
                (profile && (readStagedBytes(agent, profileDir(agent.id, profile)) ||
                  (agent.bindsQuotaEmail && readProfileMeta(agent.id, profile).email !== snapshot.expectedEmail)))) throw new CredentialChangedError();
            if (poolFile) assertRefreshWriteReady(poolFile);
            readOnly = false;
            query = await agent.queryCredential!(original, { ...options, allowRefresh: true, renewRejectedBearer: true });
          }
        }
        const waiting = query.waitingForClient && !snapshot.recoveryReadOnly && sharesLogin !== 'unknown';
        if (query.waitingForClient && snapshot.recoveryReadOnly) {
          query.status = { ...query.status, state: 'error', authFailure: 'quota-recovery-required', extra: new PendingQuotaConflict().message };
        } else if (query.waitingForClient && sharesLogin === 'unknown') query.status.extra = nativeSourcesUnknown;
        if (waiting) resultDiagnostic('waiting', cached?.fetchedAt);
        if (snapshot.separateLogin && (waiting || query.status.extra?.includes('客户端正在运行'))) {
          query.status.extra = '当前登录与保存的凭据版本不同，已保留两份凭据；请在官方客户端续期后刷新额度';
        }
        try {
          const nextRefreshToken = extractRefreshToken(query.rotated ?? null);
          const persistedFreshRotation = Boolean(!readOnly && nextRefreshToken && nextRefreshToken !== extractRefreshToken(original));
          if (persistedFreshRotation) stepDiagnostic('rotation');
          if (query.temporaryDirectory) {
            stepDiagnostic('pending-commit');
            if (agent.canRecoverQuotaRotation && query.rotated) recordCodexQuotaOutput(query.temporaryDirectory, revision, query.rotated);
          }
          const commitWork = () => withStoreLock(async () => {
            if (name && (!profileExists(agent.id, name) || safeIdentity(agent, profileDir(agent.id, name))?.id !== identity?.id)) throw new CredentialChangedError();
            if (identityAt(dir)?.id !== identity?.id || usesLiveLogin() !== isLive ||
                (isLive && profile && credentialState(agent, profileDir(agent.id, profile)).revision !== snapshot.profileRevision)) throw new CredentialChangedError();
            if (agent.bindsQuotaEmail && profile && readProfileMeta(agent.id, profile).email !== snapshot.expectedEmail) throw new CredentialChangedError();
            let status: StatusResult;
            if (readOnly) {
              if (!query.rotated && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
              status = { ...query.status, credentialRevision: (readOnlyUsage && query.status.credentialRevision) || revision };
              // /usage can return current quota without a new subscription tier.
              if (readOnlyUsage && !status.plan) status.plan = cached?.plan;
            } else {
              if (query.rotated && (!original || !query.rotated.equals(original))) stepDiagnostic('credential-write');
              if (isLive && agent.writeRenewedCredentials && query.rotated) {
                try { await agent.writeRenewedCredentials({ [file]: query.rotated }, revision); }
                catch (error) {
                  // If a client reopened, persist the official successor against the exact saved input.
                  if (!profile || !(error instanceof LiveWriteDeferred) || snapshot.profileRevision !== revision) throw error;
                  const savedDir = profileDir(agent.id, profile);
                  status = agent.commitQuery(savedDir, revision, { ...query, temporaryDirectory: undefined });
                  const meta = readProfileMeta(agent.id, profile);
                  writeProfileMeta(agent.id, profile, { ...meta, pendingLiveRevision: revision });
                  return recordRefresh(agent, savedDir, profile, false, identity, identity, revision, cached,
                    { ...status, state: 'unverified', extra: error.message }, persistedFreshRotation);
                }
                status = { ...query.status, credentialRevision: credentialStateFromFiles(agent.id, [[file, query.rotated]]).revision };
              } else status = agent.commitQuery(dir, revision, { ...query, temporaryDirectory: undefined });
            }
            if (status.refreshConsumed) {
              const token = extractRefreshToken(original);
              if (token) status.consumedRefreshFingerprint = fingerprint(token);
            }
            const postIdentity = identityAt(dir) || identity;
            return recordRefresh(agent, dir, profile, isLive, postIdentity, identity, revision, cached, status, persistedFreshRotation,
              fileOnly ? () => revisionAt(dir) : undefined);
          });
          let committed = query.rotated || query.temporaryDirectory ? await criticalCommitTracker(commitWork) : await commitWork();
          if (!readOnly && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
          if (supersededEntries.length) {
            const retained = reconcileSuperseded(committed.credentialRevision, persistedFreshRotation, extractRefreshToken(original));
            if (retained.length) {
              committed = { ...committed, extra: appendRecoveryNotice(committed.extra, retained) };
              await persistNotice(profile, committed);
            }
          }
          return committed;
        } catch (error) {
          // Retry once only for a newer generation of the originally requested account.
          if (!(error instanceof CredentialChangedError) || attempt || !identity ||
              identityAt(dir)?.id !== identity.id || revisionAt(dir) === revision) {
            if (query.temporaryDirectory && fs.existsSync(query.temporaryDirectory) && error instanceof Error && !error.message.includes(query.temporaryDirectory)) {
              error.message = appendRecoveryNotice(error.message, [query.temporaryDirectory]);
            }
            rememberRefreshWriteFailure(failureKey, error);
            throw error;
          }
          if (query.temporaryDirectory) {
            const rotatedRevision = query.rotated
              ? credentialStateFromFiles(agent.id, [[agent.authFiles[0], query.rotated]]).revision
              : undefined;
            supersededEntries.push({ dir: query.temporaryDirectory, rotatedRevision, rotatedToken: extractRefreshToken(query.rotated ?? null) });
          }
        }
      }
    } catch (error) {
      if (supersededEntries.length && error instanceof Error) {
        error.message = appendRecoveryNotice(error.message, supersededEntries.map(entry => entry.dir));
      }
      throw error;
    }
  };
  const query = withStoreLock(run, identity?.id || dir).catch(error => {
    if (error instanceof RecoveredCodexIdentity) return refreshAccount(agent, name, force, automatic);
    throw error;
  }).finally(() => pendingQueries.delete(key));
  pendingQueries.set(key, query);
  return query;
}

async function recordRefresh(
  agent: BaseAgent,
  dir: string,
  profile: string | undefined,
  isLive: boolean,
  identity: Identity | undefined,
  preIdentity: Identity | undefined,
  previousRevision: string | undefined,
  cached: StatusResult | undefined,
  status: StatusResult,
  rotated = false,
  observedRevision?: () => string | undefined,
) {
  if (status.state === 'error' || status.state === 'expired' || status.state === 'unverified') {
    status = { ...status, ...reportedQuotaHistory(cached) };
  }
  if (status.state === 'ok') {
    if (!isLive) status.spareActivity = spareQuotaActivity(cached, status);
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
  const upgradedFrom = preIdentity && identity && preIdentity.id !== identity.id
    ? { id: preIdentity.id, revision: previousRevision }
    : undefined;
  if (!observedRevision && identity && (status.state === 'ok' || rotated)) {
    await syncCopies(agent, dir, { previousRevision, strict: false, expectedRevision: status.credentialRevision, upgradedFrom,
      liveProfile: isLive ? profile : undefined });
  }
  if ((observedRevision ? observedRevision() : credentialState(agent, dir).revision) !== status.credentialRevision) throw new CredentialChangedError();
  if (isLive && identity) liveCache.set(agent.id, { identity: identity.id, status });
  // Old imported aliases share a result only for the same identity and exact
  // credential generation. Their labels and other metadata remain independent.
  for (const name of listProfiles(agent.id)) {
    const target = profileDir(agent.id, name);
    if (name !== profile && (!identity || safeIdentity(agent, target)?.id !== identity.id)) continue;
    let targetRevision: string | undefined;
    try { targetRevision = credentialState(agent, target).revision; } catch { continue; }
    if (targetRevision !== status.credentialRevision) continue;
    const meta = readProfileMeta(agent.id, name);
    if (name !== profile && agent.bindsQuotaEmail && differentEmail(meta.email, identity?.email)) {
      if (status.refreshConsumed) writeProfileMeta(agent.id, name, { ...meta,
        snapshot: { ...status, account: meta.email, quota: undefined, plan: undefined, fetchedAt: undefined } });
      continue;
    }
    const email = agent.bindsQuotaEmail && status.state !== 'ok' ? meta.email : identity?.email || meta.email;
    writeProfileMeta(agent.id, name, { ...meta, email, snapshot: status });
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
  const canSave = dir !== agent.homeDir || agent.management().canSaveCurrent;
  const identity = canSave ? agent.identity(dir) : undefined;
  const duplicate = identity ? findExistingProfile(agent, identity) : undefined;
  return {
    account: canSave ? identity?.email || (identity ? '已检测到凭据' : undefined) : agent.credentialStatus().account,
    email: identity?.email,
    ready: !!identity && canSave,
    isolated: dir !== agent.homeDir,
    existingProfile: duplicate?.name,
    existingProfileUpdatable: !!duplicate && !!availableCredentialUpdateTarget(agent, duplicate.name, { allowStaged: dir !== agent.homeDir }),
  };
}

export function cancelLogin(agent?: BaseAgent): void {
  const agents = agent ? [agent] : ALL_AGENTS;
  for (const a of agents) releaseLoginDirectory(a);
}
