import fs from 'fs';
import path from 'path';
import { windowsCodexProcesses } from './windows-processes';
import { sharedCliSessions } from './temporary-credentials';
import type { BaseAgent } from './agents/base';
import { credentialState } from './credential-state';
import { readJsonFile } from './utils';
import { runningClients } from './clients';
import { sharedAntigravitySessions, nativeLogoutSupport } from './antigravity-native';
import { isolatedCodexPids } from './codex-process';


/** Logout is deliberately narrower than switching: uncertain backends stay intact. */
export function logoutSupport(agent: BaseAgent): string | undefined {
  if (process.platform !== 'darwin') return '此系统的客户端退出尚未验证，请在官方客户端退出';
  if (agent.id === 'agy' && agent.management().storage === 'keychain' && agent.management().canSaveCurrent) {
    try { return nativeLogoutSupport(agent.readCredentials()[agent.authFiles[0]]); }
    catch (error) { return error instanceof Error ? error.message : '无法可靠确认客户端登录，请在官方客户端退出'; }
  }
  if (agent.id !== 'codex') return '此认证存储尚不支持自动退出，请在官方客户端退出';
  if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].some(key => process.env[key])) {
    return '检测到环境变量认证，请先在官方客户端退出';
  }
  try {
    if (fs.lstatSync(agent.homeDir).isSymbolicLink()) return '登录目录是符号链接，请在官方客户端退出';
    const config = fs.readFileSync(path.join(agent.homeDir, 'config.toml'), 'utf8');
    // Accept only an explicit, unambiguous root-level file backend. Never guess
    // the precedence of keyring/auto, multiline TOML, or managed requirements.
    const root = config.split(/^\s*\[/m)[0];
    if (/["']{3}/.test(config) || (config.match(/^\s*cli_auth_credentials_store\s*=/gm) || []).length !== 1 ||
        !/^\s*cli_auth_credentials_store\s*=\s*["']file["']\s*(?:#.*)?$/m.test(root) ||
        fs.existsSync(path.join(agent.homeDir, 'requirements.toml')) ||
        fs.existsSync('/etc/codex/requirements.toml') || fs.existsSync('/etc/codex/managed_config.toml')) {
      return '未确认 Codex 使用单一文件认证，请在官方客户端退出';
    }
    const auth = readJsonFile<Record<string, unknown>>(path.join(agent.homeDir, 'auth.json'));
    if (!auth || Object.keys(auth).some(key => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key))) {
      return 'Codex 凭据结构尚未验证，请在官方客户端退出';
    }
    if (!agent.identity()) return '未确认当前 Codex 账号';
  } catch { return '无法确认 Codex 文件认证，请在官方客户端退出'; }
}

export async function runningCodexSessions(options: { failClosed?: boolean } = {}): Promise<number[]> {
  if (process.platform === 'win32') {
    const pids = await windowsCodexProcesses();
    return pids.filter(pid => !isolatedCodexPids.has(pid));
  }
  if (process.platform !== 'darwin') {
    if (options.failClosed) throw new Error('此系统尚未实现 Codex 会话探测');
    return [];
  }
  return sharedCliSessions(isolatedCodexPids, command => ['codex', 'codex-cli'].includes(path.basename(command)));
}

export async function assertLogoutReady(agent: BaseAgent): Promise<void> {
  const unsupported = logoutSupport(agent);
  if (unsupported) throw new Error(unsupported);
  if ((await runningClients(agent.id, { failClosed: true })).length) throw new Error('请先正常退出客户端，再移除本机登录');
  if (agent.id === 'agy') {
    if ((await sharedAntigravitySessions()).length) throw new Error('请先结束共用认证的 agy 或 IDE 会话');
  } else if ((await runningCodexSessions()).length) {
    throw new Error('请先结束 Codex CLI、IDE 或其他正在使用凭据的会话');
  }
}

/** Caller holds identity + mutation locks and has stopped shared clients. */
export function clearClientCredentials(agent: BaseAgent, identity: string, revision?: string): void {
  const unsupported = logoutSupport(agent);
  if (unsupported) throw new Error(unsupported);
  if (agent.identity()?.id !== identity || credentialState(agent).revision !== revision) {
    throw new Error('客户端账号或凭据已变化，未执行退出');
  }
  agent.writeCredentials(agent.homeDir, Object.fromEntries(agent.authFiles.map(file => [file, null])));
  if (Object.values(agent.readCredentials()).some(Boolean)) {
    throw new Error('客户端凭据仍存在或已被其他会话更新，账号池已保留，请重新核对');
  }
}
