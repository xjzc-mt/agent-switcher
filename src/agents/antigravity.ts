import os from 'os';
import { queryIsolatedUsage, AntigravityLoginRequired } from '../antigravity-cli';
import { CredentialChangedError } from '../credential-state';
import path from 'path';
import fs from 'fs';
import { BaseAgent, Identity, StatusResult, AccountManagement, CredentialQuery } from './base';
import { readJsonFile, jwtInfo, fingerprint } from '../utils';
import { readNativeToken, writeNativeToken, parseNativeToken, sharedAntigravitySessions, quotaFromUsage } from '../antigravity-native';

interface TokenPayload {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  id_token_email?: string;
  expiry?: string;
  token?: TokenPayload;
  auth_method?: string;
}

export type AntigravityRuntime = 'legacy' | 'unified' | 'unknown';
/** Inspect installed app metadata, never token contents, to choose the adapter. */
export function detectAntigravityRuntime(): AntigravityRuntime {
  if (process.platform === 'darwin') {
    for (const apps of [path.join(os.homedir(), 'Applications'), '/Applications']) {
      try {
        const plist = fs.readFileSync(path.join(apps, 'Antigravity.app/Contents/Info.plist'), 'utf8');
        const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./)?.[1];
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

  readCredentials(dir = this.homeDir): Record<string, Buffer | null> {
    return this.nativeEnabled && dir === this.homeDir
      ? { [this.authFiles[0]]: readNativeToken() } : super.readCredentials(dir);
  }
  writeCredentials(dir: string, files: Record<string, Buffer | null>): void {
    if (!this.nativeEnabled || dir !== this.homeDir) return super.writeCredentials(dir, files);
    const bytes = files[this.authFiles[0]];
    writeNativeToken(bytes);
  }
  async use(name: string) {
    if (this.nativeEnabled && (await sharedAntigravitySessions()).length) throw new Error('请先关闭共用认证的 agy 或 IDE 会话');
    return super.use(name);
  }

  identityFromBytes(bytes: Buffer | null): Identity | undefined {
    if (!this.nativeEnabled) return super.identityFromBytes(bytes);
    if (!bytes) return undefined;
    try { return this.identityFromAuth(parseNativeToken(bytes)); }
    catch { return undefined; }
  }
  identity(dir = this.homeDir): Identity | undefined {
    if (this.nativeEnabled) return this.identityFromBytes(this.readCredentials(dir)[this.authFiles[0]]);
    if (dir === this.homeDir && this.runtime() !== 'legacy') return undefined;
    const raw = readJsonFile<TokenPayload>(path.join(dir, 'jetski-standalone-oauth-token'));
    return this.identityFromAuth(raw, dir === this.homeDir);
  }
  identityFromAuth(raw: TokenPayload | null, live = false): Identity | undefined {
    if (!raw) return undefined;
    const token = raw.token || raw;
    const refreshToken = token.refresh_token || raw.refresh_token;
    const accessToken = token.access_token || raw.access_token;
    if (!refreshToken && !accessToken) return undefined;

    const idToken = raw.id_token || token.id_token;
    const info = jwtInfo(idToken);
    let email = raw.id_token_email || info.email;

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

    const id = (this.nativeEnabled && email?.toLowerCase()) || info.sub || email || (refreshToken ? fingerprint(refreshToken) : undefined);
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
  async queryCredential(original: Buffer | null): Promise<CredentialQuery> {
    if (!original) return { status: { available: false, state: 'signed-out' } };
    const identity = this.identityFromAuth(parseNativeToken(original))!;
    const result = await queryIsolatedUsage(original);
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

