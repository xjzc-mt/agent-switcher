import { startCodexProcess } from './codex-process';
import type { CredentialUpdateTarget } from './accounts';
import { createLoginManager, LoginSession } from './isolated-login';
import { codexAgent } from './agents/codex';

let nextAttempt = 0;

// The official app-server owns the OAuth exchange and the loopback callback.
// Only the main process receives the browser URL; the renderer sees status.
function startServer(binary: string, directory: string, target?: CredentialUpdateTarget): LoginSession {
  let phase: LoginSession['phase'] = 'starting';
  let error: string | undefined;
  let loginId: string | undefined;
  let resolveLink!: (url: string) => void, rejectLink!: (reason: Error) => void;
  const link = new Promise<string>((resolve, reject) => { resolveLink = resolve; rejectLink = reject; });

  function finish(reason?: string) {
    if (phase !== 'starting' && phase !== 'waiting') return;
    phase = reason ? 'failed' : 'finishing';
    error = reason;
    clearTimeout(timeout);
    if (reason) rejectLink(new Error(reason));
    server.stop(350);
  }
  function stop() {
    if (phase === 'waiting') server.send({ id: 3, method: 'account/login/cancel', params: { loginId } });
    finish('登录已取消');
    return server.stop(350);
  }
  const server = startCodexProcess(binary, directory, {
    onError: kind => finish(kind === 'start' ? '无法启动 Codex CLI，请检查安装后重试' : '与 Codex 的登录连接已关闭，请重试'),
    onClose() {
      if (phase === 'finishing') {
        try {
          if (!codexAgent.identity(directory)) throw new Error();
          phase = 'complete';
        } catch {
          phase = 'failed';
          error = '登录已完成，但未取得可保存的凭据，请重新登录';
        }
      } else finish('Codex 登录已结束，请重新登录');
    },
    onMessage(msg) {
      if (phase !== 'starting' && phase !== 'waiting') return;
      if (msg.id === 1) {
        if (!msg.result) return finish('Codex CLI 未能初始化，请更新后重试');
        server.send({ method: 'initialized' });
        server.send({ id: 2, method: 'account/login/start', params: { type: 'chatgpt' } });
      } else if (msg.id === 2 && phase === 'starting') {
        const result = msg.result;
        if (msg.error?.code === -32601) return finish('此版本的 Codex CLI 不支持浏览器登录，请更新后重试');
        if (msg.error) {
          const occupied = /address already in use|port.{0,24}in use/i.test(String(msg.error.message));
          return finish(occupied ? '本机登录端口已被占用，请完成其他登录后重试' : 'Codex 未能启动浏览器登录，请重试');
        }
        if (!result || result.type !== 'chatgpt' || typeof result.loginId !== 'string' || !result.loginId) {
          return finish('Codex CLI 未返回可用的浏览器登录方式，请更新后重试');
        }
        const url = typeof result.authUrl === 'string' ? URL.parse(result.authUrl) : null;
        if (!url || !['https://auth.openai.com', 'https://chatgpt.com'].includes(url.origin) || url.username || url.password) {
          return finish('Codex 返回的登录链接无效，请重新登录');
        }
        loginId = result.loginId;
        phase = 'waiting';
        clearTimeout(timeout);
        timeout = setTimeout(() => finish('登录链接已过期，请重新登录'), 15 * 60000);
        resolveLink(result.authUrl);
      } else if (msg.method === 'account/login/completed' && phase === 'waiting' && msg.params?.loginId === loginId) {
        finish(msg.params.success === true ? undefined : '浏览器登录未完成，请重新登录');
      }
    },
  });
  let timeout = setTimeout(() => finish('准备登录链接超时，请重试'), 15000);
  server.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-switcher', version: require('../package.json').version } } });
  return { attempt: ++nextAttempt, directory, target, link, stop, get phase() { return phase; }, get error() { return error; } };
}

export const codexLogin = createLoginManager(codexAgent, (directory, target) => {
  const binary = codexAgent.findCodexBinary();
  if (!binary) throw new Error(codexAgent.missingRuntimeMessage('未找到 Codex CLI，请先安装 Codex'));
  return startServer(binary, directory, target);
});
