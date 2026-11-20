import os from 'os';
import path from 'path';
import fs from 'fs';
import { findWindowsCodexBinary, startCodexProcess } from '../codex-process';
import { windowsCodexFileIssue } from '../codex-file-auth';
import { stepDiagnostic } from '../diagnostics';
import { BaseAgent, StatusResult, QuotaDetail, QuotaWindow, Identity, CredentialQuery, QueryOptions } from './base';
import { atomicWrite, readBuffer, jwtInfo, fingerprint, differentEmail } from '../utils';
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

const SENTINEL_SUB = 'ags-unverified-sentinel';
const SENTINEL_EMAIL = 'unverified@ags.invalid';
function makeSentinelJwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.sig`;
}

function tokenClaims(token?: string) {
  const info = jwtInfo(token);
  const profile = info['https://api.openai.com/profile'], auth = info['https://api.openai.com/auth'];
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  return {
    sub: text(info.sub), member: isRecord(auth) ? text(auth.user_id) || text(auth.chatgpt_user_id) : undefined,
    email: text(info.email) || (isRecord(profile) ? text(profile.email) : undefined),
    workspace: isRecord(auth) ? text(auth.chatgpt_account_id) : undefined,
  };
}

function codexAuthClaims(auth: CodexAuth | null) {
  const tokens = auth?.tokens, id = tokenClaims(tokens?.id_token), access = tokenClaims(tokens?.access_token);
  const listedEmail = typeof tokens?.email === 'string' ? tokens.email.trim() || undefined : undefined;
  const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id.trim() || undefined : undefined;
  const sub = id.sub || access.sub || access.member || id.member;
  const email = id.email || access.email || listedEmail;
  const jwtAccountId = access.workspace || id.workspace;
  const conflict = Boolean((id.sub && access.sub && id.sub !== access.sub) ||
    (id.member && access.member && id.member !== access.member) || differentEmail(id.email, access.email) ||
    differentEmail(email, listedEmail) || (id.workspace && access.workspace && id.workspace !== access.workspace) ||
    (accountId && jwtAccountId && accountId !== jwtAccountId));
  // A successful quota request authenticates the bearer sent to the service.
  // account/read alone can simply echo an unverified id_token on disk.
  const userBound = id.sub ? access.sub === id.sub : id.member ? access.member === id.member :
    Boolean(access.sub || access.member || (access.email && !differentEmail(access.email, email)));
  const bearerBound = !conflict && userBound && (!email || !!access.email) &&
    (!accountId && !jwtAccountId || access.workspace === (accountId || jwtAccountId));
  return { tokens, email, sub, accountId, jwtAccountId, conflict, bearerBound };
}

function consumedRotation(original: CodexAuth | null, updated: CodexAuth | null, account: string, checkedAt: string, directory: string): CredentialQuery | undefined {
  const previous = original?.tokens?.refresh_token, next = updated?.tokens?.refresh_token;
  if (!previous || typeof next !== 'string' || !next || next === previous || !updated?.tokens?.access_token) return;
  // Keeping the directory outside commitQuery preserves the only copy until the user resolves the mismatch.
  return { status: { available: true, account, checkedAt, state: 'expired', authExpired: true, refreshConsumed: true,
    extra: `旧续期凭据已轮换，无法确认新凭据属于登记账号，已停止使用旧凭据。请重新授权；恢复副本保留在 ${directory}` } };
}

export class CodexAgent extends BaseAgent {
  readonly id = 'codex';
  readonly label = 'Codex';
  // Remember the exact bearer/identity pair issued together by the official exchange.
  // Quota still requires a successful authenticated request. Imported metadata confers no trust.
  private readonly verifiedGenerations = new Set<string>();
  readonly homeDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  readonly authFiles = ['auth.json'];

  switchSupport(): string | undefined {
    return process.platform === 'win32' ? windowsCodexFileIssue(this.homeDir) : undefined;
  }
  management() {
    const defaults = super.management(), notice = this.switchSupport();
    return notice ? { ...defaults, storage: 'unknown' as const, canSaveCurrent: false,
      isolatedLogin: !windowsCodexFileIssue(this.homeDir, true), notice } : defaults;
  }
  readCredentials(dir = this.homeDir) {
    if (dir === this.homeDir && this.switchSupport()) return { 'auth.json': null };
    return super.readCredentials(dir);
  }
  writeCredentials(dir: string, files: Record<string, Buffer | null>): void {
    const issue = dir === this.homeDir && this.switchSupport();
    if (issue) throw new Error(issue);
    super.writeCredentials(dir, files);
  }

  identityFromAuth(auth: CodexAuth | null): Identity | undefined {
    if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) return { id: fingerprint(auth.OPENAI_API_KEY) };
    const { tokens, email, sub, accountId, jwtAccountId } = codexAuthClaims(auth);
    if (typeof tokens?.access_token !== 'string' || !tokens.access_token || typeof tokens?.refresh_token !== 'string' || !tokens.refresh_token) return undefined;
    const workspace = accountId || jwtAccountId;
    // A workspace ID alone cannot distinguish its different members.
    const user = sub || email?.toLowerCase();
    const id = user ? [workspace, user].filter(Boolean).join(':') : undefined;
    return { id: id || fingerprint(`${workspace || ''}:${tokens.refresh_token}`), email };
  }

  canVerifyReplacement(targetBytes: Buffer | null): boolean {
    if (!targetBytes) return false;
    let auth: CodexAuth | null = null;
    try { auth = JSON.parse(targetBytes.toString()); } catch { return false; }
    if (!auth || auth.OPENAI_API_KEY) return false;
    const { sub, email, accountId, jwtAccountId, conflict } = codexAuthClaims(auth);
    if (conflict) return false;
    return Boolean((sub || email) && (accountId || jwtAccountId));
  }

  sameRefreshedIdentity(before: CodexAuth | null, after: CodexAuth | null): boolean {
    if (!this.identityFromAuth(before) || !this.identityFromAuth(after)) return false;
    const a = codexAuthClaims(before), b = codexAuthClaims(after);
    if (a.conflict || b.conflict || differentEmail(a.email, b.email)) return false;
    const workspaceA = a.accountId || a.jwtAccountId || '';
    const workspaceB = b.accountId || b.jwtAccountId || '';
    if (workspaceA !== workspaceB) return false;
    if (a.sub) return a.sub === b.sub;
    return Boolean(a.email && b.email && !differentEmail(a.email, b.email));
  }

  findCodexBinary(appDirs = [
    '/Applications/Codex.app', '/Applications/ChatGPT.app',
    path.join(os.homedir(), 'Applications/Codex.app'), path.join(os.homedir(), 'Applications/ChatGPT.app'),
  ]): string | undefined {
    if (process.platform === 'win32') return findWindowsCodexBinary();
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
  queryLiveRpc(home: string, allowRefresh = true, forceRefresh = false): Promise<{ account?: Account | null; rates?: RateResponse }> {
    const bin = this.findCodexBinary();
    if (!bin) return Promise.reject(new Error('未找到 Codex CLI'));
    return new Promise((resolve, reject) => {
      let refreshAttempted = false;
      let refreshFailure: AuthFailure | undefined;
      let stderrTail = '';
      let account: Account | null | undefined;
      let outcome: { error?: Error; rates?: RateResponse } | undefined;
      let spawned = false;
      const finish = (error?: Error, rates?: RateResponse) => {
        if (outcome) return;
        outcome = { error, rates };
        clearTimeout(timer);
        server.stop();
      };
      const refreshLogin = () => {
        if (!allowRefresh || refreshAttempted) return false;
        refreshAttempted = true;
        server.send({ method: 'account/read', id: 3, params: { refreshToken: true } });
        return true;
      };
      const server = startCodexProcess(bin, home, {
        onSpawn() { spawned = true; stepDiagnostic('query-start'); },
        onError: kind => finish(new Error(kind === 'start' ? '无法启动 Codex CLI' : 'Codex 连接已关闭')),
        onClose() {
          if (spawned) stepDiagnostic('query-end');
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
            if (msg.id !== 0 && error.authFailure === 'authentication-rejected') {
              if (refreshLogin()) return;
              if (!allowRefresh) return finish(new CodexQueryError('客户端正在运行且访问令牌待续期，将在客户端自动续期或关闭后刷新'));
            }
            finish(error);
          } else if (msg.id === 0) {
            server.send({ method: 'initialized' });
            if (forceRefresh) refreshLogin();
            else server.send({ method: 'account/read', id: 1, params: { refreshToken: false } });
          } else if (msg.id === 1 || msg.id === 3) {
            account = msg.result?.account;
            if (!account) {
              if (!refreshLogin()) finish(!allowRefresh
                ? new CodexQueryError('客户端正在运行且访问令牌待续期，将在客户端自动续期或关闭后刷新')
                : refreshFailure
                ? new CodexQueryError('凭据失效，请更新凭据', refreshFailure)
                : new CodexQueryError('未读取到登录状态，请刷新重试', 'account-unavailable'));
            }
            else if (account.type === 'apiKey') finish();
            else server.send({ method: 'account/rateLimits/read', id: 2 });
          } else if (msg.id === 2) finish(undefined, msg.result);
        },
      });
      const timer = setTimeout(() => finish(new Error('额度查询超时，请稍后重试')), 20000);
      server.send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'agent-switcher', version: require('../../package.json').version } } });
    });
  }

  // The RPC receives only a private copy. The caller commits a rotation under the store lock.
  async queryCredential(original: Buffer | null, options: QueryOptions = {}): Promise<CredentialQuery> {
    let auth: CodexAuth | null = null;
    try { if (original) auth = JSON.parse(original.toString()); } catch { /* Invalid file login. */ }
    const identity = this.identityFromAuth(auth);
    const backendIssue = this.switchSupport();
    if (backendIssue) stepDiagnostic('storage-unavailable');
    if (!identity || !original) return { status: { available: false, state: backendIssue ? 'unsupported' : 'signed-out',
      extra: backendIssue || '未找到文件凭据；Keychain 登录暂不支持' } };
    const account = options.expectedEmail?.trim() || identity.email || 'API / OAuth 账号';
    const checkedAt = new Date().toISOString();
    if (auth?.OPENAI_API_KEY) return { status: { available: true, account: 'API Key', state: 'unsupported', extra: 'API Key 不提供订阅额度', checkedAt } };
    // Without a known live backend we cannot prove a saved token belongs to a separate login.
    const allowRefresh = !backendIssue && options.allowRefresh !== false;
    if (options.verifyTarget !== undefined) {
      if (backendIssue) throw new Error(backendIssue); // Settings changed after the staged check; retain the candidate.
      if (!allowRefresh) {
        return {
          status: {
            available: true, account, state: 'unverified', authExpired: false, checkedAt,
            extra: '客户端正在运行，为避免续期冲突暂不验证新凭据；请先关闭客户端后刷新验证',
          },
          verifiedReplacement: false,
        };
      }
      return this.verifyCredentialExchange(auth!, options.verifyTarget, account, checkedAt, false, options.expectedEmail);
    }
    const claims = codexAuthClaims(auth);
    if (claims.conflict || differentEmail(claims.email, options.expectedEmail)) {
      return { status: { available: true, account, state: 'error', extra: 'Codex 凭据与登记身份或工作区冲突，已保留原凭据', checkedAt } };
    }
    const verifiedInSession = !claims.bearerBound && this.verifiedGenerations.has(fingerprint(original.toString()));
    const requiresBinding = !claims.jwtAccountId || (!claims.bearerBound && !verifiedInSession) ||
      (options.expectedEmail && !claims.email) || (allowRefresh && !claims.tokens?.id_token);
    if (requiresBinding) {
      if (!allowRefresh) return { status: { available: true, account, state: 'unverified', checkedAt,
        extra: backendIssue || '客户端正在运行，已延后验证访问令牌的用户与工作区' } };
      const verified = await this.verifyCredentialExchange(auth!, original, account, checkedAt, true, options.expectedEmail);
      // Rejected outputs remain in the recovery directory named in status.extra.
      return verified.verifiedReplacement ? verified : { status: verified.status };
    }
    const accessExp = jwtInfo(auth?.tokens?.access_token).exp;
    if (typeof accessExp === 'number' && Number.isFinite(accessExp)) {
      stepDiagnostic(accessExp * 1000 <= Date.now() ? 'access-expired' : 'access-valid');
    }
    if (!allowRefresh && typeof accessExp === 'number' && Number.isFinite(accessExp) && accessExp * 1000 <= Date.now() + 30_000) {
      return {
        status: {
          available: true, account, state: 'unverified', authExpired: false, checkedAt,
          extra: backendIssue || '客户端正在运行且访问令牌待续期，将在客户端自动续期或关闭后刷新',
        },
      };
    }
    const temp = createTemporaryCredentials('quota');
    const authPath = path.join(temp, 'auth.json');
    let mayHaveRotated = false;
    try {
      if (allowRefresh) {
        atomicWrite(authPath, original);
        markTemporaryCredentialsPending(temp, identity.id, auth?.tokens?.refresh_token);
        mayHaveRotated = true;
      } else {
        const nonRotating = Buffer.from(JSON.stringify({
          ...auth,
          tokens: {
            ...auth!.tokens, account_id: claims.accountId || claims.jwtAccountId,
            // Older imports may omit the ID token required by the CLI's file parser.
            // This read-only login derives its display fields from the bearer we verify below.
            id_token: claims.tokens?.id_token || makeSentinelJwt({ sub: claims.sub, email: claims.email }),
            refresh_token: 'ags-refresh-disabled',
          },
        }));
        atomicWrite(authPath, nonRotating);
        fs.chmodSync(authPath, 0o400);
      }
      let status: StatusResult;
      let rpcEmail: string | undefined, wrongAccount = false;
      try {
        const live = await this.queryLiveRpc(temp, allowRefresh);
        rpcEmail = live.account?.email;
        wrongAccount = Boolean(live.account?.type && live.account.type !== 'chatgpt') || differentEmail(rpcEmail, claims.email || options.expectedEmail);
        if (wrongAccount) throw new Error('Codex 返回的用户与登记身份不符，已忽略本次额度');
        const quota = live.rates ? parseQuota(live.rates) : undefined;
        status = {
          available: true, account,
          plan: quota?.plan && quota.plan !== 'unknown' ? quota.plan : live.account?.planType,
          quota, state: quota ? 'ok' : 'unsupported', authExpired: false, checkedAt,
          fetchedAt: quota ? checkedAt : undefined, extra: quota ? undefined : '此账号未返回额度数据',
        };
      } catch (error) {
        const message = (error as Error).message;
        const authFailure = error instanceof CodexQueryError ? error.authFailure : codexAuthFailure(message);
        if (!allowRefresh) {
          status = {
            available: true, account, state: 'error', authExpired: false, checkedAt,
            extra: authFailure ? backendIssue || '客户端正在运行且访问令牌待续期，将在客户端自动续期或关闭后刷新' : message,
          };
        } else {
          const expired = !!authFailure?.startsWith('refresh-');
          status = { available: true, account, state: expired ? 'expired' : 'error', authExpired: expired, extra: message, authFailure, checkedAt };
        }
      } finally {
        if (!allowRefresh) { try { fs.chmodSync(authPath, 0o600); } catch {} }
      }
      if (!allowRefresh) {
        releaseTemporaryCredentials(temp);
        return { status };
      }
      const updated = readBuffer(authPath);
      if (updated && !original.equals(updated)) {
        let updatedAuth: CodexAuth | null = null;
        try { updatedAuth = JSON.parse(updated.toString()); } catch { throw new CredentialChangedError(); }
        const refreshed = codexAuthClaims(updatedAuth);
        if (wrongAccount || differentEmail(rpcEmail, refreshed.email) || !this.sameRefreshedIdentity(auth, updatedAuth)) {
          const consumed = consumedRotation(auth, updatedAuth, account, checkedAt, temp);
          if (consumed) return consumed;
          throw new CredentialChangedError();
        }
        if (!refreshed.bearerBound) {
          const pairIssued = refreshed.tokens?.id_token && refreshed.tokens.id_token !== claims.tokens?.id_token &&
            refreshed.tokens.access_token && refreshed.tokens.access_token !== claims.tokens?.access_token;
          const sameVerifiedPair = verifiedInSession && refreshed.tokens?.id_token === claims.tokens?.id_token &&
            refreshed.tokens?.access_token === claims.tokens?.access_token;
          if ((!pairIssued && !sameVerifiedPair) || !refreshed.jwtAccountId) {
            const consumed = consumedRotation(auth, updatedAuth, account, checkedAt, temp);
            if (consumed) return consumed;
            throw new CredentialChangedError();
          }
          this.verifiedGenerations.add(fingerprint(updated.toString()));
        }
        this.verifiedGenerations.delete(fingerprint(original.toString()));
        return { status, rotated: updated, temporaryDirectory: temp };
      }
      releaseTemporaryCredentials(temp);
      return { status };
    } catch (error) {
      try { fs.chmodSync(authPath, 0o600); } catch {}
      if (!mayHaveRotated) releaseTemporaryCredentials(temp);
      const failure = error instanceof Error ? error : new Error('额度查询未完成');
      if (mayHaveRotated) failure.message += `；临时凭据已保留在 ${temp}`;
      throw failure;
    }
  }

  private async verifyCredentialExchange(candidate: CodexAuth, targetBytes: Buffer | null, fallbackAccount: string, checkedAt: string, bindOriginal = false, registeredEmail?: string): Promise<CredentialQuery> {
    let targetAuth: CodexAuth | null = null;
    try { if (targetBytes) targetAuth = JSON.parse(targetBytes.toString()); } catch {}
    const targetClaims = codexAuthClaims(targetAuth);
    const candidateClaims = codexAuthClaims(candidate);
    const expectedAccount = registeredEmail || targetClaims.email || fallbackAccount;
    const reject = (extra: string, expired = false, rotated?: Buffer, tempDir?: string): CredentialQuery => ({
      status: { available: true, account: expectedAccount, state: expired ? 'expired' : 'error', authExpired: expired, extra, checkedAt },
      rotated,
      temporaryDirectory: tempDir,
      verifiedReplacement: false,
    });
    if (!bindOriginal && !this.canVerifyReplacement(targetBytes)) {
      return reject('原账号缺少可验证的用户身份，已保留原凭据；请使用「重新登录」完成官方授权');
    }
    if (candidateClaims.conflict || differentEmail(targetClaims.email, registeredEmail) || differentEmail(candidateClaims.email, registeredEmail)) {
      return reject('待验证凭据与登记用户或工作区的声明冲突，已保留原凭据；请使用「重新登录」完成官方授权');
    }
    const expectedWorkspace = targetClaims.accountId || targetClaims.jwtAccountId || '';
    const candidateWorkspace = candidateClaims.accountId || candidateClaims.jwtAccountId || '';
    if (expectedWorkspace !== candidateWorkspace) {
      return reject('待验证凭据不属于原工作区，已保留原凭据；请使用「重新登录」完成官方授权');
    }
    // Managed auth needs a workspace selector to refresh. Only newly issued JWTs can prove it.
    const sentinelIdToken = makeSentinelJwt({ sub: SENTINEL_SUB, email: SENTINEL_EMAIL });
    const sentinelAccessToken = makeSentinelJwt({ sub: SENTINEL_SUB, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sanitized = Buffer.from(JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: checkedAt,
      tokens: {
        account_id: expectedWorkspace || SENTINEL_SUB,
        id_token: sentinelIdToken,
        access_token: sentinelAccessToken,
        refresh_token: candidate.tokens!.refresh_token,
      },
    }));
    const temp = createTemporaryCredentials('quota');
    const authPath = path.join(temp, 'auth.json');
    let mayHaveRotated = false;
    try {
      atomicWrite(authPath, sanitized);
      markTemporaryCredentialsPending(temp, this.identityFromAuth(targetAuth)?.id, candidate.tokens?.refresh_token);
      mayHaveRotated = true;
      let live: { account?: Account | null; rates?: RateResponse } = {};
      let exchangeError: unknown;
      try { live = await this.queryLiveRpc(temp, true, true); }
      catch (error) { exchangeError = error; }
      const disk = readBuffer(authPath);
      const didRotate = !!disk && !sanitized.equals(disk);
      let refreshedAuth: CodexAuth | null = null;
      try { if (disk) refreshedAuth = JSON.parse(disk.toString()); } catch {}
      const issued = refreshedAuth?.tokens;
      const issuedWorkspace = codexAuthClaims(refreshedAuth).jwtAccountId;
      // Managed Codex persists its local routing selector across a successful exchange.
      // With no registered workspace, replace the temporary selector only with the issuer's value.
      if (!expectedWorkspace && issued?.account_id === SENTINEL_SUB && issuedWorkspace) issued.account_id = issuedWorkspace;
      const refreshed = codexAuthClaims(refreshedAuth);
      const minted = Boolean(didRotate && issued?.refresh_token && issued.id_token && issued.id_token !== sentinelIdToken &&
        issued.access_token && issued.access_token !== sentinelAccessToken &&
        refreshed.sub !== SENTINEL_SUB && refreshed.email !== SENTINEL_EMAIL);
      const expectedEmail = registeredEmail || targetClaims.email;
      const userBound = Boolean((refreshed.sub || refreshed.email) && (!targetClaims.sub || refreshed.sub === targetClaims.sub) &&
        (!expectedEmail || (refreshed.email && !differentEmail(expectedEmail, refreshed.email))));
      const workspaceBound = !!issuedWorkspace && issuedWorkspace !== SENTINEL_SUB && (!expectedWorkspace || issuedWorkspace === expectedWorkspace);
      const proven = minted && !refreshed.conflict && workspaceBound && userBound;
      const refreshedBytes = disk && refreshedAuth && !expectedWorkspace && proven ? Buffer.from(JSON.stringify(refreshedAuth)) : disk;
      if (!expectedWorkspace && proven && refreshedBytes) {
        atomicWrite(authPath, refreshedBytes);
        // The first RPC can report a missing workspace after it already consumed the refresh token.
        // Verify quota under the actual workspace, in a second home without a usable refresh token.
        const probe = createTemporaryCredentials('quota');
        try {
          atomicWrite(path.join(probe, 'auth.json'), JSON.stringify({ ...refreshedAuth, tokens: { ...issued, refresh_token: 'ags-refresh-disabled' } }));
          live = await this.queryLiveRpc(probe, false);
          exchangeError = undefined;
        } catch (error) { exchangeError = error; }
        finally { releaseTemporaryCredentials(probe); }
      }
      const quota = live.rates ? parseQuota(live.rates) : undefined;
      const wrongRpcUser = Boolean(live.account?.type && live.account.type !== 'chatgpt') || differentEmail(live.account?.email, refreshed.email || expectedEmail);
      if (proven && refreshedBytes && !wrongRpcUser && bindOriginal && (exchangeError || !quota)) {
        // The isolated authority accepted this card's own refresh token, and the issued
        // identity matches every prior anchor. A quota outage must not replay its old token.
        if (!refreshed.bearerBound) this.verifiedGenerations.add(fingerprint(refreshedBytes.toString()));
        return { status: { available: true, account: refreshed.email || expectedAccount, state: 'error',
          extra: '已核对换发凭据的用户与工作区，本次额度读取失败，请稍后刷新', checkedAt },
          rotated: refreshedBytes, temporaryDirectory: temp, verifiedReplacement: true };
      }
      if (exchangeError || !quota || !refreshedBytes || !proven || wrongRpcUser) {
        if (bindOriginal && didRotate) {
          const consumed = consumedRotation(candidate, refreshedAuth, expectedAccount, checkedAt, temp);
          if (consumed) return consumed;
        }
        if (!didRotate) releaseTemporaryCredentials(temp);
        const authFailure = exchangeError instanceof CodexQueryError ? exchangeError.authFailure : codexAuthFailure((exchangeError as Error)?.message);
        const reason = exchangeError ? (exchangeError as Error).message :
          !proven || wrongRpcUser ? '未能通过服务端刷新绑定原账号与工作区身份' : '未能读取额度以完成验证';
        const extra = reason + '；已保留原凭据，可使用「重新登录」完成官方授权' +
          (didRotate ? `；未写回的凭据已保留在 ${temp}，恢复前请勿清理该目录` : '');
        const result = reject(extra, !!authFailure?.startsWith('refresh-'), didRotate ? refreshedBytes ?? undefined : undefined, didRotate ? temp : undefined);
        result.status.authFailure = authFailure;
        return result;
      }
      const status: StatusResult = {
        available: true, account: refreshed!.email || live.account?.email || expectedAccount,
        plan: quota.plan && quota.plan !== 'unknown' ? quota.plan : live.account?.planType,
        quota, state: 'ok', authExpired: false, checkedAt, fetchedAt: checkedAt,
      };
      if (!refreshed.bearerBound) this.verifiedGenerations.add(fingerprint(refreshedBytes.toString()));
      return { status, rotated: refreshedBytes, temporaryDirectory: temp, verifiedReplacement: true };
    } catch (error) {
      if (!mayHaveRotated) { releaseTemporaryCredentials(temp); throw error; }
      const currentBytes = readBuffer(authPath);
      const didRotate = Boolean(currentBytes && !sanitized.equals(currentBytes));
      if (!didRotate) releaseTemporaryCredentials(temp);
      else if (error instanceof Error && !error.message.includes(temp)) {
        error.message += `；未写回的凭据已保留在 ${temp}，恢复前请勿清理该目录`;
      }
      throw error;
    }
  }

}
export const codexAgent = new CodexAgent();
