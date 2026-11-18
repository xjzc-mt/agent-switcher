import fs from 'fs';
import { isolatedCliPids } from './antigravity-cli';
import os from 'os';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { jwtInfo } from './utils';
import type { StatusResult } from './agents/base';

const run = promisify(execFile);
const KEYRING_PREFIX = 'go-keyring-base64:';
export const NATIVE_TOKEN_FILE = 'jetski-standalone-oauth-token';
export interface NativeToken {
  auth_method: string;
  id_token?: string;
  id_token_email?: string;
  token: { access_token?: string; refresh_token?: string; expiry?: string };
}

export function parseNativeToken(bytes: Buffer): NativeToken {
  let value: NativeToken;
  try { value = JSON.parse(bytes.toString()); } catch { throw new Error('Antigravity 凭据格式无效'); }
  if (value?.auth_method !== 'consumer' || !value.token?.refresh_token ||
      !(value.id_token_email || jwtInfo(value.id_token).email)) {
    throw new Error('仅支持包含身份和续期凭据的个人 Google 账号');
  }
  return value;
}

export function readNativeToken(): Buffer | null {
  if (process.platform !== 'darwin') throw new Error('Keychain 仅支持 macOS');
  // An active file fallback requires separate precedence/rotation verification.
  if ([NATIVE_TOKEN_FILE, 'antigravity-cli/antigravity-oauth-token'].some(file => fs.existsSync(path.join(os.homedir(), '.gemini', file)))) {
    throw new Error('检测到文件认证回退，暂不混用 Keychain 与文件认证');
  }
  let encoded: string;
  try {
    encoded = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if ((error as { status?: number }).status === 44) return null;
    throw new Error('无法读取 Antigravity Keychain 凭据');
  }
  if (!encoded.startsWith(KEYRING_PREFIX)) throw new Error('尚未支持此版本的 Antigravity Keychain 格式');
  const bytes = Buffer.from(encoded.slice(KEYRING_PREFIX.length), 'base64');
  parseNativeToken(bytes);
  return bytes;
}

export function writeNativeToken(bytes: Buffer | null): void {
  if (bytes) parseNativeToken(bytes);
  readNativeToken(); // Check platform and file-fallback conflicts before changing anything.
  if (!bytes) {
    try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity'], { stdio: 'pipe', timeout: 10000 }); }
    catch (error) { if ((error as { status?: number }).status !== 44) throw new Error('无法还原 Antigravity 未登录状态'); }
    return;
  }
  const encoded = KEYRING_PREFIX + bytes.toString('base64');
  try {
    // stdin keeps the secret out of process arguments and shell history.
    execFileSync('/usr/bin/security', ['-i'], {
      input: `add-generic-password -U -s gemini -a antigravity -w "${encoded}"\n`,
      timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { throw new Error('无法更新 Antigravity Keychain 凭据'); }
  if (!readNativeToken()?.equals(bytes)) throw new Error('Antigravity Keychain 写入未完成');
}

export async function sharedAntigravitySessions(): Promise<number[]> {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || isolatedCliPids.has(Number(match[1]))) return [];
    const command = match[2];
    return path.basename(command) === 'agy' || (path.basename(command) === 'language_server' &&
      !command.startsWith('/Applications/Antigravity.app/')) ? [Number(match[1])] : [];
  });
}

export interface UsageBucket { id: string; name: string; window?: string; remaining_fraction?: number; reset_time?: string; disabled?: boolean }
export interface UsageData { groups?: Array<{ name: string; buckets: UsageBucket[] }> }
export function quotaFromUsage(data: UsageData, email: string): StatusResult {
  const buckets = (data.groups || []).map(group => ({
    id: group.name, label: group.name.replace(/ models$/i, '').replace(' and ', ' / '),
    windows: (group.buckets || []).filter(bucket => !bucket.disabled &&
      typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)).map(bucket => ({
      usedPercent: 100 * (1 - Math.max(0, Math.min(1, bucket.remaining_fraction!))),
      windowMins: bucket.window === '5h' ? 300 : bucket.window === 'weekly' ? 10080 : undefined,
      resetsAt: Number.isFinite(Date.parse(bucket.reset_time || '')) ? Date.parse(bucket.reset_time!) / 1000 : undefined,
    })).sort((a, b) => (a.windowMins || Infinity) - (b.windowMins || Infinity)),
  }));
  if (!buckets.some(bucket => bucket.windows.length)) throw new Error('官方 CLI 未返回可读取的比例额度');
  return { available: true, account: email, state: 'ok', quota: { buckets }, fetchedAt: new Date().toISOString() };
}

