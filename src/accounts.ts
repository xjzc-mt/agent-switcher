import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { BaseAgent, StatusResult, Identity, type CredentialFiles, type CredentialQuery } from './agents/base';
import { CodexAgent, codexAgent } from './agents/codex';
import { claudeAgent } from './agents/claude';
import { AntigravityAgent, antigravityAgent, antigravityRenewalHint } from './agents/antigravity';
import { compareNativeSessionCopies, ConflictingNativeFileLogins, findQuotaBearer, parseNativeToken, readAuxiliaryNativeTokens, sharedAntigravitySessions } from './antigravity-native';
import { listProfiles, getActiveProfile, setActiveProfile, clearActiveProfile, profileDir, profileExists, readProfileMeta, writeProfileMeta, withStoreLock, validateName, sameProfileName, PENDING_RENAME_FILE, setInProcessRename, ProfileMeta } from './store';
import { atomicWrite, replaceFiles, readBuffer, fingerprint, differentEmail, type CredentialWriter } from './utils';
import { runningClients } from './clients';
import { logoutSupport, assertLogoutReady, clearClientCredentials, runningCodexSessions } from './client-logout';
import { allowUnchangedTemporaryRefresh, createTemporaryCredentials, releaseTemporaryCredentials, removeTemporaryCredentials } from './temporary-credentials';
import { MIN_REFRESH_INTERVAL_MS, quotaRefreshAt } from './quota-refresh';
import { credentialState, credentialStateFromFiles, credentialOrder, snapshotForCredentials, CredentialChangedError } from './credential-state';
import { assertCredentialWriteReady, STAGED_CREDENTIAL_SUFFIX } from './credential-vault';
import { resultDiagnostic, stepDiagnostic } from './diagnostics';

export const ALL_AGENTS: BaseAgent[] = [codexAgent, antigravityAgent, claudeAgent];
export function resolveAgent(id: string): BaseAgent {
  const agent = ALL_AGENTS.find(a => a.id === id);
  if (!agent) throw new Error('未知平台');
  return agent;
}
const liveCache = new Map<string, { identity: string; status: StatusResult }>();
const pendingQueries = new Map<string, Promise<StatusResult>>();
const refreshWriteFailures = new Map<string, { at: number; message: string }>();
const loginDirs = new Map<string, string>();
let criticalCommitTracker: <T>(work: () => Promise<T>) => Promise<T> = work => work();
export function setCriticalCommitTracker(tracker: <T>(work: () => Promise<T>) => Promise<T>): void {
  criticalCommitTracker = tracker;
}

const stagedFileName = (agent: BaseAgent) => `${agent.authFiles[0]}${STAGED_CREDENTIAL_SUFFIX}`;
const stagedFilePath = (agent: BaseAgent, dir: string) => path.join(dir, stagedFileName(agent));
const stagedClientBusy = '客户端正在运行，为避免续期冲突暂不验证新凭据；请先关闭客户端后刷新验证';
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

function safeIdentity(agent: BaseAgent, dir?: string): Identity | undefined {
  try { return agent.identity(dir); } catch { return undefined; }
}

function conflictingQuotaEmail(registered?: string, observed?: string, status?: StatusResult): boolean {
  const reported = status?.account;
  return differentEmail(registered, observed) ||
    differentEmail(registered || observed, reported?.includes('@') ? reported : undefined);
}

function quotaSnapshot(agent: BaseAgent, revision?: string, registered?: string, observed?: string, stored?: StatusResult): StatusResult | undefined {
  if (agent instanceof CodexAgent && conflictingQuotaEmail(registered, observed, stored)) {
    const account = registered || observed;
    const checked = revision && stored?.credentialRevision === revision && stored.state === 'error' && account &&
      stored.account?.trim().toLowerCase() === account.trim().toLowerCase();
    return { available: true, account, state: 'error' as const, credentialRevision: revision,
      checkedAt: checked ? stored?.checkedAt : undefined, refreshFailures: checked ? stored?.refreshFailures : undefined,
      extra: '额度身份与账号记录不一致，请刷新核对' };
  }
  const snapshot = snapshotForCredentials(stored, revision);
  if (agent instanceof AntigravityAgent && snapshot?.state === 'unverified' && !snapshot.stagedReplacement && snapshot.extra) {
    const extra = snapshot.extra;
    const oldHint = [
      '本次额度未更新。可以继续使用 Antigravity。客户端更新登录信息后，AGS 会在下次刷新时重新查询额度。',
      'Antigravity 客户端正在运行，暂时没有可用于只读查询的有效访问令牌；客户端续期或关闭后可重试',
      '额度暂未更新。可等 Antigravity 自动续期，或保存工作后按 ⌘Q 退出 Antigravity。如有正在使用该账号的 agy 终端或 Antigravity IDE 会话，也请结束。30 秒后再刷新额度。',
    ].find(hint => extra.startsWith(hint));
    if (oldHint) return { ...snapshot, extra: antigravityRenewalHint + extra.slice(oldHint.length) };
  }
  return snapshot;
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

function matchingProfiles(agent: BaseAgent, identity: Identity): string[] {
  return listProfiles(agent.id).filter(name => {
    const target = safeIdentity(agent, profileDir(agent.id, name));
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
  return preferredMatch(matchingProfiles(agent, identity), getActiveProfile(agent.id));
}

function preferredMatch(matching: string[], preferred?: string) {
  const nonBackup = matching.find(m => !/^backup-\d+$/.test(m));
  if (preferred && matching.includes(preferred) && (!nonBackup || !/^backup-\d+$/.test(preferred))) return preferred;
  return nonBackup || matching[0];
}

export function clientSwitchRevision(agent: BaseAgent): string {
  return agent.switchFingerprint() || fileSwitchRevision(agent, agent.readSwitchableCredentials());
}

function fileSwitchRevision(agent: BaseAgent, { files, corrupted }: ReturnType<BaseAgent['readSwitchableCredentials']>): string {
  const primaryRev = corrupted ? 'corrupt' : credentialStateFromFiles(agent.id, Object.entries(files)).revision || 'none';
  const auxRevs = agent.auxiliaryCredentials().map(aux =>
    `${aux.identity.id}:${credentialStateFromFiles(agent.id, Object.entries(aux.files)).revision || ''}`).sort();
  return fingerprint(JSON.stringify([primaryRev, auxRevs]));
}

async function syncCurrent(agent: BaseAgent, saveUnmanaged = true, skipPrimary = false): Promise<Map<string, string | undefined>> {
  const primaryFiles = skipPrimary ? undefined : agent.readCredentials();
  const primaryIdentity = primaryFiles && agent.identity(agent.homeDir, primaryFiles);
  const auxiliaries = agent.auxiliaryCredentials();
  if (agent.management().quota) {
    const allSources = [
      ...(primaryIdentity && primaryFiles ? [{ identity: primaryIdentity, files: primaryFiles }] : []),
      ...auxiliaries,
    ];
    for (let i = 0; i < allSources.length; i++) {
      const stateA = credentialStateFromFiles(agent.id, Object.entries(allSources[i].files));
      for (let j = i + 1; j < allSources.length; j++) {
        if (!isSameIdentity(allSources[i].identity, allSources[j].identity)) continue;
        const stateB = credentialStateFromFiles(agent.id, Object.entries(allSources[j].files));
        const file = agent.authFiles[0];
        const independent = agent.id === 'agy' &&
          rawRefreshToken(allSources[i].files[file]) !== rawRefreshToken(allSources[j].files[file]);
        if (independent || credentialOrder(stateA, stateB) === 'unknown') {
          const label = allSources[i].identity.email || allSources[i].identity.id;
          throw new Error(`检测到账号「${label}」在客户端多处认证存储中存在无法确认新旧的独立凭据，已保留原凭据并取消操作`);
        }
      }
    }
  }
  if (primaryIdentity && primaryFiles) {
    const active = preferredMatch(matchingProfiles(agent, primaryIdentity), getActiveProfile(agent.id));
    await syncCopies(agent, agent.homeDir, { files: primaryFiles });
    if (!active && saveUnmanaged) {
      const name = nextBackupName(agent.id);
      await agent.save(name, agent.homeDir, primaryFiles);
      writeProfileMeta(agent.id, name, { email: primaryIdentity.email, savedAt: new Date().toISOString() });
    }
  }
  const updated = new Map<string, string | undefined>();
  for (const aux of auxiliaries) {
    const matches = matchingProfiles(agent, aux.identity);
    if (matches.length) {
      const auxState = credentialStateFromFiles(agent.id, Object.entries(aux.files));
      for (const name of matches) {
        const dest = profileDir(agent.id, name);
        const order = agent.management().quota ? poolCopyOrder(agent, aux.files, agent.readCredentials(dest)) : 'newer';
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
  order = credentialOrder(credentialStateFromFiles(agent.id, Object.entries(source)), credentialStateFromFiles(agent.id, Object.entries(target)))) {
  if (!(agent instanceof AntigravityAgent)) return order;
  const file = agent.authFiles[0], preference = compareNativeSessionCopies(source[file], target[file]);
  if (preference === undefined) return order;
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
    if (dest !== source) {
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
      if (sameAccount) {
        // Only the active card can follow an official-client renewal by date.
        // A background query may update other copies only from its exact previous generation.
        if (!strict && name !== options.liveProfile && targetState.revision !== previousRevision) continue;
        const order = agent.management().quota ? poolCopyOrder(agent, files, copy, credentialOrder(sourceState, targetState, previousRevision)) : 'newer';
        if (order === 'unknown' && strict) throw new Error(`「${name}」存在不同版本的凭据，无法确认新旧，已保留两份凭据并取消操作`);
        if (order === 'newer') {
          if (expectedRevision && agent instanceof CodexAgent && differentEmail(readProfileMeta(agent.id, name).email, identity.email)) continue;
          writes.push({ name, revision: targetState.revision });
        }
      }
    }
  }
  for (const { name, revision } of writes) {
    if (credentialState(agent, source).revision !== sourceState.revision ||
        credentialState(agent, profileDir(agent.id, name)).revision !== revision) throw new CredentialChangedError();
    await agent.save(name, source, files);
  }
}

export async function saveAccount(agent: BaseAgent, name: string, validateLogin?: () => void): Promise<{ ok: true; files: string[]; warnings: string[]; profile?: string; updated?: boolean }> {
  return withStoreLock(async () => {
    validateLogin?.();
    validateName(name);
    const isolatedSource = loginDirs.get(agent.id);
    const source = isolatedSource || agent.homeDir;
    if (source === agent.homeDir && !agent.management().canSaveCurrent) throw new Error(agent.switchSupport() || '当前登录不支持保存为文件凭据');
    const captured = agent.readCredentials(source);
    const identity = agent.identity(source, captured);
    if (!identity) throw new Error('尚未检测到登录凭据，请完成登录后再保存');
    const sourceState = credentialStateFromFiles(agent.id, Object.entries(captured));
    const finishSave = (profile: string) => {
      if (source !== agent.homeDir) releaseLoginDirectory(agent);
      else if (credentialState(agent).revision === sourceState.revision) setActiveProfile(agent.id, profile);
    };

    const existingProfile = findExistingProfile(agent, identity);
    const update = existingProfile && availableCredentialUpdateTarget(agent, existingProfile.name, { allowStaged: Boolean(isolatedSource) });
    if (update) {
      const files = Object.keys(captured);
      replaceAccountCredentialsLocked(update, source, { trusted: Boolean(isolatedSource), sourceFiles: captured });
      finishSave(update.profile);
      return { ok: true, files, warnings: [], profile: update.profile, updated: true };
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
      if (agent.management().quota) {
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
  const live = corrupted ? undefined : agent.identityFromBytes(files[agent.authFiles[0]]);
  const targetId = agent.identity(profileDir(agent.id, name))?.id;
  if (live && live.id !== targetId && !matchingProfiles(agent, live).length) return true;
  return agent.auxiliaryCredentials().some(aux =>
    aux.identity.id !== live?.id && aux.identity.id !== targetId && !matchingProfiles(agent, aux.identity).length);
}

export async function useAccount(agent: BaseAgent, name: string, options: { saveUnmanaged?: boolean; expectedCurrentRevision?: string; allowFileMigration?: boolean } = {}) {
  return withStoreLock(async () => {
    const unsupported = agent.switchSupport();
    if (unsupported) throw new Error(unsupported);
    const target = profileDir(agent.id, name);
    agent.credentials(target); // Validate before backing up or changing anything.
    if (process.platform === 'win32' && agent.id === 'codex' && (await runningCodexSessions({ failClosed: true })).length) {
      throw new Error('请先退出 Codex 桌面并结束共用登录的 CLI 或 IDE 会话，再切换账号');
    }
    const clients = await runningClients(agent.id, { failClosed: agent.id === 'agy' && options.allowFileMigration === true });
    if (clients.length) throw new Error(`请先退出 ${clients.join('、')}，完成切换后重新打开`);
    await agent.recoverInterruptedSwitch?.();
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
    const alreadySelected = !liveCorrupted && isSameIdentity(liveIdentity, targetIdentity);
    if (needsUnmanagedChoice(agent, name) && typeof options.saveUnmanaged !== 'boolean') {
      throw new Error('当前账号未保存在 AGS，请明确选择保存后切换或不保存并切换（CLI：--save-current / --discard-current）');
    }
    const syncedAuxiliary = await syncCurrent(agent, options.saveUnmanaged !== false, liveCorrupted === true);
    if (clientSwitchRevision(agent) !== initialSwitchRev) throw new CredentialChangedError();
    const expectedTargetRevision = syncedAuxiliary.has(name) ? syncedAuxiliary.get(name) : targetRevision;
    if (!alreadySelected && credentialState(agent, target).revision !== expectedTargetRevision) throw new CredentialChangedError();
    if (alreadySelected) {
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
    const allowed = [...agent.authFiles, stagedFileName(agent), '_meta.json', 'config.toml', 'settings.json', 'settings.local.json'];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!allowed.includes(entry.name) || !entry.isFile()) throw new Error(`「${profile}」含非账号管理文件，已保留，请先核对`);
    }
    const staged = stagedFilePath(agent, dir);
    const pendingRevision = fs.existsSync(staged) ? fingerprint(fs.readFileSync(staged).toString('base64')) : null;
    return [profile, stat.dev, stat.ino, stat.birthtimeMs, safeProfileRevision(agent, dir), pendingRevision];
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
  return withStoreLock(async () => {
    return withStoreLock(async () => {
      if (options.logout) await assertLogoutReady(agent);
      const latest = removalPreview(agent, name);
      if (latest.signature !== expected.signature || latest.identity !== expected.identity) throw new Error('账号或备份范围已变化，请重新核对后删除');
      if (options.logout && (!expected.current || !latest.current || latest.liveRevision !== expected.liveRevision || latest.logoutUnsupported)) {
        throw new Error(latest.logoutUnsupported || '客户端当前账号已变化，未退出或删除，请重新核对');
      }
      if (options.logout) clearClientCredentials(agent, latest.identity!, expected.liveRevision);
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
  const authUnresolved = status?.state === 'error' && ['authentication-rejected', 'account-unavailable'].includes(status.authFailure || '');
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
  return withStoreLock(async () => {
    validateLogin?.();
    return replaceAccountCredentialsLocked(target, source, options).result;
  });
}

/**
 * Caller must hold the store lock.
 * Official isolated browser re-login (`trusted: true`) updates directly;
 * external untrusted credentials (`trusted !== true`) are staged in `.pending`
 * without touching the pool or live login until server verification binds user + workspace.
 */
export function replaceAccountCredentialsLocked(target: CredentialUpdateTarget, source: string | CredentialFiles, options: { trusted?: boolean; importWriter?: CredentialWriter; sourceFiles?: CredentialFiles } = {}) {
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
  const previousStaged = readStagedBytes(agent, dir);
  const previousStagedRevision = previousStaged && credentialStateFromFiles(agent.id, [[agent.authFiles[0], previousStaged]]).revision;
  const consumed = consumedLogin(meta.snapshot, originalBytes, current.revision, previousStagedRevision || undefined);
  if (consumed && rawRefreshToken(files[agent.authFiles[0]]) === rawRefreshToken(originalBytes)) {
    throw new Error('此续期凭据已被消耗，请重新授权后使用新的凭据');
  }

  if (!options.trusted) {
    if (agent instanceof CodexAgent && differentEmail(meta.email, incoming.email)) {
      throw new Error('凭据与原账号登记的邮箱不符，已保留原凭据');
    }
    if (!agent.canVerifyReplacement(originalBytes)) {
      throw new Error('无法验证此外部凭据与原账号及工作区的绑定关系，已保留原凭据；请使用「重新登录」完成官方授权');
    }
    const candidateBytes = files[agent.authFiles[0]];
    const stagedRev = credentialStateFromFiles(agent.id, [[agent.authFiles[0], candidateBytes]]).revision;
    const snapshot: StatusResult = {
      ...meta.snapshot, available: true, account: incoming.email || meta.email,
      state: 'unverified', authExpired: false, extra: '待通过官方服务验证凭据归属后生效', checkedAt: undefined,
      refreshFailures: undefined, creditActivity: undefined,
      credentialRevision: stagedRev, stagedReplacement: true, authFailure: undefined,
    };
    const stagedName = stagedFileName(agent);
    const previousMeta = readBuffer(path.join(dir, '_meta.json'));
    replaceFiles(dir, {
      [stagedName]: candidateBytes,
      '_meta.json': Buffer.from(JSON.stringify({ ...meta, stagedCheck: undefined, email: meta.email || incoming.email, snapshot: consumed || snapshot }, null, 2)),
    }, options.importWriter);
    return {
      result: { ok: true, agent: agent.id, profile: target.profile, staged: true },
      rollback() {
        replaceFiles(dir, { [stagedName]: previousStaged, '_meta.json': previousMeta });
      },
    };
  }

  const isLive = agent.management().canSaveCurrent && isSameIdentity(safeIdentity(agent), current.identity) &&
    credentialState(agent).revision === current.revision;
  const snapshot: StatusResult = {
    ...meta.snapshot, available: true, account: incoming.email || meta.email,
    state: 'unverified', authExpired: false, extra: undefined, checkedAt: undefined,
    refreshFailures: undefined, creditActivity: undefined,
    credentialRevision: credentialStateFromFiles(agent.id, Object.entries(files)).revision, stagedReplacement: undefined, authFailure: undefined,
    refreshConsumed: undefined, consumedRefreshFingerprint: undefined,
  };
  const stagedName = stagedFileName(agent);
  const writes: Array<{ dir: string; files: Record<string, Buffer | null> }> = [
    { dir, files: { ...files, [stagedName]: null, '_meta.json': Buffer.from(JSON.stringify({ ...meta, stagedCheck: undefined, email: incoming.email || meta.email, snapshot }, null, 2)) } },
    ...(isLive ? [{ dir: agent.homeDir, files }] : []),
  ];
  const previous = writes.map(write => ({
    dir: write.dir,
    files: write.dir === agent.homeDir
      ? agent.readCredentials()
      : Object.fromEntries(Object.keys(write.files).map(file => [file, readBuffer(path.join(write.dir, file))])),
  }));
  const apply = (write: { dir: string; files: Record<string, Buffer | null> }) => write.dir === agent.homeDir
    ? agent.writeCredentials(write.dir, write.files) : replaceFiles(write.dir, write.files);
  let applied = 0;
  try {
    for (const write of writes) {
      if (write.dir === agent.homeDir && credentialState(agent).revision !== current.revision) continue;
      apply(write); applied++;
    }
  } catch (error) {
    for (let i = applied - 1; i >= 0; i--) apply(previous[i]);
    throw error;
  }
  const cached = liveCache.get(agent.id);
  if (isLive) liveCache.delete(agent.id);
  return {
    result: { ok: true, agent: agent.id, profile: target.profile },
    rollback() {
      for (const write of previous.slice(0, applied).reverse()) {
        if (write.dir !== agent.homeDir || credentialState(agent).revision === snapshot.credentialRevision) apply(write);
      }
      if (isLive && cached) liveCache.set(agent.id, cached);
      else if (isLive) liveCache.delete(agent.id);
    },
  };
}

export function dashboard() {
  return ALL_AGENTS.map(agent => {
    const management = agent.management();
    const profiles = listProfiles(agent.id, { includeInvalid: true }).map(name => {
      let meta: ProfileMeta = {};
      try { meta = readProfileMeta(agent.id, name); } catch {}
      const stored = meta.snapshot;
      let saved: Identity | undefined, snapshot: StatusResult | undefined;
      try {
        const dir = profileDir(agent.id, name);
        if (management.quota) {
          const bytes = agent.readCredentials(dir)[agent.authFiles[0]];
          saved = agent.identityFromBytes(bytes);
          if (!saved) throw new Error('账号池凭据缺失或格式异常，请检查文件或从备份恢复');
          const staged = readStagedBytes(agent, dir);
          const effectiveBytes = staged ?? bytes;
          const revision = credentialStateFromFiles(agent.id, [[agent.authFiles[0], effectiveBytes]]).revision;
          snapshot = quotaSnapshot(agent, revision, meta.email, saved.email, stored);
          if (staged) {
            const deferred = meta.stagedCheck;
            const checkedAt = deferred?.revision === revision ? deferred?.checkedAt : undefined;
            snapshot = { ...snapshot, available: true, state: 'unverified', stagedReplacement: true,
              checkedAt: checkedAt || snapshot?.checkedAt, extra: checkedAt ? stagedClientBusy : snapshot?.extra };
          }
        } else {
          saved = agent.identity(dir);
          snapshot = agent.credentialStatus(dir);
        }
      } catch (error) {
        snapshot = { available: false, account: meta.email, state: 'error', extra: (error as Error).message };
      }
      return { name, meta: { ...meta, email: meta.email || saved?.email, snapshot }, stored, saved };
    });
    const switchUnsupported = agent.switchSupport();
    let active: string | undefined, status: StatusResult;
    try {
      const liveFiles = management.quota ? agent.readCredentials() : undefined;
      const identity = agent.identity(agent.homeDir, liveFiles);
      const matches = profiles.filter(p => isSameIdentity(identity, p.saved)).map(p => p.name);
      if (management.canSaveCurrent && !switchUnsupported && matches.length) active = preferredMatch(matches, getActiveProfile(agent.id));
      if (management.quota) {
        const live = liveCache.get(agent.id);
        const activeProfileEntry = profiles.find(p => p.name === active);
        const activeHasStaged = activeProfileEntry?.meta.snapshot?.stagedReplacement;
        const revision = identity && liveFiles && credentialStateFromFiles(agent.id, Object.entries(liveFiles)).revision;
        const cached = currentQuotaSnapshot(revision, activeHasStaged ? undefined : activeProfileEntry?.stored,
          live && identity?.id === live.identity ? live.status : undefined);
        const registered = activeProfileEntry?.meta.email;
        status = (identity && quotaSnapshot(agent, revision, registered, identity.email, cached)) || {
            available: !!identity, account: identity?.email, state: identity ? 'unverified' : 'signed-out', extra: switchUnsupported,
          };
      } else {
        status = agent.displayStatus();
      }
    } catch (error) { status = { available: false, state: 'error', extra: (error as Error).message }; }
    return {
      id: agent.id, label: agent.label, active, status, management, switchUnsupported, refreshAt: quotaRefreshAt(status, true),
      profiles: profiles.map(({ name, meta }) => ({ name, meta, isActive: name === active,
        refreshAt: meta.snapshot?.available === false ? Infinity : quotaRefreshAt(meta.snapshot, name === active) })),
    };
  });
}

async function hasRunningLiveSession(agent: BaseAgent): Promise<boolean> {
  try {
    const busy = (await runningClients(agent.id, { failClosed: true })).length > 0 ||
      (agent.id === 'codex' && (await runningCodexSessions({ failClosed: true })).length > 0) ||
      (agent instanceof AntigravityAgent && agent.management().storage === 'keychain' && (await sharedAntigravitySessions()).length > 0);
    if (busy) stepDiagnostic('live-session');
    return busy;
  } catch {
    stepDiagnostic('process-unknown');
    return true; // Fail-closed when client process status cannot be reliably confirmed.
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

function rawRefreshToken(bytes: Buffer | null): string | undefined {
  if (!bytes) return undefined;
  try {
    const parsed = JSON.parse(bytes.toString());
    const rt = parsed?.tokens?.refresh_token ?? parsed?.token?.refresh_token ?? parsed?.refresh_token;
    return typeof rt === 'string' && rt ? rt : undefined;
  } catch { return undefined; }
}

function rememberRefreshWriteFailure(key: string, error: unknown, query: CredentialQuery, input: Buffer | null): void {
  if (error instanceof Error) refreshWriteFailures.set(key, { at: Date.now(), message: error.message });
  const previous = rawRefreshToken(input);
  if (query.verifiedReplacement !== false && query.temporaryDirectory && previous && previous === rawRefreshToken(query.rotated ?? null)) {
    allowUnchangedTemporaryRefresh(query.temporaryDirectory);
  }
}

function consumedLogin(status: StatusResult | undefined, bytes: Buffer | null, revision?: string, stagedRevision?: string): StatusResult | undefined {
  if (!status?.refreshConsumed || !revision) return;
  const token = rawRefreshToken(bytes);
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

function sharesClientCredential(agent: BaseAgent, credentials: Array<Buffer | null>, quotaCopies?: Buffer[]): boolean {
  if (!agent.management().canSaveCurrent) return false;
  const file = agent.authFiles[0];
  try {
    let copies: Array<Buffer | null>;
    try {
      copies = [agent.readCredentials()[file], ...agent.auxiliaryCredentials().map(source => source.files[file])];
    } catch (error) {
      if (!(error instanceof ConflictingNativeFileLogins)) throw error;
      // Both files can be compared with the pool without choosing an active login.
      copies = readAuxiliaryNativeTokens(null, true);
    }
    let shared = false;
    for (const bytes of credentials) {
      const identity = agent.identityFromBytes(bytes);
      const token = rawRefreshToken(bytes);
      for (const copy of copies) {
        const sameIdentity = isSameIdentity(identity, agent.identityFromBytes(copy));
        const sameToken = token && token === rawRefreshToken(copy);
        if (!sameIdentity && !sameToken) continue;
        if (!quotaCopies) return true;
        shared = true;
        if (sameIdentity && sameToken && copy) quotaCopies.push(copy);
      }
    }
    return shared;
  } catch {
    return true;
  }
}

async function verifyStagedProfileCredential(agent: BaseAgent, name: string): Promise<StatusResult | undefined> {
  const targetDir = profileDir(agent.id, name);
  const snapshot = await withStoreLock(async () => {
    if (!profileExists(agent.id, name)) throw new Error('账号不存在');
    const staged = readStagedBytes(agent, targetDir);
    if (!staged) return undefined;
    const original = agent.readCredentials(targetDir)[agent.authFiles[0]];
    const preIdentity = safeIdentity(agent, targetDir);
    const originalRevision = credentialStateFromFiles(agent.id, [[agent.authFiles[0], original]]).revision;
    const stagedRevision = credentialStateFromFiles(agent.id, [[agent.authFiles[0], staged]]).revision;
    const meta = readProfileMeta(agent.id, name);
    const consumed = consumedLogin(meta.snapshot, original, originalRevision, stagedRevision);
    return { staged, original, preIdentity, originalRevision, stagedRevision, meta, consumed };
  });
  if (!snapshot) return undefined;

  const backendIssue = agent instanceof CodexAgent && agent.switchSupport();
  if (backendIssue || sharesClientCredential(agent, [snapshot.original, snapshot.staged]) && await hasRunningLiveSession(agent)) {
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
        extra: backendIssue || stagedClientBusy,
        checkedAt,
      };
      writeProfileMeta(agent.id, name, { ...meta, snapshot: snapshot.consumed || deferredStatus,
        stagedCheck: snapshot.stagedRevision ? { revision: snapshot.stagedRevision, checkedAt } : undefined });
      resultDiagnostic(backendIssue ? 'unsupported' : 'waiting', meta.snapshot?.fetchedAt);
      return deferredStatus;
    });
  }

  const repeatsConsumed = snapshot.consumed && rawRefreshToken(snapshot.staged) === rawRefreshToken(snapshot.original);
  if (!repeatsConsumed) assertRefreshWriteReady(path.join(targetDir, agent.authFiles[0]));
  const failureKey = checkRefreshWriteFailure(agent, snapshot.preIdentity, snapshot.stagedRevision, snapshot.meta.email, snapshot.originalRevision);
  const query: CredentialQuery = repeatsConsumed ? { status: { available: true, extra: '待验证的续期凭据已被消耗，请重新授权' } }
    : await agent.queryCredential!(snapshot.staged, { allowRefresh: true, verifyTarget: snapshot.original, expectedEmail: snapshot.meta.email });
  const replacementRefresh = rawRefreshToken(query.rotated ?? null);
  if (replacementRefresh && replacementRefresh !== rawRefreshToken(snapshot.staged)) stepDiagnostic('rotation');
  if (query.temporaryDirectory) stepDiagnostic('pending-commit');
  try {
    return await criticalCommitTracker(() => withStoreLock(async () => {
      if (!profileExists(agent.id, name)) {
        if (!query.rotated && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
        throw new Error('账号不存在');
      }
      const currentOriginal = agent.readCredentials(targetDir)[agent.authFiles[0]];
      const currentStaged = readStagedBytes(agent, targetDir);
      if ((agent instanceof CodexAgent && readProfileMeta(agent.id, name).email !== snapshot.meta.email) ||
          credentialStateFromFiles(agent.id, [[agent.authFiles[0], currentOriginal]]).revision !== snapshot.originalRevision ||
          credentialStateFromFiles(agent.id, [[agent.authFiles[0], currentStaged]]).revision !== snapshot.stagedRevision) {
        throw new CredentialChangedError();
      }
      const stagedName = stagedFileName(agent);
      if (query.verifiedReplacement && query.status.state === 'ok' && query.rotated) {
        const liveBusy = await hasRunningLiveSession(agent);
        const isLiveSame = !liveBusy && agent.management().canSaveCurrent &&
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
          '_meta.json': Buffer.from(JSON.stringify({ ...meta, stagedCheck: undefined, email: postIdentity?.email || meta.email, snapshot: committedStatus }, null, 2)),
        });
        if (isLiveSame && credentialState(agent).revision === snapshot.originalRevision) {
          agent.writeCredentials(agent.homeDir, { [agent.authFiles[0]]: query.rotated });
          if (postIdentity) liveCache.set(agent.id, { identity: postIdentity.id, status: committedStatus });
        }
        await syncCopies(agent, targetDir, { previousRevision: snapshot.originalRevision, strict: false, expectedRevision: newRev,
          upgradedFrom: snapshot.preIdentity ? { id: snapshot.preIdentity.id, revision: snapshot.originalRevision } : undefined });
        if (query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
        return committedStatus;
      }
      if (!query.rotated && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
      const baseExtra = query.status.extra || '未能验证新凭据属于原账号与工作区，已保留原凭据；请使用「重新登录」完成官方授权';
      const extra = query.rotated && query.temporaryDirectory
        ? appendRecoveryNotice(baseExtra, [query.temporaryDirectory])
        : baseExtra;
      const meta = readProfileMeta(agent.id, name);
      const failedStatus: StatusResult = {
        ...snapshot.consumed,
        ...(snapshot.meta.snapshot?.quota ? { quota: snapshot.meta.snapshot.quota, plan: snapshot.meta.snapshot.plan, fetchedAt: snapshot.meta.snapshot.fetchedAt } : {}),
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
    if (query.rotated && query.temporaryDirectory && error instanceof Error) {
      error.message = appendRecoveryNotice(error.message, [query.temporaryDirectory]);
    }
    rememberRefreshWriteFailure(failureKey, error, query, snapshot.staged);
    throw error;
  }
}

function assertRefreshWriteReady(file: string): void {
  try { assertCredentialWriteReady(file); }
  catch (error) { stepDiagnostic('storage-unavailable'); throw error; }
}

export function refreshAccount(agent: BaseAgent, name?: string, force = false): Promise<StatusResult> {
  if (!(agent instanceof CodexAgent || agent instanceof AntigravityAgent && agent.management().quota)) {
    if (name && !profileExists(agent.id, name)) return Promise.reject(new Error('账号不存在'));
    return name ? Promise.resolve(agent.credentialStatus(profileDir(agent.id, name))) : agent.status();
  }
  const requested = name ? profileDir(agent.id, name) : agent.homeDir;
  const staged = name ? readStagedBytes(agent, requested) : null;
  const identity = agent.identity(requested);
  const usesLiveLogin = () => {
    if (!name) return true;
    if (staged || !identity) return false;
    let liveFiles: CredentialFiles;
    try { liveFiles = agent.readCredentials(); } catch { return false; }
    if (agent.identity(agent.homeDir, liveFiles)?.id !== identity.id) return false;
    return credentialStateFromFiles(agent.id, Object.entries(liveFiles)).revision === credentialState(agent, requested).revision ||
      name === preferredMatch(matchingProfiles(agent, identity), getActiveProfile(agent.id));
  };
  const isLive = usesLiveLogin();
  const dir = isLive ? agent.homeDir : requested;
  const dedupRev = staged
    ? credentialStateFromFiles(agent.id, [[agent.authFiles[0], staged]]).revision
    : credentialState(agent, dir).revision;
  const key = JSON.stringify([agent.id, name, dir, dedupRev, Boolean(staged)]);
  const pending = pendingQueries.get(key);
  if (pending) return pending;
  const supersededEntries: Array<{ dir: string; rotatedRevision?: string }> = [];
  const reconcileSuperseded = (persistedRevision: string | undefined, persistedFreshRotation: boolean): string[] => {
    const retained: Array<{ dir: string; rotatedRevision?: string }> = [];
    for (const entry of supersededEntries) {
      if (persistedFreshRotation || (entry.rotatedRevision && persistedRevision === entry.rotatedRevision)) {
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
    if (name && readStagedBytes(agent, requested)) {
      const stagedResult = await verifyStagedProfileCredential(agent, name);
      if (stagedResult) return stagedResult;
    }
    if (staged) throw new CredentialChangedError();
    try {
      for (let attempt = 0; ; attempt++) {
        const snapshot = await withStoreLock(async () => {
          if (name && !profileExists(agent.id, name)) throw new Error('账号不存在');
          if (safeIdentity(agent, requested)?.id !== identity?.id || usesLiveLogin() !== isLive) throw new CredentialChangedError();
          const profile = name || activeProfile(agent);
          if (isLive && identity && !(agent instanceof CodexAgent)) {
            await syncCopies(agent, agent.homeDir, { strict: false, liveProfile: profile });
          }
          const profileFiles = isLive && profile ? agent.readCredentials(profileDir(agent.id, profile)) : undefined;
          const profileState = profileFiles && credentialStateFromFiles(agent.id, Object.entries(profileFiles));
          const quotaCopies: Buffer[] = [];
          const file = agent.authFiles[0];
          const original = (agent instanceof AntigravityAgent ? agent.readCredentials(dir, quotaCopies) : agent.readCredentials(dir))[file];
          if (agent.identityFromBytes(original, isLive)?.id !== identity?.id) throw new CredentialChangedError();
          const sourceState = credentialStateFromFiles(agent.id, [[agent.authFiles[0], original]]);
          const { revision } = sourceState;
          const saved = profileFiles?.[file];
          let separateLogin = !!profileState && ['older', 'unknown'].includes(credentialOrder(sourceState, profileState));
          if (separateLogin && agent instanceof AntigravityAgent && saved && identity &&
              agent.identityFromBytes(saved)?.id === identity.id && rawRefreshToken(original) === rawRefreshToken(saved)) {
            separateLogin = false; // Same renewal credential, even when the bearer dates cannot be ordered.
          }
          const live = liveCache.get(agent.id);
          const meta = profile ? readProfileMeta(agent.id, profile) : undefined;
          const liveStatus = isLive && live?.identity === identity?.id ? live?.status : undefined;
          const stored = currentQuotaSnapshot(revision, meta?.snapshot, liveStatus);
          const consumed = consumedLogin(stored, original, revision) ||
            (isLive && live?.identity === identity?.id ? consumedLogin(live?.status, original, revision) : undefined);
          const cached = consumed || quotaSnapshot(agent, revision, meta?.email, identity?.email, stored);
          if (agent instanceof AntigravityAgent && saved && original && !original.equals(saved)) quotaCopies.push(saved);
          return { profile, profileRevision: profileState?.revision, separateLogin, original, revision, expectedEmail: meta?.email, cached, quotaCopies };
        });
        const { profile, original, revision, cached } = snapshot;
        const failureKey = checkRefreshWriteFailure(agent, identity, revision, snapshot.expectedEmail);
        const refreshAt = force
          ? Date.parse(cached?.checkedAt || '') + MIN_REFRESH_INTERVAL_MS
          : quotaRefreshAt(cached, isLive);
        if (cached && (cached.refreshConsumed || refreshAt > Date.now())) {
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
        const copies = agent instanceof AntigravityAgent ? snapshot.quotaCopies : undefined;
        const readOnly = snapshot.separateLogin || ((isLive || sharesClientCredential(agent, [original], copies)) && await hasRunningLiveSession(agent));
        if (readOnly) stepDiagnostic('read-only');
        const readOnlyUsage = readOnly && agent instanceof AntigravityAgent;
        if (profile && !readOnlyUsage) assertRefreshWriteReady(path.join(profileDir(agent.id, profile), agent.authFiles[0]));
        const options = { allowRefresh: !readOnly, expectedEmail: snapshot.expectedEmail,
          quotaCopies: snapshot.quotaCopies, allowUndatedBearer: !snapshot.separateLogin };
        const query = await agent.queryCredential!(original, options);
        if (query.status.extra === antigravityRenewalHint) resultDiagnostic('waiting', cached?.fetchedAt);
        if (snapshot.separateLogin && (query.status.extra === antigravityRenewalHint || query.status.extra?.includes('客户端正在运行'))) {
          query.status.extra = '当前登录与保存的凭据版本不同，已保留两份凭据；请在官方客户端续期后刷新额度';
        }
        try {
          const nextRefreshToken = rawRefreshToken(query.rotated ?? null);
          const persistedFreshRotation = Boolean(!readOnly && nextRefreshToken && nextRefreshToken !== rawRefreshToken(original));
          if (persistedFreshRotation) stepDiagnostic('rotation');
          if (query.temporaryDirectory) stepDiagnostic('pending-commit');
          const commitWork = () => withStoreLock(async () => {
            if (name && (!profileExists(agent.id, name) || safeIdentity(agent, profileDir(agent.id, name))?.id !== identity?.id)) throw new CredentialChangedError();
            if (safeIdentity(agent, dir)?.id !== identity?.id || usesLiveLogin() !== isLive ||
                (isLive && profile && credentialState(agent, profileDir(agent.id, profile)).revision !== snapshot.profileRevision)) throw new CredentialChangedError();
            if (agent instanceof CodexAgent && profile && readProfileMeta(agent.id, profile).email !== snapshot.expectedEmail) throw new CredentialChangedError();
            let status: StatusResult;
            if (readOnly) {
              if (!query.rotated && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
              status = { ...query.status, credentialRevision: revision };
              // /usage can return current quota without a new subscription tier.
              if (readOnlyUsage && !status.plan) status.plan = cached?.plan;
            } else {
              if (query.rotated && (!original || !query.rotated.equals(original))) stepDiagnostic('credential-write');
              status = agent.commitQuery(dir, revision, { ...query, temporaryDirectory: undefined });
            }
            if (status.refreshConsumed) {
              const token = rawRefreshToken(original);
              if (token) status.consumedRefreshFingerprint = fingerprint(token);
            }
            const postIdentity = safeIdentity(agent, dir) || identity;
            return recordRefresh(agent, dir, profile, isLive, postIdentity, identity, revision, cached, status, persistedFreshRotation);
          });
          let committed = query.rotated || query.temporaryDirectory ? await criticalCommitTracker(commitWork) : await commitWork();
          if (!readOnly && query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
          if (supersededEntries.length) {
            const retained = reconcileSuperseded(committed.credentialRevision, persistedFreshRotation);
            if (retained.length) {
              committed = { ...committed, extra: appendRecoveryNotice(committed.extra, retained) };
              await persistNotice(profile, committed);
            }
          }
          return committed;
        } catch (error) {
          // Retry once only for a newer generation of the originally requested account.
          if (!(error instanceof CredentialChangedError) || attempt || !identity ||
              safeIdentity(agent, dir)?.id !== identity.id || credentialState(agent, dir).revision === revision) {
            if (query.temporaryDirectory && fs.existsSync(query.temporaryDirectory) && error instanceof Error && !error.message.includes(query.temporaryDirectory)) {
              error.message = appendRecoveryNotice(error.message, [query.temporaryDirectory]);
            }
            rememberRefreshWriteFailure(failureKey, error, query, original);
            throw error;
          }
          if (query.temporaryDirectory) {
            const rotatedRevision = query.rotated
              ? credentialStateFromFiles(agent.id, [[agent.authFiles[0], query.rotated]]).revision
              : undefined;
            supersededEntries.push({ dir: query.temporaryDirectory, rotatedRevision });
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
  const query = withStoreLock(run, identity?.id || dir).finally(() => pendingQueries.delete(key));
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
) {
  if ((status.state === 'error' || status.state === 'expired' || status.state === 'unverified') && cached?.quota) {
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
  const upgradedFrom = preIdentity && identity && preIdentity.id !== identity.id
    ? { id: preIdentity.id, revision: previousRevision }
    : undefined;
  if (identity && (status.state === 'ok' || rotated)) {
    await syncCopies(agent, dir, { previousRevision, strict: false, expectedRevision: status.credentialRevision, upgradedFrom,
      liveProfile: isLive ? profile : undefined });
  }
  if (credentialState(agent, dir).revision !== status.credentialRevision) throw new CredentialChangedError();
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
    if (name !== profile && agent instanceof CodexAgent && differentEmail(meta.email, identity?.email)) {
      if (status.refreshConsumed) writeProfileMeta(agent.id, name, { ...meta,
        snapshot: { ...status, account: meta.email, quota: undefined, plan: undefined, fetchedAt: undefined } });
      continue;
    }
    const email = agent instanceof CodexAgent && status.state !== 'ok' ? meta.email : identity?.email || meta.email;
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
    account: canSave ? identity?.email || (identity ? '已检测到凭据' : undefined) : agent.displayStatus().account,
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
