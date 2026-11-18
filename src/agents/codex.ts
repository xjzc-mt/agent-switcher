import os from 'os';
import path from 'path';
import fs from 'fs';
import { startCodexProcess } from '../codex-process';
import { BaseAgent, StatusResult, QuotaDetail, QuotaWindow, Identity, CredentialQuery } from './base';
import { atomicWrite, readBuffer, jwtInfo, fingerprint } from '../utils';
import { CredentialChangedError } from '../credential-state';
import { createTemporaryCredentials, markTemporaryCredentialsPending, releaseTemporaryCredentials } from '../temporary-credentials';

interface CodexAuth {
  OPENAI_API_KEY?: string;
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string; email?: string };
}
interface RateWindow { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null }
interface RateLimit {
  limitId?: string; limitName?: string; planType?: string;
  primary?: RateWindow | null; secondary?: RateWindow | null;
  credits?: { balance?: string; unlimited?: boolean; hasCredits?: boolean };
}
interface Account { email?: string; planType?: string; type?: string }
type AuthFailure = NonNullable<StatusResult['authFailure']>;
export class CodexQueryError extends Error {
  constructor(message: string, readonly authFailure?: AuthFailure) { super(message); }
}

/** Keep only allowlisted reasons; never persist or display raw RPC text. */
export function codexAuthFailure(error: unknown, depth = 0): AuthFailure | undefined {
  if (depth > 5) return undefined;
  if (typeof error === 'string') {
    if (/refresh[_ -]?token[_ -]?reused|refresh token.{0,140}already been used/i.test(error)) return 'refresh-reused';
    if (/refresh[_ -]?token[_ -]?(?:invalidated|revoked)|refresh token.{0,140}revoked/i.test(error)) return 'refresh-revoked';
    if (/refresh[_ -]?token[_ -]?expired|refresh token.{0,140}expired/i.test(error)) return 'refresh-expired';
    if (/refresh[_ -]?token[_ -]?invalid|refresh token.{0,140}invalid|invalid[_ -]?grant|凭据失效/i.test(error)) return 'refresh-invalid';
    if (/refresh[_ -]?token[_ -]?(?:reused|expired|revoked|invalid)|token[_ -]?expired|invalid[_ -]?(?:grant|token)|insufficient_user_authentication|\bunauthori[sz]ed\b|\bunauthenticated\b|\bnot (?:authenticated|logged in)\b|refresh token.{0,140}(?:already been used|expired|revoked|invalid)|(?:HTTP(?: error| status)?|status(?: code)?)\s*[:=]?\s*401\b|^401\b|凭据失效/i.test(error)) return 'authentication-rejected';
    return undefined;
  }
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Record<string, unknown>;
  const reasons = ['code', 'message', 'data', 'error', 'error_description', 'reason', 'cause'].map(key => codexAuthFailure(value[key], depth + 1));
  return reasons.find(reason => reason?.startsWith('refresh-')) || reasons.find(Boolean) ||
    (['code', 'status', 'statusCode', 'httpStatusCode'].some(key => value[key] === 401 || value[key] === '401') ? 'authentication-rejected' : undefined);
}
function queryError(error: unknown): CodexQueryError {
  const reason = codexAuthFailure(error);
  return new CodexQueryError(reason?.startsWith('refresh-') ? '凭据失效，请更新凭据' :
    reason ? '认证请求未通过，请刷新重试' : '额度查询失败，请稍后重试', reason);
}
interface RateResponse { rateLimits?: RateLimit | null; rateLimitsByLimitId?: Record<string, RateLimit | null> | null; rateLimitResetCredits?: unknown }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const positiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

export function parseQuota(response?: RateResponse | null): QuotaDetail | undefined {
  if (!isRecord(response)) return undefined;
  const limits = new Map<string, RateLimit>();
  const legacy = isRecord(response.rateLimits) ? response.rateLimits : undefined;
  // Legacy responses without a bucket ID describe Codex. An explicitly named
  // model-specific bucket must never be displayed as the general Codex quota.
  if (legacy) limits.set(typeof legacy.limitId === 'string' && legacy.limitId ? legacy.limitId : 'codex', legacy);
  if (isRecord(response.rateLimitsByLimitId)) {
    for (const [id, value] of Object.entries(response.rateLimitsByLimitId)) {
      if (!isRecord(value)) continue;
      // When the multi-bucket view is incomplete, supplement omitted fields
      // from the same legacy bucket, but preserve explicit nulls.
      const defined = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
      limits.set(id, { ...limits.get(id), ...defined });
    }
  }
  const window = (w?: RateWindow | null): QuotaWindow | undefined => {
    if (!isRecord(w) || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return undefined;
    const resetsAt = positiveNumber(w.resetsAt);
    return {
      usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
      windowMins: positiveNumber(w.windowDurationMins),
      // The app-server contract uses Unix seconds. Do not infer a reset from
      // plan names or substitute another window's reset when it is missing.
      resetsAt: resetsAt !== undefined && Number.isFinite(new Date(resetsAt * 1000).getTime()) ? resetsAt : undefined,
    };
  };
  const main = limits.get('codex');
  if (!limits.size) return undefined;
  const reset = response.rateLimitResetCredits;
  // Only the explicit backend count establishes available rights. Detail rows
  // may be null, empty, or capped; their length is never a replacement count.
  const resetCredits = isRecord(reset) && Number.isSafeInteger(reset.availableCount) && Number(reset.availableCount) >= 0 ? {
    availableCount: Number(reset.availableCount),
    credits: Array.isArray(reset.credits) ? reset.credits.filter(isRecord).filter(c => typeof c.id === 'string').map(c => ({
      id: String(c.id), resetType: typeof c.resetType === 'string' ? c.resetType : 'unknown',
      status: typeof c.status === 'string' ? c.status : 'unknown', grantedAt: positiveNumber(c.grantedAt),
      expiresAt: c.expiresAt === null ? null : positiveNumber(c.expiresAt),
      title: typeof c.title === 'string' ? c.title : undefined,
      description: typeof c.description === 'string' ? c.description : undefined,
    })) : null,
  } : undefined;
  return {
    plan: main?.planType,
    primaryWindow: window(main?.primary), secondaryWindow: window(main?.secondary), credits: main?.credits ?? undefined,
    ...(resetCredits ? { resetCredits } : {}),
    buckets: [...limits].map(([id, value]) => ({
      id, label: value.limitName || id,
      windows: [window(value.primary), window(value.secondary)].filter((w): w is QuotaWindow => !!w),
    })),
  };
}

export class CodexAgent extends BaseAgent {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly homeDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  readonly authFiles = ['auth.json'];

  identityFromAuth(auth: CodexAuth | null): Identity | undefined {
    if (auth?.OPENAI_API_KEY) return { id: fingerprint(auth.OPENAI_API_KEY) };
    if (!auth?.tokens?.access_token || !auth.tokens.refresh_token) return undefined;
    const info = jwtInfo(auth.tokens.id_token);
    const email = info.email || auth.tokens.email;
    // A workspace ID alone cannot distinguish its different members.
    const user = info.sub || email;
    const id = user ? [auth.tokens.account_id, user].filter(Boolean).join(':') : undefined;
    return { id: id || fingerprint(auth.tokens.refresh_token), email };
  }

  findCodexBinary(appDirs = [
    '/Applications/Codex.app', '/Applications/ChatGPT.app',
    path.join(os.homedir(), 'Applications/Codex.app'), path.join(os.homedir(), 'Applications/ChatGPT.app'),
  ]): string | undefined {
    const candidates = [
      ...appDirs.flatMap(dir => [
        path.join(dir, 'Contents/Resources/codex'),
        path.join(dir, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
      ]),
      ...((process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'codex'))),
      '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex'),
    ];
    return candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
  }

  // Protocol: https://developers.openai.com/codex/app-server#initialization
  queryLiveRpc(home: string): Promise<{ account?: Account | null; rates?: RateResponse }> {
    const bin = this.findCodexBinary();
    if (!bin) return Promise.reject(new Error('未找到 Codex CLI'));
    return new Promise((resolve, reject) => {
      let refreshAttempted = false;
      let refreshFailure: AuthFailure | undefined;
      let stderrTail = '';
      let account: Account | null | undefined;
      let outcome: { error?: Error; rates?: RateResponse } | undefined;
      const finish = (error?: Error, rates?: RateResponse) => {
        if (outcome) return;
        outcome = { error, rates };
        clearTimeout(timer);
        server.stop();
      };
      const timer = setTimeout(() => finish(new Error('额度查询超时，请稍后重试')), 20000);
      const refreshLogin = () => {
        if (refreshAttempted) return false;
        refreshAttempted = true;
        server.send({ method: 'account/read', id: 3, params: { refreshToken: true } });
        return true;
      };
      const server = startCodexProcess(bin, home, {
        onError: kind => finish(new Error(kind === 'start' ? '无法启动 Codex CLI' : 'Codex 连接已关闭')),
        onClose() {
          clearTimeout(timer);
          if (!outcome) reject(new Error('Codex 查询进程提前退出'));
          else if (outcome.error) reject(outcome.error);
          else resolve({ account, rates: outcome.rates });
        },
        onStderr(chunk) {
          // Some CLI versions return account:null after logging a failed refresh.
          // Retain only a known reason, never the log text or token material.
          stderrTail = (stderrTail + chunk.toString()).slice(-8192);
          const lines = stderrTail.split('\n'); stderrTail = lines.pop() || '';
          for (const line of lines) {
            if (!/failed to refresh token|refresh token could not be refreshed|access token could not be refreshed/i.test(line)) continue;
            const reason = codexAuthFailure(line);
            if (reason?.startsWith('refresh-')) refreshFailure = reason;
          }
        },
        onMessage(msg) {
          if (outcome || ![0, 1, 2, 3].includes(msg.id)) return;
          if (msg.error) {
            const error = queryError(msg.error);
            if (msg.id !== 0 && error.authFailure === 'authentication-rejected' && refreshLogin()) return;
            finish(error);
          } else if (msg.id === 0) {
            server.send({ method: 'initialized' });
            server.send({ method: 'account/read', id: 1, params: { refreshToken: false } });
          } else if (msg.id === 1 || msg.id === 3) {
            account = msg.result?.account;
            if (!account) {
              if (!refreshLogin()) finish(refreshFailure
                ? new CodexQueryError('凭据失效，请更新凭据', refreshFailure)
                : new CodexQueryError('未读取到登录状态，请刷新重试', 'account-unavailable'));
            }
            else if (account.type === 'apiKey') finish();
            else server.send({ method: 'account/rateLimits/read', id: 2 });
          } else if (msg.id === 2) finish(undefined, msg.result);
        },
      });
      server.send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'agent-switcher', version: require('../../package.json').version } } });
    });
  }

  // The RPC receives only a private copy. The caller commits a rotation under the store lock.
  async queryCredential(original: Buffer | null): Promise<CredentialQuery> {
    let auth: CodexAuth | null = null;
    try { if (original) auth = JSON.parse(original.toString()); } catch { /* Invalid file login. */ }
    const identity = this.identityFromAuth(auth);
    if (!identity || !original) return { status: { available: false, state: 'signed-out', extra: '未找到文件凭据；Keychain 登录暂不支持' } };
    const account = identity.email || 'API / OAuth 账号';
    const checkedAt = new Date().toISOString();
    if (auth?.OPENAI_API_KEY) return { status: { available: true, account: 'API Key', state: 'unsupported', extra: 'API Key 不提供订阅额度', checkedAt } };
    const temp = createTemporaryCredentials('quota');
    try {
      markTemporaryCredentialsPending(temp);
      atomicWrite(path.join(temp, 'auth.json'), original);
      let status: StatusResult;
      try {
        const live = await this.queryLiveRpc(temp);
        const quota = live.rates ? parseQuota(live.rates) : undefined;
        status = {
          available: true, account: live.account?.email || account,
          plan: quota?.plan && quota.plan !== 'unknown' ? quota.plan : live.account?.planType,
          quota, state: quota ? 'ok' : 'unsupported', authExpired: false, checkedAt,
          fetchedAt: quota ? checkedAt : undefined, extra: quota ? undefined : '此账号未返回额度数据',
        };
      } catch (error) {
        const message = (error as Error).message;
        const authFailure = error instanceof CodexQueryError ? error.authFailure : codexAuthFailure(message);
        const expired = !!authFailure?.startsWith('refresh-');
        status = { available: true, account, state: expired ? 'expired' : 'error', authExpired: expired, extra: message, authFailure, checkedAt };
      }
      const updated = readBuffer(path.join(temp, 'auth.json'));
      if (updated && !original.equals(updated)) {
        const returnedIdentity = this.identity(temp);
        if (!returnedIdentity || returnedIdentity.id !== identity.id) throw new CredentialChangedError();
        return { status, rotated: updated, temporaryDirectory: temp };
      }
      releaseTemporaryCredentials(temp);
      return { status };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('额度查询未完成');
      failure.message += `；临时凭据已保留在 ${temp}`;
      throw failure;
    }
  }

}
export const codexAgent = new CodexAgent();
