import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, ensureDir } from './utils';

export function prepareMacLoginLink(directory: string) {
  atomicWrite(path.join(directory, 'bin/open'), '#!/bin/sh\nfor arg in "$@"; do case "$arg" in https://*|http://*) url="$arg"; break ;; esac; done\nprintf "%s" "${url:-$1}" > "$AGS_LOGIN_LINK.tmp"\nmv "$AGS_LOGIN_LINK.tmp" "$AGS_LOGIN_LINK"\n');
  fs.chmodSync(path.join(directory, 'bin/open'), 0o700);
}

export function macUsageLaunch(binary: string, args: string[], root: string, isolated: boolean, inheritedEnv: NodeJS.ProcessEnv) {
  if (!isolated) {
    const home = os.homedir();
    const policy = '(version 1)(allow default)(deny appleevent-send)' +
      '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))' +
      '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))' +
      `(deny file-read* file-write* (subpath ${JSON.stringify(path.join(home, '.agent-switcher'))}))`;
    const env = { ...inheritedEnv, HOME: home, TMPDIR: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    return { command: '/usr/bin/sandbox-exec', args: ['-p', policy, binary, ...args], options: { cwd: root, env } };
  }
  const liveHome = fs.realpathSync(os.homedir());
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
    'ANTIGRAVITY_APP_DATA_DIR', 'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN', 'AGY_LLM_GATEWAY_URL',
    'AGY_LLM_GATEWAY_API_KEY', 'GOOGLE_GEMINI_BASE_URL']) delete (env as NodeJS.ProcessEnv)[key];
  return { command: '/usr/bin/sandbox-exec', args: ['-p', policy, binary, ...args], options: { cwd: root, env } };
}
