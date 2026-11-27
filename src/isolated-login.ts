import { cancelLogin, loginStatus, prepareLogin, saveAccount, credentialUpdateTarget, updateAccountCredentials, isSameIdentity, CredentialUpdateTarget } from './accounts';
import type { BaseAgent } from './agents/base';

export interface LoginSession {
  attempt: number; directory: string; target?: CredentialUpdateTarget; link: Promise<string>; stop(): Promise<void>;
  readonly phase: 'starting' | 'waiting' | 'finishing' | 'complete' | 'failed'; readonly error?: string;
}

export function createLoginManager(agent: BaseAgent, startServer: (directory: string, target?: CredentialUpdateTarget) => LoginSession) {
  let server: LoginSession | undefined;
  let generation = 0;
  let operations = 0;
  let queue = Promise.resolve();

  // Serialize short operations on the isolated home, never the browser sign-in itself.
  function inOrder<T>(work: () => Promise<T>) {
    operations++;
    const result = queue.then(work).finally(() => { operations--; });
    queue = result.then(() => {}, () => {});
    return result;
  }
  async function discard() {
    if (server) await server.stop();
    server = undefined;
    cancelLogin(agent);
  }
  function hasLogin() { return !!server || operations > 0; }
  function canDiscardForDesktop(seenAttempt?: number) {
    return server?.phase === 'failed' || (server?.phase === 'complete' && server.attempt === seenAttempt);
  }
  function cancel() {
    generation++;
    server?.stop();
    return inOrder(discard);
  }
  function cancelIdentity(identity?: string) {
    if (!identity || !server) return Promise.resolve();
    const matches = server.target?.identity.id === identity || agent.identity(server.directory)?.id === identity;
    return matches ? cancel() : Promise.resolve();
  }
  function useLink(deliver: (url: string) => Promise<void> | void, seenAttempt?: number, updateProfile?: string) {
    const expected = generation;
    return inOrder(async () => {
      if (server?.phase === 'finishing') await server.stop();
      if (expected !== generation) return { canceled: true };
      if (server && server.target?.profile !== updateProfile) await discard();
      // A second click can arrive between the callback and the next UI poll.
      // Keep the completed account until the user has actually seen it.
      if (server?.phase === 'complete' && server.attempt !== seenAttempt) return { completed: true };
      if (server?.phase === 'complete' || server?.phase === 'failed') await discard();
      if (!server) {
        const target = updateProfile === undefined ? undefined : credentialUpdateTarget(agent, updateProfile, { allowStaged: true });
        const directory = await prepareLogin(agent);
        if (expected !== generation) { cancelLogin(agent); return { canceled: true }; }
        if (!directory) throw new Error('无法创建独立登录目录');
        try { server = startServer(directory, target); }
        catch (err) { cancelLogin(agent); throw err; }
      }
      try {
        const url = await server.link;
        if (expected !== generation || server.phase !== 'waiting') return { canceled: true };
        await deliver(url);
        return { ok: true };
      } catch (err) {
        if (expected !== generation) return { canceled: true };
        throw err;
      }
    });
  }
  function status() {
    if (server && server.phase !== 'complete') return {
      isolated: true, ready: false, attempt: server.attempt, errorMessage: server.error,
      account: server.error ? '等待重新登录' : server.phase === 'finishing' ? '正在读取新账号…' : '等待浏览器登录',
    };
    const status = { ...loginStatus(agent), attempt: server?.attempt };
    if (!server?.target) return status;
    return { ...status, updateProfile: server.target.profile,
      matchesTarget: isSameIdentity(server.target.identity, agent.identity(server.directory)) };
  }
  function save(name: string, attempt?: number) {
    const expected = generation;
    return inOrder(async () => {
      if (expected !== generation || attempt !== server?.attempt || server?.target || (server && server.phase !== 'complete')) {
        throw new Error('登录状态已变化，请重新检测账号后保存');
      }
      const current = server;
      if (current) await current.stop(); // flush the isolated home before saveAccount consumes it
      const result = await saveAccount(agent, name, () => {
        if (expected !== generation || server !== current) throw new Error('登录已取消，请重新登录');
      });
      server = undefined;
      return result;
    });
  }

  function update(name: string, attempt: number) {
    const expected = generation;
    return inOrder(async () => {
      const current = server;
      if (expected !== generation || !current?.target || current.target.profile !== name ||
          current.attempt !== attempt || current.phase !== 'complete') {
        throw new Error('请完成此账号的重新登录后再更新');
      }
      await current.stop();
      const result = await updateAccountCredentials(current.target, current.directory, () => {
        if (expected !== generation || server !== current) throw new Error('登录已取消，请重新登录');
      }, { trusted: true });
      await discard();
      return result;
    });
  }
  return { hasLogin, canDiscardForDesktop, cancel, cancelIdentity, useLink, status, save, update };
}
