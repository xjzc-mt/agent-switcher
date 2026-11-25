import { hasPendingAntigravitySwitch } from '../antigravity-switch-recovery';
import { recoverAntigravityQuota } from '../antigravity-quota-recovery';
import { agentMetadata } from './metadata';
import os from 'os';
import { queryAccessTokenUsage, queryIsolatedUsage, querySharedUsage, AntigravityAccessRejected, AntigravityLoginRequired, resolveAntigravityCli } from '../antigravity-cli';
import { runningClients } from '../clients';
import { stepDiagnostic } from '../diagnostics';
import { CredentialChangedError, LiveWriteDeferred, credentialState, credentialStateFromFiles } from '../credential-state';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { BaseAgent, Identity, AuxiliaryCredential, StatusResult, AccountManagement, CredentialQuery, QueryOptions, LiveMutationJournal, UseOptions, UseResult, type CredentialFiles, type SharedQuotaLogin } from './base';
import { readJsonFile, jwtInfo, fingerprint } from '../utils';
import { listProfiles, profileDir } from '../store';
import { releaseTemporaryCredentials } from '../temporary-credentials';
import {
  readUnavailableDesktopQuotaFile, readActiveDesktopQuotaFile, retryNativeKeychainAccess, assertNativeSwitchReady, nativeLogoutSupport, ConflictingNativeFileLogins, readNativeToken, writeNativeToken, readAuxiliaryNativeTokens, parseNativeToken, findQuotaBearer, readSharedQuotaLogin, compareNativeSessionCopies,
  isRecoverableNativeError, hasPendingNativeCleanup, nativeSwitchFingerprint,
  createNativeMutationJournal, recoverInterruptedNativeSwitch, needsNativeRenewalMigration, sharedAntigravitySessions, quotaFromUsage,
} from '../antigravity-native';

interface TokenPayload {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  id_token_email?: string;
  expiry?: string;
  token?: TokenPayload;
  auth_method?: string;
}

export { LiveWriteDeferred as DeferredNativeRenewal } from '../credential-state';

export const antigravityRenewalHint = 'Antigravity 更新登录状态后，额度会自动刷新。';

export type AntigravityRuntime = 'legacy' | 'unified' | 'unknown';
/** Inspect installed app metadata, never token contents, to choose the adapter. */
export function detectAntigravityRuntime(): AntigravityRuntime {
  if (process.platform === 'win32') return resolveAntigravityCli() ? 'unified' : 'unknown';
  if (process.platform === 'darwin') {
    for (const apps of [path.join(os.homedir(), 'Applications'), '/Applications']) {
      try {
        const plist = fs.readFileSync(path.join(apps, 'Antigravity.app/Contents/Info.plist'));
        const version = plist.subarray(0, 8).toString() === 'bplist00'
          ? /^(\d+)(?:\.|$)/.exec(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', '-'],
              { input: plist, encoding: 'utf8', timeout: 1500, stdio: ['pipe', 'pipe', 'ignore'] }).trim())?.[1]
          : plist.toString().match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)(?:\.|<)/)?.[1];
        if (version) return Number(version) >= 2 ? 'unified' : 'legacy';
      } catch { /* Continue to other install locations. */ }
    }
  }
  // The agy CLI belongs to the unified-auth generation. Do not treat an old
  // jetski token left on disk as evidence that the currently installed app uses it.
  return resolveAntigravityCli() ? 'unified' : 'unknown';
}

export class AntigravityAgent extends BaseAgent {
  readonly id = 'agy';
  readonly label = agentMetadata.agy.label;
  readonly homeDir = path.join(os.homedir(), '.gemini');
  readonly authFiles = [agentMetadata.agy.credential];
  constructor(private readonly runtime: () => AntigravityRuntime = detectAntigravityRuntime,
    private readonly nativeEnabled = ['darwin', 'win32'].includes(process.platform) && runtime() === 'unified') { super(); }

  readCredentials(dir = this.homeDir, quotaCopies?: Buffer[]): Record<string, Buffer | null> {
    return this.nativeEnabled && dir === this.homeDir
      ? { [this.authFiles[0]]: readNativeToken(quotaCopies) } : super.readCredentials(dir);
  }
  readSwitchableCredentials(): { files: Record<string, Buffer | null>; corrupted?: boolean } {
    if (!this.nativeEnabled) return super.readSwitchableCredentials();
    try { return { files: this.readCredentials() }; }
    catch (error) {
      if (isRecoverableNativeError(error)) return { files: { [this.authFiles[0]]: null }, corrupted: true };
      throw error;
    }
  }
  hasPendingSwitchCleanup(): boolean {
    return this.nativeEnabled && hasPendingNativeCleanup();
  }
  switchFingerprint(): string | undefined {
    return this.nativeEnabled ? nativeSwitchFingerprint() : undefined;
  }
  canVerifyReplacement(targetBytes: Buffer | null): boolean {
    return Boolean(this.nativeEnabled && targetBytes && this.identityFromBytes(targetBytes)?.email);
  }
  createMutationJournal(): LiveMutationJournal {
    if (!this.nativeEnabled) return super.createMutationJournal();
    return createNativeMutationJournal() ?? super.createMutationJournal();
  }
  async recoverInterruptedSwitch(): Promise<void> {
    if (this.nativeEnabled) await recoverInterruptedNativeSwitch();
  }
  auxiliaryCredentials(requireAllReadable = false): AuxiliaryCredential[] {
    if (!this.nativeEnabled) return [];
    let primaryBytes: Buffer | null = null;
    try { primaryBytes = this.readCredentials()[this.authFiles[0]]; }
    catch (error) { if (requireAllReadable || !isRecoverableNativeError(error)) throw error; }
    return readAuxiliaryNativeTokens(primaryBytes, requireAllReadable).flatMap(bytes => {
      const identity = this.identityFromBytes(bytes);
      return identity ? [{ identity, files: { [this.authFiles[0]]: bytes } }] : [];
    });
  }
  writeCredentials(dir: string, files: Record<string, Buffer | null>): void {
    if (!this.nativeEnabled || dir !== this.homeDir) return super.writeCredentials(dir, files);
    const bytes = files[this.authFiles[0]];
    writeNativeToken(bytes);
  }
  async writeRenewedCredentials(files: CredentialFiles, expectedRevision?: string): Promise<void> {
    const target = files[this.authFiles[0]];
    const migrate = !!target && this.nativeEnabled && needsNativeRenewalMigration(target);
    if (migrate && ((await runningClients(this.id, { failClosed: true })).length || (await sharedAntigravitySessions()).length)) {
      throw new LiveWriteDeferred('Antigravity 正在使用原登录，请在账号列表中切换以应用新凭据');
    }
    if (credentialState(this).revision !== expectedRevision) throw new CredentialChangedError();
    if (migrate) writeNativeToken(target, { allowFileMigration: true, expectedRevision });
    else this.writeCredentials(this.homeDir, files);
  }
  async use(name: string, options: UseOptions = {}): Promise<UseResult> {
    if (!this.nativeEnabled) return super.use(name, options);
    const unsupported = this.switchSupport();
    if (unsupported) throw new Error(unsupported);
    if ((await sharedAntigravitySessions()).length) throw new Error('请先关闭共用认证的 agy 或 IDE 会话');
    const files = this.credentials(profileDir(this.id, name));
    return this.commitSwitch(files, options, () => {
      const storage = writeNativeToken(files[this.authFiles[0]], {
        clearFallbacks: 'all', expectedFingerprint: options.expectedSwitchFingerprint,
        allowFileMigration: options.allowFileMigration, journal: options.journal,
      });
      if (storage === 'files') return '桌面和 CLI 各使用一份仅当前用户可读写的官方登录文件。';
    });
  }

  identityFromBytes(bytes: Buffer | null, live = false): Identity | undefined {
    if (!this.nativeEnabled) return super.identityFromBytes(bytes, live);
    if (!bytes) return undefined;
    try { return this.identityFromAuth(parseNativeToken(bytes)); }
    catch { return undefined; }
  }
  identity(dir = this.homeDir, files?: CredentialFiles): Identity | undefined {
    if (!this.nativeEnabled && dir === this.homeDir && this.runtime() !== 'legacy') return undefined;
    return super.identity(dir, files);
  }
  identityFromAuth(raw: TokenPayload | null, live = false): Identity | undefined {
    if (!raw) return undefined;
    const token = raw.token || raw;
    const refreshToken = token.refresh_token || raw.refresh_token;
    const accessToken = token.access_token || raw.access_token;
    if (!refreshToken && !accessToken) return undefined;

    const idToken = raw.id_token || token.id_token;
    const info = jwtInfo(idToken);
    let email = typeof raw.id_token_email === 'string' && raw.id_token_email.trim() ? raw.id_token_email.trim()
      : typeof info.email === 'string' && info.email.trim() ? info.email.trim() : undefined;

    // Fallback: check app_storage.json if checking live home directory and JWT email is missing
    if (!email && live) {
      try {
        const appStoragePath = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'app_storage.json');
        const appStorage = readJsonFile<Record<string, unknown>>(appStoragePath);
        if (typeof appStorage?.['jetski.onboarding.lastLoginUsername'] === 'string') {
          email = appStorage['jetski.onboarding.lastLoginUsername'] as string;
        }
      } catch {}
    }

    const normalizedEmail = email?.trim().toLowerCase();
    const sub = typeof info.sub === 'string' && info.sub ? info.sub : undefined;
    const id = (this.nativeEnabled && normalizedEmail) || sub || normalizedEmail || (typeof refreshToken === 'string' && refreshToken ? fingerprint(refreshToken) : undefined);
    if (!id) return undefined;
    return { id, email };
  }

  get clientOwnsRenewal() { return process.platform === 'win32'; }
  get sharedQuotaLogin(): SharedQuotaLogin | undefined { return this.nativeEnabled ? this : undefined; }
  desktopLogin() { return readUnavailableDesktopQuotaFile(); }
  confirmDesktopLogin(expected: Buffer, copies?: Buffer[]) {
    const observed = readActiveDesktopQuotaFile(copies);
    if (!observed || compareNativeSessionCopies(expected, observed) === undefined) throw new CredentialChangedError();
    return observed;
  }
  quotaBearer(bytes: Buffer, copies?: Buffer[], allowUndated?: boolean) {
    return findQuotaBearer(parseNativeToken(bytes), copies, allowUndated);
  }
  ownsQuotaLogin(bytes: Buffer) { return !!readSharedQuotaLogin(bytes); }
  recoverProfileCredential(dir: string, identity: string, original: Buffer) {
    const file = this.authFiles[0];
    return recoverAntigravityQuota(this, identity, original, {
      read: () => this.readCredentials(dir)[file],
      write: bytes => this.writeCredentials(dir, { [file]: bytes }),
      confirmCopies: (bytes, matchesInput) => {
        // A crash after updating one alias must not strand the consumed input in another.
        for (const name of listProfiles(this.id)) {
          const copyDir = profileDir(this.id, name);
          if (copyDir === dir) continue;
          let copy: Buffer | null;
          try { copy = this.readCredentials(copyDir)[file]; } catch { continue; }
          if (!copy || !matchesInput(copy)) continue;
          this.writeCredentials(copyDir, { [file]: bytes });
          if (!this.readCredentials(copyDir)[file]?.equals(bytes)) throw new Error('未能确认账号副本已写回，已保留恢复记录');
        }
      },
    });
  }
  normalizeQuotaHistory(snapshot: StatusResult): StatusResult {
    if (snapshot?.state === 'unverified' && !snapshot.stagedReplacement && snapshot.extra) {
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
  retryCredentialAccess() { retryNativeKeychainAccess(); }
  hasInterruptedSwitch() { return this.nativeEnabled && hasPendingAntigravitySwitch(); }
  needsFileMigration(bytes: Buffer | null) { return this.nativeEnabled && assertNativeSwitchReady(bytes) === 'files'; }
  compareSessionCopies(a: Buffer | null, b: Buffer | null) { return compareNativeSessionCopies(a, b); }
  async sharedSessionIssue() {
    if (this.nativeEnabled && (await sharedAntigravitySessions()).length) return '请先结束共用认证的 agy 或 IDE 会话';
  }
  clientLogoutIssue(): string | undefined {
    if (!this.nativeEnabled) return '此认证存储尚不支持自动退出，请在官方客户端退出';
    try { return nativeLogoutSupport(this.readCredentials()[this.authFiles[0]]); }
    catch (error) { return error instanceof Error ? error.message : '无法可靠确认客户端登录，请在官方客户端退出'; }
  }
  readClientCopies() {
    try { return super.readClientCopies(); }
    catch (error) {
      if (!(error instanceof ConflictingNativeFileLogins)) throw error;
      return readAuxiliaryNativeTokens(null, true);
    }
  }
  switchSupport(): string | undefined {
    if (this.nativeEnabled) return undefined;
    if (this.runtime() === 'legacy') return undefined;
    if (process.platform === 'win32') return '请先安装官方 Antigravity CLI（agy），再重新打开 AGS。';
    return 'Antigravity 2.x 使用 App、CLI 和 IDE 共用认证；旧版凭据文件不能切换当前登录，请在官方客户端管理账号。';
  }
  management(): AccountManagement {
    if (this.nativeEnabled) return { quota: true, storage: 'keychain', canSaveCurrent: true, isolatedLogin: process.platform !== 'win32',
      notice: process.platform === 'win32' ? '支持导入个人 Google 账号，或保存官方客户端的当前登录。切换前请结束共用登录的 CLI 或 IDE。'
        : '支持个人 Google 账号；独立登录和额度刷新需要官方 agy CLI。切换前请结束共用认证的终端或 IDE 会话。' };
    if (process.platform === 'win32') return { quota: false, storage: 'unknown', canSaveCurrent: false,
      notice: '安装官方 Antigravity CLI（agy）后重新打开 AGS，即可使用导入的个人账号切换和查询额度。' };
    const runtime = this.runtime(), legacy = runtime === 'legacy';
    return {
      quota: false, storage: legacy ? 'file' : runtime === 'unified' ? 'unified' : 'unknown', canSaveCurrent: legacy,
      notice: legacy ? '旧版文件凭据模式；切换后需重新打开 Antigravity。' : runtime === 'unified' ? 'Antigravity 2.x 已统一 App、CLI 与 IDE 登录。旧版凭据仅作备份，请在官方客户端切换账号。' : '尚未确认客户端版本；已保存的凭据可管理，登录与切换请在官方客户端完成。',
      loginLabel: '打开 Antigravity', loginHint: '在官方客户端中查看或更改登录账号。',
    };
  }
  credentialStatus(dir = this.homeDir): StatusResult {
    if (!this.nativeEnabled && dir === this.homeDir && this.runtime() !== 'legacy') return { available: false, state: 'unsupported' };
    const status = super.credentialStatus(dir);
    return status.available && !status.account ? { ...status, account: 'Antigravity 账号' } : status;
  }
  async queryCredential(original: Buffer | null, options: QueryOptions = {}): Promise<CredentialQuery> {
    if (!original) return { status: { available: false, state: 'signed-out' } };
    const parsedOriginal = parseNativeToken(original);
    const identity = this.identityFromAuth(parsedOriginal)!;
    if (options.allowRefresh === false) {
      const bearer = findQuotaBearer(parsedOriginal, options.quotaCopies, options.allowUndatedBearer);
      if (bearer?.expiry) stepDiagnostic('access-valid');
      else if (!bearer) {
        const access = parsedOriginal.token.access_token, expiry = parsedOriginal.token.expiry ?? parsedOriginal.expiry;
        if (typeof access !== 'string' || !access.trim()) stepDiagnostic('access-missing');
        else if (typeof expiry === 'string' && Date.parse(expiry) <= Date.now()) stepDiagnostic('access-expired');
      }
      let credentialRevision: string | undefined;
      const status = (error?: Error): CredentialQuery => ({
        waitingForClient: !error,
        status: { available: true, account: identity.email, credentialRevision,
          state: error ? 'error' : 'unverified', extra: error?.message ?? antigravityRenewalHint },
      });
      const queryBearer = async (current: NonNullable<typeof bearer>): Promise<CredentialQuery> => {
        const data = await queryAccessTokenUsage(identity.email!, current.accessToken, current.expiry);
        if (!current.expiry) stepDiagnostic('access-valid');
        return { status: { ...quotaFromUsage(data, identity.email!), credentialRevision } };
      };
      if (options.verifyTarget !== undefined) return status();
      let rejected: AntigravityAccessRejected | undefined;
      if (bearer) {
        try { return await queryBearer(bearer); }
        catch (error) {
          if (!(error instanceof AntigravityAccessRejected)) return status(error as Error);
          if (options.reportRejectedBearer) throw error;
          rejected = error;
        }
      }
      if (!options.withSharedRenewal || !this.nativeEnabled || !readSharedQuotaLogin(original)) return status(rejected);
      stepDiagnostic('shared-renewal');
      let data, sharedError: Error | undefined;
      try { data = await options.withSharedRenewal(querySharedUsage); }
      catch (error) { sharedError = error as Error; }
      const observed = this.readCredentials(this.homeDir, [])[this.authFiles[0]];
      const current = observed && readSharedQuotaLogin(observed);
      if (!current || compareNativeSessionCopies(original, current) === undefined) throw new CredentialChangedError();
      credentialRevision = credentialStateFromFiles(this.id, [[this.authFiles[0], observed]]).revision;
      if (sharedError) return status(sharedError);
      // Windows keeps its verified-bearer query until the shared official runner is validated on-device.
      if (process.platform === 'win32') {
        const renewed = findQuotaBearer(parseNativeToken(current));
        if (!renewed || renewed.accessToken === bearer?.accessToken) return status(rejected ?? new Error('Antigravity 尚未更新当前登录，稍后将重试额度查询。'));
        try { return await queryBearer(renewed); } catch (error) { return status(error as Error); }
      }
      try { return { status: { ...quotaFromUsage(data ?? {}, identity.email!), credentialRevision } }; }
      catch (error) { return status(error as Error); }
    }
    if (options.verifyTarget !== undefined) {
      const expected = options.verifyTarget ? this.identityFromBytes(options.verifyTarget) : undefined;
      if (!expected) {
        return {
          status: { available: true, account: identity.email, state: 'error', extra: '原账号缺少可验证身份，已保留原凭据；请使用「重新登录」完成官方授权' },
          verifiedReplacement: false,
        };
      }
      const stripped = Buffer.from(JSON.stringify({ auth_method: 'consumer', token: { refresh_token: parsedOriginal.token.refresh_token } }));
      const result = await queryIsolatedUsage(stripped, expected.id, parsedOriginal.token.refresh_token);
      const didRotate = !stripped.equals(result.rotated);
      let verifiedIdentity: Identity | undefined;
      try { verifiedIdentity = this.identityFromAuth(parseNativeToken(result.rotated)); } catch {}
      let quotaStatus: StatusResult | undefined;
      let usageError = result.error;
      if (!usageError && verifiedIdentity && verifiedIdentity.id === expected.id) {
        try { quotaStatus = { ...quotaFromUsage(result.data || {}, verifiedIdentity.email!), plan: result.plan }; }
        catch (error) { usageError = error as Error; }
      }
      if (!verifiedIdentity || verifiedIdentity.id !== expected.id || usageError || !quotaStatus) {
        if (!didRotate && result.temporaryDirectory) releaseTemporaryCredentials(result.temporaryDirectory);
        const expired = usageError instanceof AntigravityLoginRequired;
        const baseExtra = !verifiedIdentity ? '未能通过官方刷新核实凭据归属，已保留原凭据；请使用「重新登录」更新'
          : verifiedIdentity.id !== expected.id ? '新凭据经官方验证不属于此账号，已保留原凭据；请使用「重新登录」更新'
          : `${usageError!.message}（已保留原凭据；可使用「重新登录」更新）`;
        const extra = didRotate && result.temporaryDirectory
          ? `${baseExtra}；未写回的凭据已保留在 ${result.temporaryDirectory}，恢复前请勿清理该目录`
          : baseExtra;
        return {
          status: { available: true, account: expected.email, state: expired ? 'expired' : 'error', authExpired: expired, extra },
          rotated: didRotate ? result.rotated : undefined,
          temporaryDirectory: didRotate ? result.temporaryDirectory : undefined,
          verifiedReplacement: false,
        };
      }
      return { status: quotaStatus, rotated: result.rotated, temporaryDirectory: result.temporaryDirectory, verifiedReplacement: true };
    }
    const result = await queryIsolatedUsage(original, identity.id, parsedOriginal.token.refresh_token);
    try {
      if (this.identityFromAuth(parseNativeToken(result.rotated))?.id !== identity.id) throw new CredentialChangedError();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('无法确认查询后的账号身份');
      if (result.temporaryDirectory) failure.message += `；临时凭据已保留在 ${result.temporaryDirectory}`;
      throw failure;
    }
    let status: StatusResult;
    try {
      if (result.error) throw result.error;
      status = { ...quotaFromUsage(result.data || {}, identity.email!), plan: result.plan };
    } catch (error) {
      const expired = error instanceof AntigravityLoginRequired;
      status = { available: true, account: identity.email, state: expired ? 'expired' : 'error',
        authExpired: expired, extra: (error as Error).message };
    }
    return { status, rotated: original.equals(result.rotated) ? undefined : result.rotated, temporaryDirectory: result.temporaryDirectory };
  }
}

export const antigravityAgent = new AntigravityAgent();
