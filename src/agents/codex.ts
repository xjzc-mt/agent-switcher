import { runningCodexSessions } from '../client-logout';
import { agentMetadata } from './metadata';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { startCodexProcess } from '../codex-process';
import { findWindowsCodexBinary, missingWindowsCodexRuntime } from '../windows-codex';
import { windowsCodexFileIssue } from '../codex-file-auth';
import { codexRpcSteps, stepDiagnostic } from '../diagnostics';
import { BaseAgent, StatusResult, QuotaDetail, QuotaWindow, Identity, CredentialQuery, QueryOptions } from './base';
import { atomicWrite, readBuffer, readJsonFile, parseJsonBytes, jwtInfo, fingerprint, differentEmail } from '../utils';
import { CredentialChangedError, QuotaBearerRejected } from '../credential-state';
import { ConsumedCodexRotation, createTemporaryCredentials, markTemporaryCredentialsPending, quarantineCodexQuota, releaseTemporaryCredentials } from '../temporary-credentials';

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
const failedExchange = /access token could not be refreshed/i;
const expiredGuidance = '登录凭据已失效，请点击「更新凭据」重新登录';
const networkGuidance = '网络连接或官方服务响应异常，无需重新登录，请检查网络或代理后点击刷新重试';
const unknownGuidance = '暂时无法读取额度，可点击刷新重试；若多次失败请切换验证或更新凭据';
// The CLI may append arbitrary response bodies or include a URL in a transport error.
const errorHeader = (text: string) => text.slice(0, 4096).split(/;\s*(?:content-type|body)=|\r?\n/, 1)[0].replace(/https?:\/\/\S+/gi, '<url>');

/** Keep only allowlisted reasons; never persist or display raw RPC text. */
export function codexAuthFailure(error: unknown, depth = 0): AuthFailure | undefined {
  if (depth > 5) return undefined;
  if (typeof error === 'string') {
    const text = errorHeader(error);
    if (/refresh[_ -]?token[_ -]?reused|refresh token.{0,140}(?:already been used|\breused\b)/i.test(text)) return 'refresh-reused';
    if (/refresh[_ -]?token[_ -]?(?:invalidated|revoked)|refresh token.{0,140}revoked/i.test(text)) return 'refresh-revoked';
    if (/refresh[_ -]?token[_ -]?expired|refresh token.{0,140}expired/i.test(text)) return 'refresh-expired';
    if (/refresh[_ -]?token[_ -]?invalid|refresh token.{0,140}invalid|invalid[_ -]?grant|凭据失效/i.test(text)) return 'refresh-invalid';
    if (failedExchange.test(text) || /please log out and sign in again|token[_ -]?(?:expired|revoked)|invalidated oauth token|invalid[_ -]?token|insufficient_user_authentication|\bunauthori[sz]ed\b|\bunauthenticated\b|\bnot (?:authenticated|logged in)\b|(?:HTTP(?: error| status)?|status(?: code)?)\s*[:=]?\s*401\b|^401\b/i.test(text)) return 'authentication-rejected';
    return undefined;
  }
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Record<string, unknown>;
  const reasons = ['code', 'message', 'data', 'error', 'error_description', 'reason', 'cause'].map(key => codexAuthFailure(value[key], depth + 1));
  return reasons.find(reason => reason?.startsWith('refresh-')) || reasons.find(Boolean) ||
    (['code', 'status', 'statusCode', 'httpStatusCode'].some(key => value[key] === 401 || value[key] === '401') ? 'authentication-rejected' : undefined);
}
interface RateResponse { rateLimits?: RateLimit | null; rateLimitsByLimitId?: Record<string, RateLimit | null> | null; rateLimitResetCredits?: unknown }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const positiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

function quotaGuidance(status: number | undefined, text: string): string | undefined {
  if (status === 429 || (!status && /too many requests|rate[ _-]?limit[ _-]?exceeded/i.test(text)))
    return '官方接口请求过于频繁（429），无需重新登录。稍后可手动刷新，已开启自动刷新的账号会按设置重试';
  if (status === 402 || status === 403 || (!status && /forbidden|deactivated|subscription/i.test(text)))
    return '账号暂无可用订阅或工作区受限，请在网页端确认订阅状态或重新登录';
  if ((status && (status >= 500 || status === 407 || status === 408)) || (!status && /timed?\s*out|econn|enotfound|tls|ssl|dns|proxy|network|fetch failed|connection/i.test(text)))
    return networkGuidance;
}

function queryError(id: number | 'refresh-log', error: unknown, allowRefresh: boolean): CodexQueryError {
  const value = isRecord(error) ? error : {};
  const message = typeof error === 'string' ? error : typeof value.message === 'string' ? value.message : '';
  const data = isRecord(value.data) ? value.data : {};
  const status = [value.status, value.statusCode, value.httpStatusCode, data.status, data.statusCode, data.httpStatusCode, value.code, data.code]
    .find(s => (typeof s === 'number' && Number.isInteger(s) && s >= 400 && s < 600) || (typeof s === 'string' && /^[45]\d\d$/.test(s)));
  const header = errorHeader(message);
  const reason = header === 'workspace routing discovery failed' ? 'workspace-routing' : failedExchange.test(header) ? 'token-refresh-failed' : undefined;
  const match = /(?:^|(?:failed|failed to refresh token):\s*|\b(?:HTTP(?:\/\d(?:\.\d)?| (?:error|status)(?: code)?)?|status(?: code)?)\s*[:=]?\s*)([45]\d\d)\b/i.exec(header);
  const httpStatus = status !== undefined ? Number(status) : match ? Number(match[1]) : undefined;
  if (id !== 'refresh-log') stepDiagnostic(codexRpcSteps[id], { rpcCode:typeof value.code === 'number' ? value.code : undefined, httpStatus, reason });
  const detail = isRecord(data.error) ? data.error : {};
  const guidance = quotaGuidance(httpStatus, [message,value.code,data.code,data.message,data.error,detail.code,detail.message]
    .filter((v): v is string => typeof v === 'string').map(errorHeader).join(' '));
  if (guidance || (httpStatus && httpStatus !== 400 && httpStatus !== 401)) return new CodexQueryError(guidance ?? unknownGuidance);
  let auth = codexAuthFailure(error) ?? (httpStatus === 401 || (id === 'refresh-log' && httpStatus === 400) ? 'authentication-rejected' : undefined);
  if (auth && (!allowRefresh || (id === 2 && reason !== 'token-refresh-failed'))) auth = 'authentication-rejected'; // A quota rejection alone cannot invalidate the grant.
  else if (auth === 'authentication-rejected' && (id === 'refresh-log' || id === 3 || reason === 'token-refresh-failed')) auth = 'refresh-invalid';
  return new CodexQueryError(auth?.startsWith('refresh-') ? expiredGuidance : auth ? '认证请求未通过，请刷新重试' : unknownGuidance, auth);
}

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
    extra: new ConsumedCodexRotation(directory).message } };
}

export class CodexAgent extends BaseAgent {
  readonly id = 'codex';
  readonly label = agentMetadata.codex.label;
  // Remember the exact bearer/identity pair issued together by the official exchange.
  // Quota still requires a successful authenticated request. Imported metadata confers no trust.
  private readonly verifiedGenerations = new Set<string>();
  readonly homeDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  readonly authFiles = [agentMetadata.codex.credential];

  readonly bindsQuotaEmail = true;
  async sharedSessionIssue() {
    if ((await runningCodexSessions({ failClosed: true })).length) return '请先结束 Codex CLI、IDE 或其他正在使用凭据的会话';
  }
  async assertSwitchSessions() {
    if (process.platform === 'win32' && await this.sharedSessionIssue()) throw new Error('请先退出 Codex 桌面并结束共用登录的 CLI 或 IDE 会话，再切换账号');
  }
  clientLogoutIssue(): string | undefined {
    if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].some(key => process.env[key])) {
      return '检测到环境变量认证，请先在官方客户端退出';
    }
    try {
      if (fs.lstatSync(this.homeDir).isSymbolicLink()) return '登录目录是符号链接，请在官方客户端退出';
      const config = fs.readFileSync(path.join(this.homeDir, 'config.toml'), 'utf8');
      // Accept only an explicit, unambiguous root-level file backend. Never guess
      // the precedence of keyring/auto, multiline TOML, or managed requirements.
      const root = config.split(/^\s*\[/m)[0];
      if (/["']{3}/.test(config) || (config.match(/^\s*cli_auth_credentials_store\s*=/gm) || []).length !== 1 ||
          !/^\s*cli_auth_credentials_store\s*=\s*["']file["']\s*(?:#.*)?$/m.test(root) ||
          fs.existsSync(path.join(this.homeDir, 'requirements.toml')) ||
          fs.existsSync('/etc/codex/requirements.toml') || fs.existsSync('/etc/codex/managed_config.toml')) {
        return '未确认 Codex 使用单一文件认证，请在官方客户端退出';
      }
      const auth = readJsonFile<Record<string, unknown>>(path.join(this.homeDir, 'auth.json'));
      if (!auth || Object.keys(auth).some(key => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key))) {
        return 'Codex 凭据结构尚未验证，请在官方客户端退出';
      }
      if (!this.identity()) return '未确认当前 Codex 账号';
    } catch { return '无法确认 Codex 文件认证，请在官方客户端退出'; }
  }
  switchSupport(): string | undefined {
    return process.platform === 'win32' ? windowsCodexFileIssue(this.homeDir) : undefined;
  }
  get usesCredentialRevisions() { return true; }
  management() {
    const defaults = { quota: true, storage: 'file' as const, canSaveCurrent: true, isolatedLogin: true }, notice = this.switchSupport();
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
    const auth = parseJsonBytes<CodexAuth>(targetBytes);
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

  canRecoverQuotaRotation(original: Buffer, output: Buffer, registeredEmail?: string): boolean {
    const before = parseJsonBytes<CodexAuth>(original), after = parseJsonBytes<CodexAuth>(output);
    if (before?.OPENAI_API_KEY || after?.OPENAI_API_KEY || !this.sameRefreshedIdentity(before, after)) return false;
    const claims = codexAuthClaims(after), issued = claims.tokens, previous = before?.tokens;
    const expectedEmail = registeredEmail || codexAuthClaims(before).email;
    if (!issued || !previous || !claims.jwtAccountId || (expectedEmail && (!claims.email || differentEmail(expectedEmail, claims.email)))) return false;
    if (claims.bearerBound) return true;
    // An opaque bearer must either be issued alongside a new ID token, or be the exact pair verified in this session.
    return typeof issued.id_token === 'string' && !!issued.id_token && (issued.id_token !== previous.id_token && issued.access_token !== previous.access_token ||
      issued.id_token === previous.id_token && issued.access_token === previous.access_token && this.verifiedGenerations.has(fingerprint(original.toString())));
  }

  /** Only an accepted exchange or a verified, persisted recovery may vouch for an opaque pair. */
  adoptRecoveredQuota(output: Buffer, bearerBound = codexAuthClaims(parseJsonBytes<CodexAuth>(output)).bearerBound): void {
    if (!bearerBound) this.verifiedGenerations.add(fingerprint(output.toString()));
  }

  missingRuntimeMessage(fallback: string): string {
    return (process.platform === 'win32' && missingWindowsCodexRuntime()) || fallback;
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
    if (!bin) return Promise.reject(new Error(this.missingRuntimeMessage('未找到 Codex CLI')));
    return new Promise((resolve, reject) => {
      let refreshAttempted = false;
      let refreshFailure: CodexQueryError | undefined;
      let stderrTail = '';
      const observeRefreshLog = (line: string) => {
        const marker = /failed to refresh token|(?:refresh|access) token could not be refreshed/i.exec(errorHeader(line));
        if (!marker) return;
        const error = queryError('refresh-log', marker.input.slice(marker.index), allowRefresh);
        if (error.authFailure || error.message !== unknownGuidance) refreshFailure = error;
      };
      let account: Account | null | undefined;
      let outcome: { error?: Error; rates?: RateResponse } | undefined;
      let spawned = false;
      const disconnected = new Error(networkGuidance);
      const finish = (error?: Error, rates?: RateResponse) => {
        if (outcome) return;
        outcome = { error, rates };
        clearTimeout(timer);
        server.stop();
      };
      const refreshLogin = () => {
        if (!allowRefresh || refreshAttempted || refreshFailure) return false;
        refreshAttempted = true;
        account = undefined;
        server.send({ method: 'account/read', id: 3, params: { refreshToken: true } });
        return true;
      };
      const server = startCodexProcess(bin, home, {
        onSpawn() { spawned = true; stepDiagnostic('query-start'); },
        onError: kind => finish(kind === 'start' ? new Error('无法启动 Codex CLI') : disconnected),
        onClose() {
          if (spawned) stepDiagnostic('query-end');
          clearTimeout(timer);
          observeRefreshLog(stderrTail);
          // stdout and stderr can finish in either order. A successful account read supersedes earlier log lines.
          const error = outcome?.error;
          const inconclusive = !outcome || error === disconnected || (error instanceof CodexQueryError && (error.authFailure || error.message === unknownGuidance));
          if (refreshFailure && inconclusive && !(refreshAttempted && account)) reject(refreshFailure);
          else if (!outcome) reject(new Error('Codex 查询进程提前退出'));
          else if (outcome.error) reject(outcome.error);
          else resolve({ account, rates: outcome.rates });
        },
        onStderr(chunk) {
          // Some CLI versions return account:null after logging a failed refresh.
          // Retain only a known reason, never the log text or token material.
          const lines = (stderrTail + chunk.toString()).split('\n'); stderrTail = (lines.pop() || '').slice(0, 8192);
          for (const line of lines) observeRefreshLog(line);
        },
        onMessage(msg) {
          if (outcome || ![0, 1, 2, 3].includes(msg.id)) return;
          if (msg.error) {
            const error = queryError(msg.id, msg.error, allowRefresh);
            if (msg.id === 2 && refreshAttempted && account && error.authFailure === 'authentication-rejected') {
              finish(new CodexQueryError('账号已续期，额度接口暂未接受新的访问令牌，请稍后刷新'));
              return;
            }
            if (msg.id !== 0 && error.authFailure === 'authentication-rejected' && refreshLogin()) return;
            finish(error);
          } else if (msg.id === 0) {
            server.send({ method: 'initialized' });
            if (forceRefresh && refreshFailure) finish(refreshFailure);
            else if (forceRefresh) refreshLogin();
            else server.send({ method: 'account/read', id: 1, params: { refreshToken: false } });
          } else if (msg.id === 1 || msg.id === 3) {
            account = msg.result?.account;
            if (!account) {
              if (!refreshLogin()) finish(new CodexQueryError('未读取到登录状态，请刷新重试', 'account-unavailable'));
            }
            else if (account.type === 'apiKey') finish();
            else {
              refreshFailure = undefined;
              stderrTail = '';
              server.send({ method: 'account/rateLimits/read', id: 2 });
            }
          } else if (msg.id === 2) finish(undefined, msg.result);
        },
      });
      const timer = setTimeout(() => finish(new CodexQueryError(networkGuidance)), 20000);
      server.send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'agent-switcher', version: require('../../package.json').version } } });
    });
  }

  // The RPC receives only a private copy. The caller commits a rotation under the store lock.
  async queryCredential(original: Buffer | null, options: QueryOptions = {}): Promise<CredentialQuery> {
    const auth = parseJsonBytes<CodexAuth>(original);
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
    const remainingMs = typeof accessExp === 'number' && Number.isFinite(accessExp) ? accessExp * 1000 - Date.now() : undefined;
    if (remainingMs !== undefined) stepDiagnostic(remainingMs <= 0 ? 'access-expired' : 'access-valid');
    if (!allowRefresh && remainingMs !== undefined && remainingMs <= 30_000) {
      return {
        status: {
          available: true, account, state: 'unverified', authExpired: false, checkedAt,
          extra: backendIssue || '客户端正在运行且访问令牌待续期，将在客户端自动续期或关闭后刷新',
        },
      };
    }
    const canRotate = allowRefresh && (remainingMs === undefined || remainingMs <= 60_000 || !!options.renewRejectedBearer);
    if (allowRefresh && !canRotate) stepDiagnostic('read-only');
    const temp = createTemporaryCredentials('quota');
    const authPath = path.join(temp, 'auth.json');
    let mayHaveRotated = false;
    try {
      if (canRotate) {
        atomicWrite(authPath, original);
        markTemporaryCredentialsPending(temp, identity.id, auth?.tokens?.refresh_token, original);
        mayHaveRotated = true;
      } else {
        const nonRotating = Buffer.from(JSON.stringify({
          auth_mode: 'chatgpt', last_refresh: checkedAt,
          tokens: {
            access_token: claims.tokens!.access_token, account_id: claims.accountId || claims.jwtAccountId,
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
        const live = await this.queryLiveRpc(temp, canRotate, canRotate && options.renewRejectedBearer);
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
        if (!canRotate) {
          if (allowRefresh && options.reportRejectedBearer && (authFailure === 'authentication-rejected' || authFailure === 'account-unavailable')) {
            throw new QuotaBearerRejected('访问令牌暂不可用，等待客户端续期后刷新');
          }
          status = {
            available: true, account, state: 'error', authExpired: false, checkedAt,
            extra: authFailure && !allowRefresh ? backendIssue || '客户端正在运行且访问令牌待续期，将在客户端自动续期或关闭后刷新' : message,
          };
        } else {
          const expired = !!authFailure?.startsWith('refresh-');
          status = { available: true, account, state: expired ? 'expired' : 'error', authExpired: expired, extra: message, authFailure, checkedAt };
        }
      }
      if (!canRotate) return { status };
      const updated = readBuffer(authPath);
      if (updated && !original.equals(updated)) {
        const updatedAuth = parseJsonBytes<CodexAuth>(updated);
        const refreshed = codexAuthClaims(updatedAuth);
        if (wrongAccount || differentEmail(rpcEmail, refreshed.email) || !this.canRecoverQuotaRotation(original, updated, options.expectedEmail)) {
          quarantineCodexQuota(temp);
          const consumed = consumedRotation(auth, updatedAuth, account, checkedAt, temp);
          if (consumed) return consumed;
          throw new CredentialChangedError();
        }
        this.adoptRecoveredQuota(updated, refreshed.bearerBound);
        this.verifiedGenerations.delete(fingerprint(original.toString()));
        return { status, rotated: updated, temporaryDirectory: temp };
      }
      releaseTemporaryCredentials(temp);
      return { status };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('额度查询未完成');
      if (mayHaveRotated) failure.message += `；临时凭据已保留在 ${temp}`;
      throw failure;
    } finally {
      if (!mayHaveRotated) {
        if (!canRotate) { try { fs.chmodSync(authPath, 0o600); } catch {} }
        releaseTemporaryCredentials(temp);
      }
    }
  }

  private async verifyCredentialExchange(candidate: CodexAuth, targetBytes: Buffer | null, fallbackAccount: string, checkedAt: string, bindOriginal = false, registeredEmail?: string): Promise<CredentialQuery> {
    const targetAuth = parseJsonBytes<CodexAuth>(targetBytes);
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
      markTemporaryCredentialsPending(temp, this.identityFromAuth(targetAuth)?.id, candidate.tokens?.refresh_token, undefined, true);
      mayHaveRotated = true;
      let live: { account?: Account | null; rates?: RateResponse } = {};
      let exchangeError: unknown;
      try { live = await this.queryLiveRpc(temp, true, true); }
      catch (error) { exchangeError = error; }
      const disk = readBuffer(authPath);
      const didRotate = !!disk && !sanitized.equals(disk);
      const refreshedAuth = parseJsonBytes<CodexAuth>(disk);
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
      const rpcError = exchangeError instanceof CodexQueryError ? exchangeError : undefined;
      const wrongRpcUser = Boolean(live.account?.type && live.account.type !== 'chatgpt') || differentEmail(live.account?.email, refreshed.email || expectedEmail);
      if (proven && refreshedBytes && !wrongRpcUser && bindOriginal && (exchangeError || !quota)) {
        // The isolated authority accepted this card's own refresh token, and the issued
        // identity matches every prior anchor. A quota outage must not replay its old token.
        this.adoptRecoveredQuota(refreshedBytes, refreshed.bearerBound);
        return { status: { available: true, account: refreshed.email || expectedAccount, state: 'error',
          extra: rpcError && !rpcError.authFailure ? rpcError.message : '已核对换发凭据的用户与工作区，本次额度读取失败，请稍后刷新', checkedAt },
          rotated: refreshedBytes, temporaryDirectory: temp, verifiedReplacement: true };
      }
      if (exchangeError || !quota || !refreshedBytes || !proven || wrongRpcUser) {
        if (bindOriginal && didRotate) {
          const consumed = consumedRotation(candidate, refreshedAuth, expectedAccount, checkedAt, temp);
          if (consumed) return consumed;
        }
        if (!didRotate) releaseTemporaryCredentials(temp);
        const authFailure = rpcError ? rpcError.authFailure : codexAuthFailure((exchangeError as Error)?.message);
        const reason = exchangeError ? (exchangeError as Error).message :
          !proven || wrongRpcUser ? '未能通过服务端刷新绑定原账号与工作区身份' : '未能读取额度以完成验证';
        const extra = reason + (rpcError ? '' : '；已保留原凭据，可使用「重新登录」完成官方授权') +
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
      this.adoptRecoveredQuota(refreshedBytes, refreshed.bearerBound);
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
