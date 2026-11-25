import { readRegularFile, replacePrivateFile } from './private-files';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import * as vault from './credential-vault';

export type CredentialWriter = Pick<typeof vault, 'encodeCredentialFile' | 'verifyCredentialWrite'>;

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function syncPath(file: string): void {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function atomicWrite(file: string, data: string | Buffer, writer: CredentialWriter = vault): void {
  ensureDir(path.dirname(file));
  const original = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const encoded = writer.encodeCredentialFile(file, original);
  const durable = encoded !== original && (process.platform === 'darwin' || process.platform === 'win32') && vault.commitsAntigravityQuota(file);
  const verify = encoded === original ? undefined : (temp: string) => writer.verifyCredentialWrite(file, fs.readFileSync(temp), original);
  replacePrivateFile(file, encoded, verify, durable);
  if (durable && process.platform === 'darwin') syncPath(path.dirname(file));
}

/** Restore a small credential set together, rolling back on a write failure. */
export function replaceFiles(dir: string, files: Record<string, Buffer | null>, writer?: CredentialWriter): void {
  ensureDir(dir);
  const previous = Object.fromEntries(Object.keys(files).map(name => [name, readBuffer(path.join(dir, name))]));
  const apply = (values: typeof files) => {
    for (const [name, data] of Object.entries(values)) {
      const file = path.join(dir, name);
      if (data === null) fs.rmSync(file, { force: true });
      else atomicWrite(file, data, writer);
    }
  };
  try { apply(files); } catch (error) { apply(previous); throw error; }
}

export function readBuffer(file: string): Buffer | null {
  const bytes = readRegularFile(file);
  return bytes && vault.decodeCredentialFile(file, bytes);
}

export function parseJsonBytes<T>(data: Buffer | null): T | null {
  if (!data) return null;
  try { return JSON.parse(data.toString()) as T; } catch { return null; }
}

export function readJsonFile<T>(file: string): T | null { return parseJsonBytes<T>(readBuffer(file)); }

export function jwtInfo(token?: string): Record<string, unknown> & { sub?: string; email?: string; name?: string } {
  if (typeof token !== 'string' || !token) return {};
  try {
    const parsed = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    for (const claim of ['sub', 'email', 'name']) {
      if (typeof parsed[claim] !== 'string') delete parsed[claim];
    }
    return parsed;
  } catch { return {}; }
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function differentEmail(expected?: string, observed?: string): boolean {
  return !!expected && !!observed && expected.trim().toLowerCase() !== observed.trim().toLowerCase();
}

export function extractRefreshToken(bytes: Buffer | null): string | undefined {
  if (!bytes) return undefined;
  try {
    const parsed = JSON.parse(bytes.toString());
    const rt = parsed?.tokens?.refresh_token ?? parsed?.token?.refresh_token ?? parsed?.refresh_token;
    return typeof rt === 'string' && rt ? rt : undefined;
  } catch { return undefined; }
}
