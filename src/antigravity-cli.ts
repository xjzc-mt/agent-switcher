import fs from 'fs';
import type { UsageData } from './antigravity-native';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { atomicWrite, ensureDir } from './utils';
import { resultDiagnostic, stepDiagnostic } from './diagnostics';
import { createTemporaryCredentials, drainTemporaryProcessGroup, markTemporaryCredentialsPending, releaseTemporaryCredentials, stopTemporaryProcess, withTemporaryProcess } from './temporary-credentials';

export const isolatedCliPids = new Set<number>();
export class AntigravityLoginRequired extends Error {
  constructor() { super('Antigravity 登录已失效，请更新此账号的凭据'); }
}
export const cliTokenPath = (directory: string) => path.join(directory, '.gemini/antigravity-cli/antigravity-oauth-token');

/** The official CLI owns OAuth and file fallback; the child cannot reach the live login. */
export function isolatedCli(directory: string, args: string[], original?: Buffer, inheritedEnv = process.env) {
  if (process.platform !== 'darwin') throw new Error('Antigravity 独立会话目前仅支持 macOS');
  const binary = [path.join(os.homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'].find(fs.existsSync);
  if (!binary) throw new Error('请先安装官方 Antigravity CLI（agy）');
  ensureDir(directory);
  const root = fs.realpathSync(directory);
  const liveHome = fs.realpathSync(os.homedir());
  if (original) atomicWrite(cliTokenPath(root), original);
  ensureDir(path.join(root, 'tmp'));
  const blocked = ['.gemini', '.agent-switcher', 'Library/Keychains',
    'Library/Application Support/Antigravity', 'Library/Application Support/antigravity'];
  const policy = '(version 1)(allow default)' + blocked.map(name =>
    `(deny file-read* file-write* (subpath ${JSON.stringify(path.join(liveHome, name))}))`).join('') +
    '(deny process-exec (literal "/usr/bin/security") (literal "/usr/bin/open"))' +
    '(deny mach-lookup (global-name "com.apple.securityd"))' +
    `(deny file-write* (require-all (require-not (subpath ${JSON.stringify(root)})) (require-not (literal "/dev/null"))))`;
  // Only the child receives this home. HOME alone would not isolate macOS Keychain.
  const env = { ...inheritedEnv, HOME: root, TMPDIR: path.join(root, 'tmp'),
    PATH: path.join(root, 'bin') + ':' + process.env.PATH, AGS_LOGIN_LINK: path.join(root, 'login-url') };
  for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'AGY_ADC_AUTH', 'GEMINI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR', 'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN', 'AGY_LLM_GATEWAY_URL']) delete (env as NodeJS.ProcessEnv)[key];
  return { command: '/usr/bin/sandbox-exec', args: ['-p', policy, binary, ...args], options: { cwd: root, env } };
}

export function startAcpLogin(directory: string, allowBrowser = true) {
  const launch = isolatedCli(directory, ['acp']);
  const linkFile = launch.options.env.AGS_LOGIN_LINK;
  atomicWrite(path.join(directory, 'bin/open'), '#!/bin/sh\nfor arg in "$@"; do case "$arg" in https://*|http://*) url="$arg"; break ;; esac; done\nprintf "%s" "${url:-$1}" > "$AGS_LOGIN_LINK.tmp"\nmv "$AGS_LOGIN_LINK.tmp" "$AGS_LOGIN_LINK"\n');
  fs.chmodSync(path.join(directory, 'bin/open'), 0o700);
  const child = withTemporaryProcess(directory, () => spawn(launch.command, launch.args, {
    ...launch.options, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
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
  const stopped = new Promise<void>(resolve => child.once('close', () => {
    if (child.pid) isolatedCliPids.delete(child.pid);
    clearTimeout(terminate); clearTimeout(kill); clearTimeout(timer); clearInterval(poll);
    void drainTemporaryProcessGroup(child, 150).finally(() => {
      if (result && !failure) resolveDone(result);
      else { const error = failure || new Error('官方 CLI 未完成登录，请重试'); rejectLink(error); rejectDone(error); }
      resolve();
    });
  }));
  const loginTimedOut = () => { resultDiagnostic('timeout'); finish('Antigravity 登录超时，请重试'); };
  let timer = setTimeout(loginTimedOut, 45000);
  const poll = setInterval(() => {
    if (ending || !fs.existsSync(linkFile)) return;
    const value = fs.readFileSync(linkFile, 'utf8'), url = URL.parse(value);
    if (!url || url.origin !== 'https://accounts.google.com' || !url.searchParams.get('state')) return finish('官方 CLI 返回的登录链接无效');
    if (!allowBrowser) return finish(new AntigravityLoginRequired());
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
    if (reason) stopTemporaryProcess(child);
    else terminate = setTimeout(() => stopTemporaryProcess(child), 150);
    kill = setTimeout(() => stopTemporaryProcess(child, 'SIGKILL'), 1500);
  }
  const send = (message: object) => { if (child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  child.on('error', () => finish('无法启动官方 Antigravity CLI'));
  child.stdin.on('error', () => finish('Antigravity 登录连接已关闭'));
  createInterface({ input: child.stdout }).on('line', line => {
    if (ending) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === 1) {
      if (!message.result) return finish('此版本的 agy 不支持 ACP 登录，请更新官方 CLI');
      send({ id: 2, method: 'authenticate', params: { methodId: 'oauth-personal' } });
    } else if (message.id === 2) {
      if (message.error) return finish(/invalid_grant|refresh token.*(?:expired|revoked|invalid)/i.test(message.error.message || '')
        ? new AntigravityLoginRequired() : '官方 Antigravity 认证失败，请重试或更新凭据');
      result = { plan: message.result?._meta?.antigravity?.tier?.name };
      finish();
    }
  });
  send({ id: 1, method: 'initialize', params: { protocolVersion: 1,
    clientInfo: { name: 'AgentSwitcher', version: require('../package.json').version }, clientCapabilities: {} } });
  return { link, complete, stop: () => { finish('登录已取消'); return stopped; } };
}

function runUsage(directory: string, launch: ReturnType<typeof isolatedCli>): Promise<string> {
  const child = withTemporaryProcess(directory, () => spawn(launch.command, launch.args, {
    ...launch.options, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
  }));
  if (child.pid) { isolatedCliPids.add(child.pid); stepDiagnostic('query-start'); }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, failed = false, kill: NodeJS.Timeout | undefined;
    const stop = () => {
      if (failed) return;
      failed = true; stopTemporaryProcess(child);
      kill = setTimeout(() => stopTemporaryProcess(child, 'SIGKILL'), 1500);
    };
    const timeout = setTimeout(() => { if (!failed) resultDiagnostic('timeout'); stop(); }, 45000);
    child.on('error', () => { failed = true; });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) stop();
      else if (!failed) chunks.push(chunk);
    });
    child.once('close', code => {
      clearTimeout(timeout); clearTimeout(kill);
      if (child.pid) { isolatedCliPids.delete(child.pid); stepDiagnostic('query-end'); }
      void drainTemporaryProcessGroup(child, 150).finally(() => {
        if (failed || code !== 0) reject(new Error('官方 Antigravity CLI 额度查询失败或超时'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  });
}

const usageArgs = ['-p', '/usage', '--output-format', 'json'];

async function readUsage(directory: string, launch: ReturnType<typeof isolatedCli>): Promise<UsageData> {
  const stdout = await runUsage(directory, launch);
  let response;
  try { response = JSON.parse(stdout); } catch { throw new Error('官方 CLI 额度格式无法识别'); }
  if (response?.status !== 'SUCCESS' || response.command?.name !== 'usage') throw new Error('官方 CLI 未返回额度');
  return response.command.data || {};
}

export async function queryAccessTokenUsage(email: string, accessToken: string, expiry?: string): Promise<UsageData> {
  const directory = createTemporaryCredentials('agy-quota');
  try {
    const token = { auth_method: 'consumer', id_token_email: email,
      token: { access_token: accessToken, token_type: 'Bearer', expiry } };
    // Keep network configuration while excluding alternate logins and client overrides.
    const networkEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(?:https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir)$/i.test(name)));
    const launch = isolatedCli(directory, usageArgs, Buffer.from(JSON.stringify(token)), networkEnv);
    return await readUsage(directory, launch);
  } finally { releaseTemporaryCredentials(directory); }
}

export async function queryIsolatedUsage(original: Buffer, identity: string, refreshToken?: string) {
  const directory = createTemporaryCredentials('agy-quota');
  try {
    markTemporaryCredentialsPending(directory, identity, refreshToken);
  } catch (error) {
    releaseTemporaryCredentials(directory);
    throw error;
  }
  try {
    let data: UsageData | undefined, plan: string | undefined, error: Error | undefined;
    try {
      const launch = isolatedCli(directory, usageArgs, original);
      const auth = startAcpLogin(directory, false);
      ({ plan } = await auth.complete);
      data = await readUsage(directory, launch);
    } catch (failure) { error = failure as Error; }
    const file = cliTokenPath(directory);
    // OAuth may rotate before /usage fails. Do not discard the new refresh token.
    const rotated = fs.existsSync(file) ? fs.readFileSync(file) : original;
    const changed = !original.equals(rotated);
    if (!changed) releaseTemporaryCredentials(directory);
    return { data, plan, error, rotated, temporaryDirectory: changed ? directory : undefined };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('额度查询未完成');
    failure.message += `；临时凭据已保留在 ${directory}`;
    throw failure;
  }
}
