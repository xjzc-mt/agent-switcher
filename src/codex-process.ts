import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { withTemporaryProcess } from './temporary-credentials';

interface Handlers {
  onMessage(message: any): void;
  onError(kind: 'start' | 'connection'): void;
  onClose(): void;
  onStderr?(chunk: Buffer): void;
}

// Only transport and process lifetime are shared; each caller owns its protocol.
export function startCodexProcess(binary: string, home: string, handlers: Handlers) {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  delete env.CODEX_SQLITE_HOME;
  const child = withTemporaryProcess(home, () => spawn(binary, ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
    cwd: home, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  }));
  let closing = false, closed = false;
  let terminate: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const stopped = new Promise<void>(resolve => child.once('close', () => {
    closed = true;
    clearTimeout(terminate); clearTimeout(kill);
    handlers.onClose();
    resolve();
  }));
  child.once('error', () => handlers.onError('start'));
  child.stdin.on('error', () => handlers.onError('connection'));
  child.stderr.on('data', chunk => handlers.onStderr?.(chunk));
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message && typeof message === 'object') handlers.onMessage(message);
  });
  return {
    send(message: object) {
      if (!closing && !closed && child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n');
    },
    stop(graceMs = 300) {
      if (!closing && !closed) {
        closing = true;
        // Wait for close so callers can read credentials flushed after stdin EOF.
        child.stdin.end();
        terminate = setTimeout(() => child.kill(), graceMs);
        kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      }
      return stopped;
    },
  };
}
