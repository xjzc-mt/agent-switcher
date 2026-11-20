import os from 'os';
import path from 'path';
import { BaseAgent, Identity, StatusResult, AccountManagement } from './base';
import { fingerprint, jwtInfo, readJsonFile } from '../utils';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findClaudeBinary } from '../clients';
const run = promisify(execFile);

interface Credentials {
  email?: string; account?: { email?: string };
  claudeAiOauth?: { accessToken?: string; refreshToken?: string; subscriptionType?: string };
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string };
  sessionKey?: string;
}
export class ClaudeAgent extends BaseAgent {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  readonly homeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  readonly authFiles = ['.credentials.json'];
  private observed?: StatusResult;
  private pendingStatus?: Promise<StatusResult>;
  identityFromAuth(creds: Credentials | null): Identity | undefined {
    const token = creds?.claudeAiOauth?.refreshToken || creds?.tokens?.refresh_token || creds?.claudeAiOauth?.accessToken || creds?.tokens?.access_token || creds?.sessionKey;
    if (typeof token !== 'string' || !token) return undefined;
    const info = jwtInfo(creds?.tokens?.id_token);
    const rawEmail = creds?.account?.email || creds?.email || info.email;
    const email = typeof rawEmail === 'string' && rawEmail.trim() ? rawEmail.trim() : undefined;
    const sub = typeof info.sub === 'string' && info.sub ? info.sub : undefined;
    return { id: sub || email?.toLowerCase() || fingerprint(token), email };
  }
  switchSupport(): string | undefined {
    if (this.observed?.available && this.observed.authMethod !== 'claude.ai') return 'Claude Code 正在使用非订阅认证，请先在官方 CLI 中更改认证方式。';
    return process.platform === 'darwin' ? 'Claude Code 在 macOS 优先使用 Keychain；文件凭据不能可靠切换当前登录，请使用官方登录。' : undefined;
  }
  management(): AccountManagement {
    const keychain = process.platform === 'darwin';
    return {
      quota: false, storage: keychain ? 'keychain' : 'file', canSaveCurrent: !keychain && (!this.observed || (this.observed.available && this.observed.authMethod === 'claude.ai')),
      notice: keychain ? '登录由 Claude Code 管理，已保存的文件凭据可导入、导出；暂不支持 Keychain 账号切换。' : '管理 Claude Code 文件凭据；切换后需重新打开终端会话。',
      loginLabel: '在 Claude Code 登录',
      loginHint: '运行官方 auth login，会改变当前配置目录的登录账号。',
    };
  }
  credentialStatus(dir = this.homeDir): StatusResult {
    const creds = readJsonFile<Credentials>(path.join(dir, '.credentials.json'));
    const identity = this.identityFromAuth(creds);
    return {
      available: !!identity, account: identity?.email || (identity ? '文件 OAuth 凭据' : undefined),
      plan: typeof creds?.claudeAiOauth?.subscriptionType === 'string' ? creds.claudeAiOauth.subscriptionType : undefined,
      state: identity ? 'unverified' : 'signed-out',
    };
  }
  displayStatus(): StatusResult {
    return this.observed || (process.platform === 'darwin' ? { available: false, state: 'unverified' } : this.credentialStatus());
  }
  async status(dir = this.homeDir): Promise<StatusResult> {
    if (dir !== this.homeDir) return this.credentialStatus(dir);
    if (this.pendingStatus) return this.pendingStatus;
    this.pendingStatus = (async () => {
      try {
        let stdout: string;
        try {
          ({ stdout } = await run(findClaudeBinary(), ['auth', 'status'], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: this.homeDir }, timeout: 8000, maxBuffer: 65536,
          }));
        } catch (error) {
          // auth status exits 1 for a signed-out account, still returning JSON.
          const e = error as { code?: number; stdout?: string };
          if (e.code !== 1 || !e.stdout) throw error;
          stdout = e.stdout;
        }
        this.observed = parseClaudeAuthStatus(stdout);
      } catch {
        // Never reinterpret a missing/old CLI or locked Keychain as expired OAuth.
        this.observed = { available: false, state: 'error', extra: '无法读取 Claude Code 登录状态，请确认 CLI 已安装且 Keychain 可访问。' };
      }
      return this.observed;
    })().finally(() => { this.pendingStatus = undefined; });
    return this.pendingStatus;
  }
}
export function parseClaudeAuthStatus(stdout: string): StatusResult {
  const raw = JSON.parse(stdout);
  if (!raw || typeof raw.loggedIn !== 'boolean' || typeof raw.authMethod !== 'string') throw new Error('无法识别 Claude Code 登录状态');
  const subscription = raw.authMethod === 'claude.ai';
  return {
    available: raw.loggedIn,
    authMethod: raw.authMethod,
    state: raw.loggedIn ? 'ok' : 'signed-out',
    account: raw.loggedIn && typeof raw.email === 'string' ? raw.email : raw.loggedIn ? (subscription ? 'Claude 账号' : '非订阅认证') : undefined,
    plan: subscription && typeof raw.subscriptionType === 'string' ? raw.subscriptionType : undefined,
    extra: raw.loggedIn && !subscription ? '当前 CLI 使用非订阅认证，未关联可切换的订阅账号。' : undefined,
    checkedAt: new Date().toISOString(),
  };
}
export const claudeAgent = new ClaudeAgent();
