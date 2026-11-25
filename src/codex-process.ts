import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'node:path';
import os from 'node:os';
import { windowsCodexFileIssue } from './codex-file-auth';
import { drainTemporaryProcessGroup, stopTemporaryProcess, withTemporaryProcess } from './temporary-credentials';

export const isolatedCodexPids = new Set<number>();

export { findWindowsCodexBinary } from './windows-codex';

const isolatedVariables = new Set([
  'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_APP_SERVER_CHATGPT_BASE_URL', 'OPENAI_BASE_URL',
  'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
]);

interface Handlers {
  onMessage(message: any): void;
  onError(kind: 'start' | 'connection'): void;
  onClose(): void;
  onSpawn?(): void;
  onStderr?(chunk: Buffer): void;
}

// Only transport and process lifetime are shared; each caller owns its protocol.
export function startCodexProcess(binary: string, home: string, handlers: Handlers) {
  if (process.platform === 'win32') {
    const issue = windowsCodexFileIssue(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), true);
    if (issue) throw new Error(issue);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isolatedVariables.has(key.toUpperCase())) delete env[key];
  }
  env.CODEX_HOME = home;
  const child = withTemporaryProcess(home, () => spawn(binary, ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
    cwd: home, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  if (handlers.onSpawn) child.once('spawn', handlers.onSpawn);
  if (child.pid) isolatedCodexPids.add(child.pid);
  let closing = false, closed = false, drainGraceMs = 200;
  let terminate: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const stopped = new Promise<void>(resolve => child.once('close', () => {
    if (child.pid) isolatedCodexPids.delete(child.pid);
    closed = true;
    clearTimeout(terminate); clearTimeout(kill);
    void drainTemporaryProcessGroup(child, drainGraceMs).finally(() => {
      handlers.onClose();
      resolve();
    });
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
        drainGraceMs = graceMs;
        // Wait for close so callers can read credentials flushed after stdin EOF.
        child.stdin.end();
        terminate = setTimeout(() => stopTemporaryProcess(child), graceMs);
        kill = setTimeout(() => stopTemporaryProcess(child, 'SIGKILL'), Math.min(1500, Math.max(graceMs + 300, 400)));
      }
      return stopped;
    },
  };
}
