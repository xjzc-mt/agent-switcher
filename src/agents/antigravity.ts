import os from 'os';
import { queryAccessTokenUsage, queryIsolatedUsage, AntigravityLoginRequired } from '../antigravity-cli';
import { stepDiagnostic } from '../diagnostics';
import { CredentialChangedError, credentialStateFromFiles } from '../credential-state';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { BaseAgent, Identity, AuxiliaryCredential, StatusResult, AccountManagement, CredentialQuery, QueryOptions, LiveMutationJournal, UseOptions, UseResult, type CredentialFiles } from './base';
import { readJsonFile, jwtInfo, fingerprint } from '../utils';
import { profileDir } from '../store';
import { releaseTemporaryCredentials } from '../temporary-credentials';
import {
  readNativeToken, writeNativeToken, readAuxiliaryNativeTokens, parseNativeToken, findQuotaBearer,
  isRecoverableNativeError, hasPendingNativeCleanup, nativeSwitchFingerprint,
  createNativeMutationJournal, recoverInterruptedNativeSwitch, sharedAntigravitySessions, quotaFromUsage,
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

export const antigravityRenewalHint = 'Antigravity 更新登录状态后，额度会自动刷新。';

export type AntigravityRuntime = 'legacy' | 'unified' | 'unknown';
/** Inspect installed app metadata, never token contents, to choose the adapter. */
export function detectAntigravityRuntime(): AntigravityRuntime {
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
  if ([path.join(os.homedir(), '.local/bin/agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy'].some(file => fs.existsSync(file))) return 'unified';
  return 'unknown';
}

export class AntigravityAgent extends BaseAgent {
  readonly id = 'agy';
  readonly label = 'Antigravity';
  readonly homeDir = path.join(os.homedir(), '.gemini');
  readonly authFiles = ['jetski-standalone-oauth-token'];
  constructor(private readonly runtime: () => AntigravityRuntime = detectAntigravityRuntime,
    private readonly nativeEnabled = process.platform === 'darwin' && runtime() === 'unified') { super(); }

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
  auxiliaryCredentials(): AuxiliaryCredential[] {
    if (!this.nativeEnabled) return [];
    let primaryBytes: Buffer | null = null;
    try { primaryBytes = this.readCredentials()[this.authFiles[0]]; }
    catch (error) { if (!isRecoverableNativeError(error)) throw error; }
    return readAuxiliaryNativeTokens(primaryBytes).flatMap(bytes => {
      const identity = this.identityFromBytes(bytes);
      return identity ? [{ identity, files: { [this.authFiles[0]]: bytes } }] : [];
    });
  }
  writeCredentials(dir: string, files: Record<string, Buffer | null>): void {
    if (!this.nativeEnabled || dir !== this.homeDir) return super.writeCredentials(dir, files);
    const bytes = files[this.authFiles[0]];
    writeNativeToken(bytes);
  }
  async use(name: string, options: UseOptions = {}): Promise<UseResult> {
    if (!this.nativeEnabled) return super.use(name, options);
    const unsupported = this.switchSupport();
    if (unsupported) throw new Error(unsupported);
    if ((await sharedAntigravitySessions()).length) throw new Error('请先关闭共用认证的 agy 或 IDE 会话');
    const files = this.credentials(profileDir(this.id, name));
    const targetBytes = files[this.authFiles[0]];
    options.journal?.beginWrite?.(credentialStateFromFiles(this.id, Object.entries(files)).revision);
    const storage = writeNativeToken(targetBytes, {
      clearFallbacks: 'all',
      expectedFingerprint: options.expectedSwitchFingerprint,
      allowFileMigration: options.allowFileMigration,
      journal: options.journal,
    });
    options.journal?.markWriteCompleted?.();
    const warnings = ['已更新本地凭据；已打开的终端会话需要重新启动。'];
    if (storage === 'files') warnings.push('桌面和 CLI 各使用一份仅当前用户可读写的官方登录文件。');
    return { ok: true, files: Object.keys(files).filter(f => files[f]), warnings };
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

  switchSupport(): string | undefined {
    if (this.nativeEnabled) return undefined;
    if (this.runtime() === 'legacy') return undefined;
    return 'Antigravity 2.x 使用 App、CLI 和 IDE 共用认证；旧版凭据文件不能切换当前登录，请在官方客户端管理账号。';
  }
  management(): AccountManagement {
    if (this.nativeEnabled) return { quota: true, storage: 'keychain', canSaveCurrent: true, isolatedLogin: true,
      notice: '支持个人 Google 账号；独立登录和额度刷新需要官方 agy CLI。切换前请结束共用认证的终端或 IDE 会话。' };
    const runtime = this.runtime(), legacy = runtime === 'legacy';
    return {
      quota: false, storage: legacy ? 'file' : runtime === 'unified' ? 'unified' : 'unknown', canSaveCurrent: legacy,
      notice: legacy ? '旧版文件凭据模式；切换后需重新打开 Antigravity。' : runtime === 'unified' ? 'Antigravity 2.x 已统一 App、CLI 与 IDE 登录。旧版凭据仅作备份，请在官方客户端切换账号。' : '尚未确认客户端版本；已保存的凭据可管理，登录与切换请在官方客户端完成。',
      loginLabel: '打开 Antigravity', loginHint: '在官方客户端中查看或更改登录账号。',
    };
  }
  credentialStatus(dir = this.homeDir): StatusResult {
    if (!this.nativeEnabled && dir === this.homeDir && this.runtime() !== 'legacy') return { available: false, state: 'unsupported' };
    const identity = this.identity(dir);
    return {
      available: !!identity,
      account: identity?.email || (identity ? 'Antigravity 账号' : undefined),
      state: identity ? 'unverified' : 'signed-out',
    };
  }
  async queryCredential(original: Buffer | null, options: QueryOptions & { quotaCopies?: Buffer[]; allowUndatedBearer?: boolean } = {}): Promise<CredentialQuery> {
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
      if (options.verifyTarget === undefined && bearer) {
        try {
          const data = await queryAccessTokenUsage(identity.email!, bearer.accessToken, bearer.expiry);
          if (!bearer.expiry) stepDiagnostic('access-valid');
          return { status: quotaFromUsage(data, identity.email!) };
        } catch (error) {
          return { status: { available: true, account: identity.email, state: 'error', extra: (error as Error).message } };
        }
      }
      return {
        status: {
          available: true, account: identity.email, state: 'unverified',
          extra: antigravityRenewalHint,
        },
      };
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

  async status(dir = this.homeDir): Promise<StatusResult> {
    return this.nativeEnabled ? super.status(dir) : this.credentialStatus(dir);
  }
}

export const antigravityAgent = new AntigravityAgent();
