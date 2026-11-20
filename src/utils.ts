import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import * as vault from './credential-vault';

export type CredentialWriter = Pick<typeof vault, 'encodeCredentialFile' | 'verifyCredentialWrite'>;

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function atomicWrite(file: string, data: string | Buffer, writer: CredentialWriter = vault): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const original = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    const encoded = writer.encodeCredentialFile(file, original);
    fs.writeFileSync(temp, encoded, { mode: 0o600, flag: 'wx' });
    if (encoded !== original) writer.verifyCredentialWrite(file, fs.readFileSync(temp), original);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
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
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('凭据必须是普通文件');
    return vault.decodeCredentialFile(file, fs.readFileSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readJsonFile<T>(file: string): T | null {
  const data = readBuffer(file);
  if (!data) return null;
  try { return JSON.parse(data.toString()) as T; } catch { return null; }
}

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
