import * as mac from './antigravity-mac';
import { readWindowsCredential, replaceWindowsCredential } from './antigravity-windows';

export const KEYRING_PREFIX = 'go-keyring-base64:';
export interface KeychainEntry { raw: string | null; nativeReadable?: boolean; sharedRevision?: string }

export function readKeychain(): KeychainEntry {
  if (process.platform !== 'win32') return mac.readMacKeychain();
  const { data, revision } = readWindowsCredential();
  return { raw: data === null ? null : KEYRING_PREFIX + data, sharedRevision: revision };
}

export function sharedKeychainRevision(): string | undefined {
  return process.platform === 'win32' ? readWindowsCredential().revision : mac.sharedMacRevision();
}

export function canWriteOfficialItem(raw: string): boolean {
  if (process.platform !== 'win32') return mac.fitsMacKeychain(raw);
  return raw.startsWith(KEYRING_PREFIX) && Buffer.from(raw.slice(KEYRING_PREFIX.length), 'base64').length <= 2560;
}

export function keychainWriteIssue(encoded: string | null, previous: KeychainEntry): string | undefined {
  if (process.platform !== 'win32') return mac.macKeychainWriteIssue(encoded, previous);
  if (previous.raw !== encoded && encoded !== null && !canWriteOfficialItem(encoded)) {
    return '完整凭据超过 Windows 凭据管理器单项的大小限制';
  }
}

export function replaceKeychain(encoded: string | null, previous: KeychainEntry): void {
  const issue = keychainWriteIssue(encoded, previous);
  if (issue) throw new Error(process.platform === 'win32'
    ? `${issue}，切换时可确认使用受保护的登录文件` : `${issue}。请在 Antigravity 官方客户端切换或重新登录`);
  if (encoded === previous.raw) return;
  if (process.platform !== 'win32') return mac.writeMacKeychain(encoded);
  replaceWindowsCredential({
    data: previous.raw === null ? null : previous.raw.slice(KEYRING_PREFIX.length), revision: previous.sharedRevision,
  }, encoded === null ? null : Buffer.from(encoded.slice(KEYRING_PREFIX.length), 'base64'));
}

// Mac deletion is bound to a persistent reference. Windows' compare-and-replace uses the original revision.
export function prepareRetirement(): string {
  return process.platform === 'win32' ? '' : mac.prepareMacRetirement();
}

export function retireKeychain(previous: KeychainEntry, revision: string): void {
  if (process.platform === 'win32') replaceKeychain(null, previous);
  else mac.retireMacKeychain(previous, revision);
}
