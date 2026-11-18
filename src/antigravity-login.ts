import fs from 'fs';
import path from 'path';
import { antigravityAgent } from './agents/antigravity';
import { createLoginManager, LoginSession } from './isolated-login';
import { cliTokenPath, startAcpLogin } from './antigravity-cli';
import { parseNativeToken, NATIVE_TOKEN_FILE } from './antigravity-native';
import { atomicWrite } from './utils';
import type { CredentialUpdateTarget } from './accounts';

let nextAttempt = 0;
function startServer(directory: string, target?: CredentialUpdateTarget): LoginSession {
  const session = startAcpLogin(directory);
  let phase: LoginSession['phase'] = 'starting', error: string | undefined;
  const link = session.link.then(url => { phase = 'waiting'; return url; });
  void session.complete.then(() => {
    const bytes = fs.readFileSync(cliTokenPath(directory));
    parseNativeToken(bytes);
    atomicWrite(path.join(directory, NATIVE_TOKEN_FILE), bytes);
    phase = 'complete';
  }).catch(reason => { phase = 'failed'; error = reason instanceof Error ? reason.message : 'Antigravity 登录未完成，请重试'; });
  return { attempt: ++nextAttempt, directory, target, link, stop: session.stop,
    get phase() { return phase; }, get error() { return error; } };
}
export const antigravityLogin = createLoginManager(antigravityAgent, startServer);
