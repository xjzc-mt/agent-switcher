import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { windowsHelper } from './windows-helper';

export const windowsUsageHome = (directory: string) => path.join(directory, 'cli-home');

/** The user selects the trust bundle. Publish only parsed public certificates, never adjacent private keys. */
function stageCertificates(source: string, destination: string, budget: { bytes: number }, directoryEntry = false) {
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size > budget.bytes) throw new Error();
  const bytes = fs.readFileSync(source);
  budget.bytes -= bytes.length;
  if (budget.bytes < 0) throw new Error();
  const blocks = bytes.toString('ascii').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  let certificates: X509Certificate[];
  try { certificates = blocks ? blocks.map(pem => new X509Certificate(pem)) : [new X509Certificate(bytes)]; }
  catch (error) { if (directoryEntry) return; throw error; } // A trust directory may contain key-only files as well.
  fs.writeFileSync(destination, certificates.map(cert => cert.toString()).join('\n'), { flag: 'wx', mode: 0o600 });
}

function sandboxTrust(home: string, env: NodeJS.ProcessEnv) {
  if (!env.SSL_CERT_FILE && !env.SSL_CERT_DIR) return;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const trust = fs.mkdtempSync(path.join(home, 'ca-')), budget = { bytes: 8 * 1024 * 1024 };
  try {
    if (env.SSL_CERT_FILE) {
      const bundle = path.join(trust, 'bundle.pem');
      stageCertificates(env.SSL_CERT_FILE, bundle, budget);
      env.SSL_CERT_FILE = bundle;
    }
    if (env.SSL_CERT_DIR) {
      const dirs: string[] = [];
      for (const source of env.SSL_CERT_DIR.split(';').filter(Boolean)) {
        const target = path.join(trust, String(dirs.length));
        fs.mkdirSync(target, { mode: 0o700 });
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
          if (!(entry.isFile() || entry.isSymbolicLink()) || !/\.(?:pem|crt|cer)$|^[\da-f]{8}\.\d+$/i.test(entry.name)) continue;
          stageCertificates(path.join(source, entry.name), path.join(target, entry.name), budget, true);
        }
        dirs.push(target);
      }
      env.SSL_CERT_DIR = dirs.join(';');
    }
  } catch {
    throw new Error('无法准备 Windows 额度查询的自定义 CA，请检查 SSL_CERT_FILE 或 SSL_CERT_DIR 中的公开证书。');
  }
}

/** Request shutdown through the launcher's private working directory so it can drain its Job and issue a receipt. */
export function stopWindowsQuota(directory: string, child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { fs.writeFileSync(path.join(directory, '.ags-stop-' + child.pid), '', { flag: 'wx', mode: 0o600 }); }
  catch { /* A hard-stop deadline still bounds the wait if the owner directory is unavailable. */ }
}

export function windowsUsageLaunch(binary: string, cliArgs: string[], root: string, isolated: boolean, inheritedEnv: NodeJS.ProcessEnv) {
  const helper = windowsHelper('AgySandbox'), env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(?:SystemRoot|windir|SystemDrive|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP)$/i.test(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(inheritedEnv)) {
    if (/^(?:https?_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(name)) env[name.toUpperCase()] = value;
  }
  const windows = process.env.SystemRoot || 'C:\\Windows';
  env.PATH = path.join(windows, 'System32');
  if (isolated) {
    env.USERPROFILE = os.homedir();
    env.SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0';
    sandboxTrust(windowsUsageHome(root), env);
  }
  return { command: helper, args: [isolated ? 'isolated' : 'shared', String(process.pid), binary, ...cliArgs],
    options: { cwd: root, env, windowsHide: true } };
}
