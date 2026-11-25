import path from 'path';
import { windowsCodexProcesses } from './windows-processes';
import { sharedCliSessions } from './temporary-credentials';
import type { BaseAgent } from './agents/base';
import { credentialState } from './credential-state';
import { runningClients } from './clients';
import { isolatedCodexPids } from './codex-process';


/** Logout is deliberately narrower than switching: uncertain backends stay intact. */
export function logoutSupport(agent: BaseAgent): string | undefined {
  if (process.platform !== 'darwin') return '此系统的客户端退出尚未验证，请在官方客户端退出';
  return agent.clientLogoutIssue();
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
  const issue = await agent.sharedSessionIssue();
  if (issue) throw new Error(issue);
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
