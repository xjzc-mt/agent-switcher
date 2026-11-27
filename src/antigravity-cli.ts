import fs from 'fs';
import { QuotaBearerRejected } from './credential-state';
import { bindNativeTokenIdentity, findQuotaBearer, nativeTokenIdentity, parseNativeToken, tokenEmail, type NativeToken, type UsageData } from './antigravity-native';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import type { AntigravityCliStatus } from './agents/base';
import { createInterface } from 'readline';
import { atomicWrite, ensureDir } from './utils';
import { macUsageLaunch, prepareMacLoginLink } from './mac-usage';
import { stopWindowsQuota, windowsUsageHome, windowsUsageLaunch } from './windows-usage';
import { resultDiagnostic, stepDiagnostic } from './diagnostics';
import { confirmWindowsQuotaExit, createTemporaryCredentials, drainTemporaryProcessGroup, markTemporaryCredentialsPending, PendingQuotaConflict, recordAntigravityQuotaOutput, releaseTemporaryCredentials, stopTemporaryProcess, withTemporaryProcess } from './temporary-credentials';

export const isolatedCliPids = new Set<number>();
export class AntigravityLoginRequired extends Error {
  constructor() { super('Antigravity 登录已失效，请更新此账号的凭据'); }
}
export class AntigravityAccessRejected extends QuotaBearerRejected {
  constructor() { super('Antigravity 未接受本次额度查询的访问令牌'); }
}
const isolatedLaunchFailed = () => new Error('Windows 未能启动隔离的 Antigravity CLI，请检查安装和目录权限后重试。');
export const cliTokenPath = (directory: string) => path.join(process.platform === 'win32' ? windowsUsageHome(directory) : directory,
  '.gemini/antigravity-cli/antigravity-oauth-token');

export function antigravityPlan(tier?: { name?: unknown; id?: unknown } | null): string | undefined {
  const name = tier?.name;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (name === 'Google AI Ultra') {
    if (tier?.id === 'g1-ultra-lite-tier') return 'Google AI Ultra 5×';
    if (tier?.id === 'g1-ultra-tier') return 'Google AI Ultra 20×';
  }
  return name;
}

export function resolveAntigravityCli(): string | undefined {
  const local = process.env.LOCALAPPDATA;
  const candidates = process.platform === 'win32'
    ? [local && path.isAbsolute(local) && path.join(local, 'agy', 'bin', 'agy.exe'), path.join(os.homedir(), '.gemini', 'bin', 'agy.exe')]
    : [path.join(os.homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  for (const file of candidates) {
    try { if (file && fs.statSync(file).isFile()) return file; }
    catch { /* Check the other official install locations. */ }
  }
}

let versionProbe: { fingerprint: string; status: AntigravityCliStatus; unsupportedSyntax?: boolean } | undefined;

function cliFingerprint(file: string) {
  const stat = fs.statSync(file, { bigint: true });
  return [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

export function antigravityCliStatus(recheck = false): AntigravityCliStatus {
  const file = resolveAntigravityCli();
  if (!file) { versionProbe = undefined; return { state: 'missing' }; }
  try {
    const fingerprint = cliFingerprint(file);
    if (!recheck && versionProbe?.fingerprint === fingerprint) return versionProbe.status;
    const probe = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 });
    const match = probe.status === 0 && /^(?:(?:agy|antigravity(?: cli)?) +)?(?:version[: ]+)?v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[\w.-]+)?(?:\+[\w.-]+)?$/im.exec(probe.stdout + '\n' + probe.stderr);
    const unsupportedSyntax = fingerprint === versionProbe?.fingerprint && versionProbe.unsupportedSyntax;
    let status: AntigravityCliStatus = { state: 'unverified' };
    if (match) {
      const [major, minor, patch] = match.slice(1, 4).map(Number);
      const supported = major > 1 || (major === 1 && (minor > 5 || (minor === 5 && (patch > 9 || (patch === 9 && !match[4])))));
      status = { state: supported && !unsupportedSyntax ? 'ready' : 'outdated', version: match.slice(1, 4).join('.') + (match[4] || '') };
    }
    versionProbe = { fingerprint, status, unsupportedSyntax };
    return status;
  } catch { return { state: 'unverified' }; }
}

// Keep only a short suffix between pipe chunks. Raw diagnostics may contain account data.
function watchUnsupportedSyntax(stderr: NodeJS.ReadableStream, launched: string, fail: (message: string) => void) {
  let tail = '';
  stderr.on('data', (chunk: Buffer) => {
    const text = tail + chunk.toString('utf8');
    if (/(?:unknown|unrecogni[sz]ed|unsupported|unexpected|no such)\s+(?:(?:shorthand|command-line)\s+)?(?:flag|option|argument|subcommand|command)s?\b|flag provided but not defined|no help topic for\b/i.test(text)) {
      const probe = versionProbe;
      const version = probe && probe.fingerprint === launched ? probe.status.version : undefined;
      if (probe && probe.fingerprint === launched) {
        probe.unsupportedSyntax = true;
        probe.status = { state: 'outdated', version };
      }
      fail(`本机 agy CLI${version ? '（当前 v' + version + '）' : ''}不支持此命令，请运行 agy update 更新后重试`);
    }
    tail = text.slice(-96);
  });
}

function officialCli(): string {
  const binary = ['darwin', 'win32'].includes(process.platform) && resolveAntigravityCli();
  if (!binary) throw new Error('请先安装官方 Antigravity CLI（agy）');
  return binary;
}

function cliLaunch(binary: string, args: string[], root: string, isolated: boolean, env: NodeJS.ProcessEnv) {
  const fingerprint = cliFingerprint(binary);
  const launch = process.platform === 'win32' ? windowsUsageLaunch : macUsageLaunch;
  return { ...launch(binary, args, root, isolated, env), fingerprint };
}

/** The official CLI owns OAuth and file fallback; the child cannot reach the live login. */
export function isolatedCli(directory: string, args: string[], original?: Buffer, inheritedEnv = process.env) {
  const binary = officialCli();
  ensureDir(directory);
  const root = fs.realpathSync(directory);
  if (original) atomicWrite(cliTokenPath(root), original);
  return cliLaunch(binary, args, root, true, inheritedEnv);
}

export function startAcpLogin(directory: string, allowBrowser = true, onAuthenticate?: () => void) {
  const windows = process.platform === 'win32';
  if (windows && allowBrowser) throw new Error('请在 Windows 官方客户端完成 Antigravity 登录后保存账号');
  const launch = isolatedCli(directory, ['acp']);
  const linkFile = path.join(directory, 'login-url');
  if (!windows) prepareMacLoginLink(directory);
  const child = withTemporaryProcess(directory, () => spawn(launch.command, launch.args, {
    ...launch.options, detached: !windows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  if (child.pid) isolatedCliPids.add(child.pid);
  let resolveLink!: (url: string) => void, rejectLink!: (error: Error) => void;
  let resolveDone!: (value: { plan?: string }) => void, rejectDone!: (error: Error) => void;
  const link = new Promise<string>((resolve, reject) => { resolveLink = resolve; rejectLink = reject; });
  const complete = new Promise<{ plan?: string }>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Callers may only need one promise (quota has no browser link).
  void link.catch(() => {}); void complete.catch(() => {});
  let result: { plan?: string } | undefined, failure: Error | undefined, ending = false;
  let terminate: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const stopped = new Promise<void>(resolve => child.once('close', code => {
    if (child.pid) isolatedCliPids.delete(child.pid);
    clearTimeout(terminate); clearTimeout(kill); clearTimeout(timer); clearInterval(poll);
    void drainTemporaryProcessGroup(child, 150).finally(() => {
      if (windows) {
        const drained = confirmWindowsQuotaExit(directory, child, code);
        if (drained && code === 124) failure = isolatedLaunchFailed();
        else if (!drained || code !== 0) failure ??= new Error('Windows 额度查询未正常结束，凭据写回尚未确认');
      }
      if (result && !failure) resolveDone(result);
      else { const error = failure || new Error('官方 CLI 未完成登录，请重试'); rejectLink(error); rejectDone(error); }
      resolve();
    });
  }));
  const loginTimedOut = () => { resultDiagnostic('timeout'); finish('Antigravity 登录超时，请重试'); };
  let timer = setTimeout(loginTimedOut, 45000);
  const poll: NodeJS.Timeout | undefined = windows ? undefined : setInterval(() => {
    if (ending || !fs.existsSync(linkFile)) return;
    const value = fs.readFileSync(linkFile, 'utf8'), url = URL.parse(value);
    if (!url || url.origin !== 'https://accounts.google.com' || !url.searchParams.get('state')) return finish('官方 CLI 返回的登录链接无效');
    if (!allowBrowser) {
      stepDiagnostic('query-login-prompt');
      return finish('官方 CLI 请求重新登录，未确认本次续期结果');
    }
    resolveLink(value);
    clearTimeout(timer);
    timer = setTimeout(loginTimedOut, 15 * 60000);
    clearInterval(poll);
  }, 100);
  function finish(reason?: string | Error) {
    if (ending) return;
    ending = true;
    clearTimeout(timer); clearInterval(poll);
    if (reason) { failure = typeof reason === 'string' ? new Error(reason) : reason; rejectLink(failure); }
    child.stdin.end();
    if (windows) {
      // Normal ACP completion lets the official client flush on EOF. A cancellation asks its supervisor to drain the Job.
      if (reason) stopWindowsQuota(directory, child);
      else terminate = setTimeout(() => stopWindowsQuota(directory, child), 8000);
      kill = setTimeout(() => stopTemporaryProcess(child, 'SIGKILL'), reason ? 8000 : 16000);
    } else {
      if (reason) stopTemporaryProcess(child);
      else terminate = setTimeout(() => stopTemporaryProcess(child), 150);
      kill = setTimeout(() => stopTemporaryProcess(child, 'SIGKILL'), 1500);
    }
  }
  const send = (message: object) => { if (child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  child.on('error', () => finish('无法启动官方 Antigravity CLI'));
  child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') finish('Antigravity 登录连接已关闭'); });
  watchUnsupportedSyntax(child.stderr, launch.fingerprint, finish);
  createInterface({ input: child.stdout }).on('line', line => {
    if (ending) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === 1) {
      if (!message.result) return finish('此版本的 agy 不支持 ACP 登录，请更新官方 CLI');
      if (child.stdin.writable) onAuthenticate?.();
      send({ id: 2, method: 'authenticate', params: { methodId: 'oauth-personal' } });
    } else if (message.id === 2) {
      if (message.error) return finish(/invalid_grant|refresh token.*(?:expired|revoked|invalid)/i.test(message.error.message || '')
        ? new AntigravityLoginRequired() : '官方 Antigravity 认证失败，请重试或更新凭据');
      result = { plan: antigravityPlan(message.result?._meta?.antigravity?.tier) };
      finish();
    }
  });
  send({ id: 1, method: 'initialize', params: { protocolVersion: 1,
    clientInfo: { name: 'AgentSwitcher', version: require('../package.json').version }, clientCapabilities: {} } });
  return { link, complete, stop: () => { finish('登录已取消'); return stopped; } };
}

type UsageLaunch = ReturnType<typeof cliLaunch>;

function runUsage(launch: UsageLaunch, isolatedDirectory?: string): Promise<{ stdout: string; code: number | null }> {
  const start = () => spawn(launch.command, launch.args, {
    ...launch.options, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = isolatedDirectory ? withTemporaryProcess(isolatedDirectory, start) : start();
  if (child.pid && isolatedDirectory) isolatedCliPids.add(child.pid);
  if (child.pid) stepDiagnostic('query-start');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, failure: Error | undefined, kill: NodeJS.Timeout | undefined;
    const stop = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      const windows = process.platform === 'win32';
      if (windows) stopWindowsQuota(launch.options.cwd, child);
      else stopTemporaryProcess(child);
      kill = setTimeout(() => stopTemporaryProcess(child, 'SIGKILL'), windows ? 8000 : 1500);
    };
    const timeout = setTimeout(() => {
      if (!failure) resultDiagnostic('timeout');
      stop('Antigravity 额度查询超时，请稍后重试');
    }, 45000);
    child.on('error', () => { failure ??= new Error('无法启动官方 Antigravity CLI'); });
    watchUnsupportedSyntax(child.stderr, launch.fingerprint, stop);
    // Headless CLI can start an OAuth flow after a network failure. Match its prompt
    // at a line boundary so quoted text inside a successful JSON response is harmless.
    const loginPrompt = '\nAuthentication required. Please visit the URL to log in:';
    for (const stream of [child.stdout, child.stderr]) {
      let tail = '\n';
      stream.on('data', (chunk: Buffer) => {
        if (failure) return;
        size += chunk.length;
        if (size > 2 * 1024 * 1024) return stop('官方 Antigravity CLI 返回的数据过大');
        const text = tail + chunk.toString('utf8');
        if (text.includes(loginPrompt)) {
          stepDiagnostic('query-login-prompt');
          return stop('额度查询未完成，请在 Antigravity 中确认登录状态后重试');
        }
        tail = text.slice(1 - loginPrompt.length);
        if (stream === child.stdout) chunks.push(chunk);
      });
    }
    child.once('close', code => {
      clearTimeout(timeout); clearTimeout(kill);
      if (child.pid && isolatedDirectory) isolatedCliPids.delete(child.pid);
      if (child.pid) stepDiagnostic('query-end');
      void drainTemporaryProcessGroup(child, 150).finally(() => {
        if (process.platform === 'win32' && isolatedDirectory) {
          if (!confirmWindowsQuotaExit(isolatedDirectory, child, code)) failure ??= new Error('无法确认 Windows 额度子进程已退出');
          else if (code === 124) failure = isolatedLaunchFailed();
        }
        if (failure) reject(failure);
        else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code });
      });
    });
  });
}

const usageArgs = ['-p', '/usage', '--output-format', 'json'];

async function readUsage(launch: UsageLaunch, isolatedDirectory?: string): Promise<UsageData> {
  const { stdout, code } = await runUsage(launch, isolatedDirectory);
  let response;
  try { response = JSON.parse(stdout); }
  catch { throw new Error(code === 0 ? '官方 CLI 额度格式无法识别' : '官方 Antigravity CLI 额度查询失败'); }
  if (code !== 0 || response?.status === 'ERROR') {
    // CLI diagnostics can contain identifiers and URLs. Return only recognized categories.
    const reason = typeof response?.error === 'string' ? response.error.replace(/https?:\/\/[^\s"'<>]+/gi, '') : '';
    if (/\b(?:429|RESOURCE_EXHAUSTED|too many requests|rate limit(?:ed| exceeded)?)\b/i.test(reason)) {
      stepDiagnostic('query-limited');
      throw new Error('Antigravity 暂时限制了额度查询，请稍后重试');
    }
    if (/\b(?:50[0234]|service unavailable|bad gateway)\b/i.test(reason)) {
      stepDiagnostic('query-unavailable');
      throw new Error('Antigravity 额度服务暂不可用，请稍后重试');
    }
    if (/\b(?:connection refused|connection reset|no such host|network is unreachable|i\/o timeout|deadline exceeded)\b/i.test(reason)) {
      stepDiagnostic('query-network');
      throw new Error('无法连接 Antigravity 额度服务，请检查网络后重试');
    }
    if (response?.status === 'ERROR' && /\b(?:401|unauthenticated|invalid_token)\b/i.test(reason)) {
      stepDiagnostic('query-access-rejected');
      throw new AntigravityAccessRejected();
    }
    throw new Error('官方 Antigravity CLI 额度查询失败');
  }
  if (response?.status !== 'SUCCESS' || response.command?.name !== 'usage') throw new Error('官方 CLI 未返回额度');
  return response.command.data || {};
}

function networkEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir)$/i.test(name)));
}

/** The official CLI uses its own login. The caller must bind quota to the selected account separately. */
export async function querySharedUsage(): Promise<UsageData> {
  const binary = officialCli();
  const windows = process.platform === 'win32';
  const cwd = windows ? createTemporaryCredentials('agy-quota') : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ags-shared-usage-'));
  try {
    const args = [...usageArgs, '--settings', '{"disableSlashCommands":false}', '--log-file', windows ? 'NUL' : '/dev/null'];
    return await readUsage(cliLaunch(binary, args, cwd, false, networkEnvironment()));
  } finally {
    if (windows) releaseTemporaryCredentials(cwd);
    else fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export async function queryAccessTokenUsage(email: string | undefined, accessToken: string, expiry?: string): Promise<UsageData> {
  const directory = createTemporaryCredentials('agy-quota');
  try {
    const token = { auth_method: 'consumer', id_token_email: email,
      token: { access_token: accessToken, token_type: 'Bearer', expiry } };
    // Keep network configuration while excluding alternate logins and client overrides.
    const launch = isolatedCli(directory, usageArgs, Buffer.from(JSON.stringify(token)), networkEnvironment());
    return await readUsage(launch, directory);
  } finally { releaseTemporaryCredentials(directory); }
}

/** Verification seeds have no email and must obtain the requested identity from the official output. */
export function matchesQuotaIdentity(expected: string, input: NativeToken, output: NativeToken): boolean {
  const from = nativeTokenIdentity(input), to = nativeTokenIdentity(output);
  if (to === expected) return from === expected || !tokenEmail(input);
  return from === expected && input.token.refresh_token === output.token.refresh_token &&
    (!tokenEmail(input) || !tokenEmail(output));
}

export async function queryIsolatedUsage(original: Buffer, identity: string, refreshToken?: string) {
  const directory = createTemporaryCredentials('agy-quota');
  try {
    markTemporaryCredentialsPending(directory, identity, refreshToken, original);
  } catch (error) {
    releaseTemporaryCredentials(directory);
    throw error;
  }
  try {
    let data: UsageData | undefined, plan: string | undefined, error: Error | undefined;
    let requestStarted = false;
    try {
      atomicWrite(cliTokenPath(directory), original);
      const auth = startAcpLogin(directory, false, () => { requestStarted = true; });
      ({ plan } = await auth.complete);
    } catch (failure) { error = failure as Error; }
    const file = cliTokenPath(directory);
    // OAuth may rotate before /usage fails. Do not discard the new refresh token.
    const output = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const changed = !!output && !original.equals(output);
    const seed = parseNativeToken(original);
    let rotated = output ?? original;
    if (changed) {
      try { rotated = bindNativeTokenIdentity(rotated, seed); }
      catch { /* Preserve unrecognized output for the existing identity and recovery checks. */ }
    }
    if ((!changed || rotated.equals(original)) && requestStarted && error && !(error instanceof AntigravityLoginRequired)) {
      // A lost reply is not proof the server left the input refresh token untouched.
      throw new PendingQuotaConflict();
    }
    recordAntigravityQuotaOutput(directory, identity, output, rotated);
    if (!changed) releaseTemporaryCredentials(directory);
    if (!error) {
      try {
        const credential = parseNativeToken(rotated), email = tokenEmail(credential);
        if (!matchesQuotaIdentity(identity, seed, credential)) throw new Error('官方 CLI 返回的账号与查询目标不一致');
        const bearer = findQuotaBearer(credential);
        if (!bearer) throw new Error('官方 CLI 完成认证后未提供可用的访问令牌');
        // /usage cannot rotate again, even if the bearer expires or its response is lost.
        data = await queryAccessTokenUsage(email, bearer.accessToken, bearer.expiry);
      } catch (failure) { error = failure as Error; }
    }
    return { data, plan, error, rotated, temporaryDirectory: changed ? directory : undefined };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('额度查询未完成');
    if (error instanceof PendingQuotaConflict) stepDiagnostic(error.diagnostic);
    failure.message += `；临时凭据已保留在 ${directory}`;
    throw failure;
  }
}
