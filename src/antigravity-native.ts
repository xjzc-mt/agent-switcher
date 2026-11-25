import { agentMetadata } from './agents/metadata';
import { hasUnsafeParent } from './private-files';
import fs from 'fs';
import { isolatedCliPids } from './antigravity-cli';
import { runningClients } from './clients';
import os from 'os';
import path from 'path';
import { KEYRING_PREFIX, type KeychainEntry, canWriteOfficialItem, keychainWriteIssue, prepareRetirement, readKeychain,
  replaceKeychain, retireKeychain, sharedKeychainRevision } from './antigravity-keyring';
import { canReadNormalQuotaLogin, keychainAccessBlocked, keychainAccessError, keychainWriteBlocked, readMacKeychainAsync } from './antigravity-mac';
import { sharedCliSessions } from './temporary-credentials';
import { windowsAntigravitySessions } from './windows-processes';
import { fingerprint, jwtInfo } from './utils';
import { privateWindowsFile, writePrivateWindowsFile } from './antigravity-windows';
import { beginSwitchRecovery, finishSwitchRecovery, hasPendingAntigravitySwitch, keepRecoveryForReview, recoverPendingSwitch, type RecoveryFile } from './antigravity-switch-recovery';
import { credentialStateFromFiles, CredentialChangedError } from './credential-state';
import type { StatusResult, LiveMutationJournal } from './agents/base';

export { retryNativeKeychainAccess } from './antigravity-mac';
const CLI_TOKEN_FILE = 'antigravity-cli/antigravity-oauth-token';
const DESKTOP_MARKER_FILE = 'cache/antigravity-keyring-unavailable';
const CLI_MARKER_FILE = 'antigravity-cli/cache/antigravity-keyring-unavailable';
const MARKER_TTL_MS = 3600_000;
export const NATIVE_TOKEN_FILE = agentMetadata.agy.credential;
export interface NativeToken {
  auth_method: string;
  id_token?: string;
  id_token_email?: string;
  expiry?: string;
  token: { access_token?: string; refresh_token: string; expiry?: string };
}
interface ConsumerEntry { bytes: Buffer; token: NativeToken; id: string; expiry?: number; bearerRank: number }
export class ConflictingNativeFileLogins extends Error {}
type FallbackEntry =
  | { kind: 'absent'; path: string }
  | { kind: 'stub'; path: string; bytes: Buffer }
  | ({ kind: 'consumer'; path: string } & ConsumerEntry)
  | { kind: 'blocked'; path: string; reason: string };
type KeychainState =
  | { kind: 'absent' }
  | { kind: 'consumer'; consumer: ConsumerEntry }
  | { kind: 'corrupt'; error: Error }
  | { kind: 'protected'; error: Error };
interface FileSnapshot extends RecoveryFile {
  exists: boolean;
  dev?: bigint;
  ino?: bigint;
  mtimeNs?: bigint;
  activeMarker?: boolean;
}

function recoverableError(message: string): Error {
  return Object.assign(new Error(message), { recoverableNativeCorruption: true });
}

export function isRecoverableNativeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as { recoverableNativeCorruption?: boolean }).recoverableNativeCorruption === true ||
    error.message === 'Antigravity 凭据格式无效';
}

export function tokenEmail(token: NativeToken): string | undefined {
  const direct = typeof token.id_token_email === 'string' ? token.id_token_email.trim() : '';
  const fromJwt = jwtInfo(token.id_token).email?.trim() || '';
  return direct || fromJwt || undefined;
}

export function parseNativeToken(bytes: Buffer): NativeToken {
  let value: NativeToken;
  try { value = JSON.parse(bytes.toString()); } catch { throw recoverableError('Antigravity 凭据格式无效'); }
  const refreshToken = value?.token?.refresh_token;
  if (value?.auth_method !== 'consumer' || typeof refreshToken !== 'string' || !refreshToken.trim() || !tokenEmail(value)) {
    throw new Error('仅支持包含身份和续期凭据的个人 Google 账号');
  }
  return value;
}

function toConsumer(bytes: Buffer): ConsumerEntry {
  const token = parseNativeToken(bytes);
  const date = token.token.expiry ?? token.expiry;
  const expiry = typeof date === 'string' ? Date.parse(date) : NaN;
  const bearer = findQuotaBearer(token);
  return { bytes, token, id: tokenEmail(token)!.toLowerCase(), expiry: Number.isFinite(expiry) ? expiry : undefined,
    bearerRank: bearer?.expiry ? 2 : bearer ? 1 : 0 };
}

/** Return a usable bearer, borrowing only from the same grant. */
export function findQuotaBearer(primary: NativeToken, copies: Buffer[] = [], allowUndated = true) {
  function bearer(auth: NativeToken, fromCopy: boolean) {
    const access = auth.token.access_token, date = auth.token.expiry ?? auth.expiry;
    if (typeof access !== 'string' || !access.trim()) return;
    if (date === undefined && allowUndated) return { accessToken: access.trim(), expiry: undefined, fromCopy };
    const expiresAt = typeof date === 'string' ? Date.parse(date) : NaN;
    if (expiresAt > Date.now()) {
      return { accessToken: access.trim(), expiry: new Date(expiresAt).toISOString(), fromCopy };
    }
  }
  let selected = bearer(primary, false);
  if (selected?.expiry || !copies.length) return selected;
  const email = tokenEmail(primary)!.toLowerCase();
  for (const bytes of copies) {
    let copy: NativeToken;
    try { copy = parseNativeToken(bytes); } catch { continue; }
    if (copy.token.refresh_token !== primary.token.refresh_token || tokenEmail(copy)!.toLowerCase() !== email) continue;
    const candidate = bearer(copy, true);
    if (candidate?.expiry) return candidate;
    selected ??= candidate;
  }
  return selected;
}

function sameSession(a: ConsumerEntry, b: ConsumerEntry): boolean {
  return a.id === b.id && a.token.token.refresh_token === b.token.token.refresh_token;
}

function compareCopies(a: ConsumerEntry, b: ConsumerEntry): number {
  if (a.bearerRank !== b.bearerRank) return a.bearerRank - b.bearerRank;
  return a.expiry !== undefined && b.expiry !== undefined ? a.expiry - b.expiry : 0;
}

export function compareNativeSessionCopies(left: Buffer | null, right: Buffer | null): number | undefined {
  if (!left || !right) return;
  try {
    const a = toConsumer(left), b = toConsumer(right);
    if (sameSession(a, b)) return compareCopies(a, b);
  } catch { /* Legacy or unsupported credentials retain their normal version checks. */ }
}

function latestSessionCopy(primary: ConsumerEntry, candidates: Array<ConsumerEntry | undefined>): ConsumerEntry {
  let best = primary;
  for (const candidate of candidates) {
    if (candidate && sameSession(candidate, best) && compareCopies(candidate, best) > 0) best = candidate;
  }
  return best;
}

function supportedNativePlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

function nativePaths() {
  const gemini = path.join(os.homedir(), '.gemini');
  return {
    gemini,
    desktop: path.join(gemini, NATIVE_TOKEN_FILE),
    cli: path.join(gemini, CLI_TOKEN_FILE),
    desktopMarker: path.join(gemini, DESKTOP_MARKER_FILE),
    cliMarker: path.join(gemini, CLI_MARKER_FILE),
  };
}

function hasUnsafeGeminiAncestor(file: string, requireOwner = false): boolean {
  try { return hasUnsafeParent(file, path.resolve(nativePaths().gemini), requireOwner); }
  catch { return true; }
}

function inspectMarker(file: string): { exists: boolean; active: boolean; blocked?: string } {
  if (hasUnsafeGeminiAncestor(file)) return { exists: true, active: false, blocked: `Antigravity 认证目录不能是符号链接（${file}）` };
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return { exists: true, active: false, blocked: `Antigravity 认证标记不是普通文件（${file}）` };
    return { exists: true, active: Date.now() - stat.mtimeMs < MARKER_TTL_MS };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, active: false };
    return { exists: true, active: false, blocked: `无法读取 Antigravity 认证标记（${file}）` };
  }
}

function classifyFallback(file: string): FallbackEntry {
  if (hasUnsafeGeminiAncestor(file)) return { kind: 'blocked', path: file, reason: 'Antigravity 认证目录不能是符号链接' };
  let bytes: Buffer;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'blocked', path: file, reason: 'Antigravity 认证文件不是普通文件' };
    bytes = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent', path: file };
    return { kind: 'blocked', path: file, reason: '无法读取 Antigravity 认证文件' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString()); } catch { return { kind: 'blocked', path: file, reason: 'Antigravity 凭据格式无效' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'blocked', path: file, reason: 'Antigravity 凭据格式无效' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.auth_method !== undefined && record.auth_method !== '' && record.auth_method !== 'consumer') {
    return { kind: 'blocked', path: file, reason: '检测到非个人 Google 账号认证文件' };
  }
  const nested = record.token && typeof record.token === 'object' && !Array.isArray(record.token)
    ? record.token as Record<string, unknown> : undefined;
  const hasToken = Boolean(nested?.refresh_token || nested?.access_token || record.refresh_token || record.access_token);
  if (!hasToken) {
    if (record.auth_method === undefined && Object.keys(record).some(k => k !== 'token')) {
      return { kind: 'blocked', path: file, reason: '尚未支持此版本的 Antigravity 认证文件格式' };
    }
    return { kind: 'stub', path: file, bytes };
  }
  try { return { kind: 'consumer', path: file, ...toConsumer(bytes) }; }
  catch (error) { return { kind: 'blocked', path: file, reason: (error as Error).message }; }
}

function decodeKeychain(encoded: string | null): KeychainState {
  if (encoded === null) return { kind: 'absent' };
  if (encoded === '') return { kind: 'corrupt', error: recoverableError('Antigravity 凭据格式无效') };
  if (!encoded.startsWith(KEYRING_PREFIX)) return { kind: 'protected', error: new Error('尚未支持此版本的 Antigravity Keychain 格式') };
  const rawBytes = Buffer.from(encoded.slice(KEYRING_PREFIX.length), 'base64');
  let parsed: unknown;
  try { parsed = JSON.parse(rawBytes.toString()); }
  catch { return { kind: 'corrupt', error: recoverableError('Antigravity 凭据格式无效') }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', error: recoverableError('Antigravity 凭据格式无效') };
  }
  const record = parsed as Record<string, unknown>;
  if (record.auth_method !== 'consumer') {
    if (record.auth_method !== undefined && record.auth_method !== '') {
      return { kind: 'protected', error: new Error('检测到非个人 Google 账号的 Keychain 登录，暂不覆盖') };
    }
    if (Object.keys(record).length > 0) {
      return { kind: 'protected', error: new Error('尚未支持此版本的 Antigravity Keychain 格式') };
    }
    return { kind: 'corrupt', error: recoverableError('Antigravity 凭据格式无效') };
  }
  try { return { kind: 'consumer', consumer: toConsumer(rawBytes) }; }
  catch (error) { return { kind: 'corrupt', error: recoverableError((error as Error).message) }; }
}

function resolvePrimary(
  keychain: KeychainState,
  desktop: FallbackEntry,
  cli: FallbackEntry,
  desktopMarkerActive: boolean,
): ConsumerEntry | null {
  if (keychain.kind === 'protected' || keychain.kind === 'corrupt') throw keychain.error;
  const kc = keychain.kind === 'consumer' ? keychain.consumer : undefined;
  const desktopConsumer = desktop.kind === 'consumer' ? desktop : undefined;
  const cliConsumer = cli.kind === 'consumer' ? cli : undefined;
  const preferred = desktopMarkerActive && desktopConsumer ? desktopConsumer : kc;
  if (preferred) return latestSessionCopy(preferred, [kc, desktopConsumer, cliConsumer]);
  if (desktopConsumer && cliConsumer) {
    if (desktopConsumer.id !== cliConsumer.id) throw new ConflictingNativeFileLogins('检测到桌面端与 CLI 认证文件分别为不同账号，请先导入备份或在官方客户端统一登录');
    if (!sameSession(desktopConsumer, cliConsumer)) throw new ConflictingNativeFileLogins('检测到同一账号的不同续期凭据，无法确认新旧，已保留原凭据');
    return compareCopies(cliConsumer, desktopConsumer) > 0 ? cliConsumer : desktopConsumer;
  }
  if (desktopConsumer) return desktopConsumer;
  if (cliConsumer) return cliConsumer;
  const blocked = [desktop, cli].find((entry): entry is Extract<FallbackEntry, { kind: 'blocked' }> => entry.kind === 'blocked');
  if (blocked) throw new Error(`${blocked.reason}（${blocked.path}）`);
  return null;
}

const sharedObservations = new WeakMap<Buffer, { canonical: ConsumerEntry; revision: string }>();
const observedFileLogins = new WeakSet<Buffer>();

let readSnapshot: { entry?: KeychainEntry; failed?: boolean } | undefined;
/** Only synchronous observations share a read. Revalidation after locks/awaits and all writes read afresh. */
export function withNativeReadSnapshot<T>(observe: () => T): T {
  const previous = readSnapshot;
  readSnapshot ??= {};
  try { return observe(); } finally { readSnapshot = previous; }
}
export async function withDashboardNativeSnapshot<T>(usesNativeLogin: boolean, buildDashboard: () => T): Promise<T> {
  if (!usesNativeLogin || process.platform !== 'darwin' || !usingRealRead() || hasPendingAntigravitySwitch()) return buildDashboard();
  let snapshot: NonNullable<typeof readSnapshot>;
  try { snapshot = { entry: await readMacKeychainAsync() }; }
  catch { snapshot = { failed: true }; }
  const previous = readSnapshot;
  readSnapshot = snapshot;
  try { return buildDashboard(); } finally { readSnapshot = previous; }
}

function readKeychainEntry(observeShared = false): KeychainEntry {
  if (readSnapshot?.failed) throw new Error(keychainAccessError);
  if (observeShared || !readSnapshot) return readKeychain();
  return readSnapshot.entry ??= readKeychain();
}

function readRawKeychain(): string | null { return readKeychainEntry().raw; }

export function readNativeToken(quotaCopies?: Buffer[]): Buffer | null {
  if (!supportedNativePlatform()) throw new Error('当前系统尚不支持 Antigravity 原生登录');
  const paths = nativePaths();
  const desktopMarker = inspectMarker(paths.desktopMarker);
  const entry = readKeychainEntry(quotaCopies !== undefined);
  const keychain = decodeKeychain(entry.raw);
  const desktop = classifyFallback(paths.desktop), cli = classifyFallback(paths.cli);
  const primary = resolvePrimary(keychain, desktop, cli, desktopMarker.active);
  if (primary && quotaCopies) {
    if (keychain.kind === 'absent' && cli.kind === 'consumer' && sameSession(primary, cli)) {
      observedFileLogins.add(primary.bytes);
    }
    if (entry.sharedRevision && keychain.kind === 'consumer' && sameSession(primary, keychain.consumer)) {
      sharedObservations.set(primary.bytes, { canonical: keychain.consumer, revision: entry.sharedRevision });
    }
    for (const entry of [keychain.kind === 'consumer' && keychain.consumer, desktop, cli]) {
      if (entry && 'id' in entry && entry !== primary && sameSession(entry, primary)) quotaCopies.push(entry.bytes);
    }
  }
  return primary?.bytes ?? null;
}

function privateLoginFile(file: string): boolean {
  if (process.platform === 'win32') return privateWindowsFile(file);
  if (hasUnsafeGeminiAncestor(file, true)) return false;
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return !!stat && stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o600;
}

/** Bind a shared CLI renewal to the current official login observed for this quota snapshot. */
export function readSharedQuotaLogin(expected: Buffer): Buffer | undefined {
  const seen = sharedObservations.get(expected);
  if (keychainAccessBlocked || (!seen && !observedFileLogins.has(expected))) return;
  try {
    const paths = nativePaths();
    if ([paths.desktopMarker, paths.cliMarker].map(inspectMarker).some(m => m.active || m.blocked)) return;
    if (!seen) {
      if (readKeychainEntry(true).raw !== null) return;
      const cli = classifyFallback(paths.cli), desktop = classifyFallback(paths.desktop);
      if (cli.kind !== 'consumer' || !sameSession(cli, toConsumer(expected)) || !privateLoginFile(paths.cli)) return;
      if ((process.platform === 'darwin' && desktop.kind !== 'consumer') || desktop.kind === 'blocked' ||
          (desktop.kind === 'consumer' && (!sameSession(cli, desktop) || !privateLoginFile(paths.desktop)))) return;
      return cli.bytes;
    }
    for (const file of [paths.desktop, paths.cli]) {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1 || (process.platform === 'win32'
        ? !privateWindowsFile(file) : stat.uid !== process.getuid!() || (stat.mode & 0o022)))) return;
      const copy = classifyFallback(file);
      if (copy.kind === 'blocked' || (copy.kind === 'consumer' && !sameSession(copy, seen.canonical))) return;
    }
    if (sameSession(toConsumer(expected), seen.canonical) && sharedKeychainRevision() === seen.revision) return seen.canonical.bytes;
  } catch { /* A source disappeared or became unreadable; leave this lookup in read-only mode. */ }
}

const usingRealRead = () => (exports as { readNativeToken?: unknown }).readNativeToken === readNativeToken;
const usingRealWrite = () => (exports as { writeNativeToken?: unknown }).writeNativeToken === writeNativeToken;

/** An active desktop fallback can identify its own read-only quota request while Keychain is unavailable. */
export function readActiveDesktopQuotaFile(quotaCopies?: Buffer[]): Buffer | undefined {
  if (process.platform !== 'darwin' || !usingRealRead()) return;
  const { desktop, desktopMarker, cli } = nativePaths();
  const trusted = (stat: fs.Stats) => stat.isFile() && stat.nlink === 1 &&
    stat.uid === process.getuid!() && (stat.mode & 0o022) === 0;
  const unchanged = (before: fs.Stats, after: fs.Stats) => trusted(after) &&
    before.dev === after.dev && before.ino === after.ino && before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs;
  function readFile(file: string) {
    let fd: number | undefined;
    try {
      if (hasUnsafeGeminiAncestor(file, true)) return;
      const stat = fs.lstatSync(file);
      if (!trusted(stat)) return;
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!unchanged(stat, fs.fstatSync(fd))) return;
      const entry = toConsumer(fs.readFileSync(fd));
      if (!hasUnsafeGeminiAncestor(file, true) && unchanged(stat, fs.lstatSync(file))) return { stat, entry };
    } catch { return; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  try {
    if (hasUnsafeGeminiAncestor(desktopMarker, true)) return;
    const marker = fs.lstatSync(desktopMarker);
    if (!trusted(marker) || Date.now() - marker.mtimeMs >= MARKER_TTL_MS) return;
    const primary = readFile(desktop);
    if (!primary) return;
    const copy = quotaCopies && readFile(cli);
    if (hasUnsafeGeminiAncestor(desktopMarker, true) || !unchanged(primary.stat, fs.lstatSync(desktop)) ||
        !unchanged(marker, fs.lstatSync(desktopMarker)) || Date.now() - marker.mtimeMs >= MARKER_TTL_MS) return;
    if (quotaCopies && copy && sameSession(primary.entry, copy.entry)) quotaCopies.push(copy.entry.bytes);
    return primary.entry.bytes;
  } catch { return; }
}

/** Recheck the marker after probing so an expired marker cannot select a stale desktop file. */
export function readUnavailableDesktopQuotaFile(): Buffer | undefined {
  if (hasPendingAntigravitySwitch()) throw new Error('上次 Antigravity 切换中断，请从账号列表重新切换以核对并恢复登录');
  if (readSnapshot?.entry) return;
  if (readSnapshot?.failed) return readActiveDesktopQuotaFile();
  if (readActiveDesktopQuotaFile() && !canReadNormalQuotaLogin()) return readActiveDesktopQuotaFile();
}

export function readAuxiliaryNativeTokens(primaryBytes?: Buffer | null, requireAllReadable = false): Buffer[] {
  if (!supportedNativePlatform()) return [];
  const paths = nativePaths();
  let primary: ConsumerEntry | null = null;
  if (primaryBytes) {
    try { primary = toConsumer(primaryBytes); } catch {}
  }
  const kept: ConsumerEntry[] = [];
  const add = (entry?: ConsumerEntry) => {
    if (!entry) return;
    if (primary && sameSession(entry, primary) && compareCopies(entry, primary) <= 0) return;
    for (let i = 0; i < kept.length; i++) {
      if (!sameSession(kept[i], entry)) continue;
      if (compareCopies(entry, kept[i]) > 0) kept[i] = entry;
      return;
    }
    kept.push(entry);
  };
  if (usingRealRead()) {
    const kc = decodeKeychain(readRawKeychain());
    if (kc.kind === 'protected' || (requireAllReadable && kc.kind === 'corrupt')) throw kc.error;
    if (kc.kind === 'consumer') add(kc.consumer);
  }
  for (const file of [paths.desktop, paths.cli]) {
    const entry = classifyFallback(file);
    if (requireAllReadable && entry.kind === 'blocked') throw new Error(entry.reason);
    if (entry.kind === 'consumer') add(entry);
  }
  return kept.map(entry => entry.bytes);
}

export function hasPendingNativeCleanup(): boolean {
  if (!supportedNativePlatform() || !usingRealRead()) return false;
  const paths = nativePaths();
  if ([paths.desktopMarker, paths.cliMarker].some(file => inspectMarker(file).exists)) return true;
  const desktop = classifyFallback(paths.desktop), cli = classifyFallback(paths.cli);
  const keychain = readKeychainEntry();
  if (keychain.raw === null && desktop.kind === 'consumer' && cli.kind === 'consumer' &&
      sameSession(desktop, cli) && privateLoginFile(desktop.path) && privateLoginFile(cli.path)) return false;
  return desktop.kind !== 'absent' || cli.kind !== 'absent' || keychain.nativeReadable === true;
}

export function nativeSwitchFingerprint(): string | undefined {
  if (!supportedNativePlatform() || !usingRealRead()) return undefined;
  return fingerprintNativeSources(readRawKeychain());
}

function fingerprintNativeSources(raw: string | null): string {
  const paths = nativePaths();
  const tokenParts = [paths.desktop, paths.cli].map(file => {
    if (hasUnsafeGeminiAncestor(file)) return `unsafe:${file}`;
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() ? `${file}:${fingerprint(fs.readFileSync(file).toString('base64'))}` : `special:${file}`;
    } catch { return `absent:${file}`; }
  });
  const markerParts = [paths.desktopMarker, paths.cliMarker].map(file => {
    const marker = inspectMarker(file);
    return `${file}:exists=${marker.exists}:active=${marker.active}:blocked=${marker.blocked || ''}`;
  });
  return fingerprint(JSON.stringify([raw ?? 'null', ...tokenParts, ...markerParts]));
}

function fallbackLogoutConflict(
  desktop: FallbackEntry,
  cli: FallbackEntry,
  desktopMarkerPath: string,
  cliMarkerPath: string,
  primary: ConsumerEntry | null,
  rawKeychain?: string | null,
): string | undefined {
  for (const marker of [inspectMarker(desktopMarkerPath), inspectMarker(cliMarkerPath)]) {
    if (marker.blocked) return marker.blocked;
  }
  for (const entry of [desktop, cli]) {
    if (entry.kind === 'blocked') return `${entry.reason}（${entry.path}）`;
    if (entry.kind === 'consumer') {
      if (!primary || entry.id !== primary.id) return `检测到认证回退文件包含其他账号（${entry.path}）`;
      if (!sameSession(entry, primary)) {
        return `检测到认证回退文件存在无法确认新旧的同账号凭据（${entry.path}）`;
      }
    }
  }
  if (desktop.kind === 'consumer' && inspectMarker(desktopMarkerPath).active) {
    const keychain = decodeKeychain(rawKeychain !== undefined ? rawKeychain : readRawKeychain());
    if (keychain.kind === 'protected' || keychain.kind === 'corrupt') return keychain.error.message;
    if (keychain.kind === 'consumer') {
      if (!primary || keychain.consumer.id !== primary.id) return '检测到 Keychain 与桌面回退文件分别为不同账号';
      if (!sameSession(keychain.consumer, primary)) {
        return '检测到 Keychain 与桌面回退文件存在无法确认新旧的同账号凭据';
      }
    }
  }
  return undefined;
}

export function nativeLogoutSupport(primaryBytes?: Buffer | null): string | undefined {
  if (!supportedNativePlatform()) return '此系统的客户端退出尚未验证，请在官方客户端退出';
  const paths = nativePaths();
  let primary: ConsumerEntry | null = null;
  if (primaryBytes) {
    try { primary = toConsumer(primaryBytes); } catch {}
  }
  const previous = usingRealRead() ? readKeychainEntry() : undefined;
  const conflict = fallbackLogoutConflict(
    classifyFallback(paths.desktop), classifyFallback(paths.cli),
    paths.desktopMarker, paths.cliMarker, primary, previous?.raw,
  ) || (previous && keychainWriteIssue(null, previous));
  return conflict ? `${conflict}，请在官方客户端退出` : undefined;
}

function usesOfficialFallbacks(encoded: string | null, previous: KeychainEntry, fallbacks: FallbackEntry[]): boolean {
  return encoded !== null && !canWriteOfficialItem(encoded) && previous.raw === null &&
    fallbacks.some(entry => entry.kind === 'consumer');
}

// Existing file-only sessions can continue using their official storage without a migration.
function switchStorage(encoded: string, previous: KeychainEntry, fallbacks: FallbackEntry[]): 'keychain' | 'existing-files' | 'migrate' {
  if (!keychainWriteIssue(encoded, previous)) return 'keychain';
  if (usesOfficialFallbacks(encoded, previous, fallbacks)) return 'existing-files';
  // Callers already exclude protected formats. Recovery preserves even an unreadable
  // JSON payload in its original encoding until both official files are committed.
  return 'migrate';
}

function assertSwitchSources(fallbacks: FallbackEntry[], markers: ReturnType<typeof inspectMarker>[]): void {
  for (const marker of markers) {
    if (marker.blocked) throw new Error(`${marker.blocked}，已保留原凭据，请先手动处理`);
  }
  for (const entry of fallbacks) {
    if (entry.kind === 'blocked') throw new Error(`${entry.reason}（${entry.path}），已保留原凭据，请先手动处理`);
  }
}

/** The GUI checks feasibility before it asks the user to close a running official client. */
export function assertNativeSwitchReady(bytes: Buffer | null): 'files' | undefined {
  if (!usingRealRead()) return;
  if (!bytes) throw new Error('未找到目标 Antigravity 凭据');
  const encoded = KEYRING_PREFIX + toConsumer(bytes).bytes.toString('base64');
  const previous = readKeychainEntry();
  const keychain = decodeKeychain(previous.raw);
  if (keychain.kind === 'protected') throw keychain.error;
  const paths = nativePaths();
  const fallbacks = [classifyFallback(paths.desktop), classifyFallback(paths.cli)];
  assertSwitchSources(fallbacks, [inspectMarker(paths.desktopMarker), inspectMarker(paths.cliMarker)]);
  return switchStorage(encoded, previous, fallbacks) === 'migrate' ? 'files' : undefined;
}

/** Only an existing macOS Keychain login can cross into the dual-file format on renewal. */
export function needsNativeRenewalMigration(bytes: Buffer): boolean {
  return process.platform === 'darwin' && usingRealWrite() &&
    !canWriteOfficialItem(KEYRING_PREFIX + bytes.toString('base64')) && readRawKeychain() !== null;
}

function writeRawKeychain(encoded: string | null, previous = readKeychainEntry()): void {
  replaceKeychain(encoded, previous);
}

function captureSingleFile(file: string): FileSnapshot {
  if (hasUnsafeGeminiAncestor(file)) return { path: file, exists: true, bytes: null, unsafe: true };
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) return { path: file, exists: true, bytes: null, unsafe: true };
    const mode = process.platform === 'win32' ? (privateWindowsFile(file) ? 0o600 : 0o666) : Number(stat.mode & 0o777n);
    const mtimeMs = Number(stat.mtimeNs) / 1e6;
    return { path: file, exists: true, bytes: fs.readFileSync(file), mode, dev: stat.dev, ino: stat.ino,
      mtimeNs: stat.mtimeNs, mtimeMs, atimeMs: Number(stat.atimeNs) / 1e6,
      activeMarker: path.basename(file) === 'antigravity-keyring-unavailable' ? Date.now() - mtimeMs < MARKER_TTL_MS : undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, exists: false, bytes: null };
    return { path: file, exists: true, bytes: null, unsafe: true };
  }
}

interface KeychainMutation {
  before: string | null;
  target: string | null;
}
interface FileMutation {
  path: string;
  before: FileSnapshot;
  afterExists: boolean;
  afterBytes: Buffer | null;
  afterStat?: fs.BigIntStats;
}
class NativeMutationJournal implements LiveMutationJournal {
  keychainOp?: KeychainMutation;
  readonly fileOps: FileMutation[] = [];
  declare commitPrepared?: () => void;
  recoveryRecorded = false;
  hadKeychainBeforeMigration = false;
  retainPrepared = false;
  externalChange = false;
  externalLogout = false;

  markExternalLogout(): void {
    this.externalChange = true;
    this.externalLogout = true;
  }

  finish(): void {
    if (this.recoveryRecorded) finishSwitchRecovery();
    this.recoveryRecorded = false;
  }

  hasMutations(): boolean {
    return Boolean(this.keychainOp || this.fileOps.length > 0 || this.recoveryRecorded);
  }

  restore(): void {
    if (!this.hasMutations()) return;
    if (this.retainPrepared) throw new Error('钥匙串提交结果待确认，已保留两端目标文件与加密恢复记录');
    // A file or metadata error can abort preparation before the retirement check runs.
    if (this.hadKeychainBeforeMigration && !this.externalLogout && this.fileOps.some(op => op.before.bytes !== null)) {
      if (readRawKeychain() === null) this.markExternalLogout();
    }
    const failures: string[] = [];
    const preserved: string[] = [];

    for (const op of [...this.fileOps].reverse()) {
      const current = captureSingleFile(op.path);
      if (op.before.unsafe || current.unsafe || (op.afterExists
        ? !op.afterBytes || !current.bytes?.equals(op.afterBytes) || current.mode !== 0o600 ||
          current.dev !== op.afterStat?.dev || current.ino !== op.afterStat?.ino || current.mtimeNs !== op.afterStat?.mtimeNs
        : current.exists)) {
        preserved.push(`已保留外部变更的 ${op.path}`);
        this.externalChange = true;
        continue;
      }
      try {
        // A file restored into an empty Keychain login would sign the official client in again.
        const restore = this.externalLogout ? { path: op.path, bytes: null } : op.before;
        restoreFallback(restore, current);
        preserved.push(restore.bytes !== null ? `已恢复 ${op.path}` : `已清理临时写入的 ${op.path}`);
      } catch {
        failures.push(`未能恢复 ${op.path}`);
      }
    }

    if (this.keychainOp) {
      const op = this.keychainOp;
      try {
        const actualRaw = readRawKeychain();
        if (actualRaw !== op.target) {
          preserved.push(actualRaw === null ? '已保留外部退出的 Keychain 状态' : '已保留 Keychain 当前凭据');
        } else if (actualRaw !== op.before) {
          writeRawKeychain(op.before);
          if (readRawKeychain() !== op.before) failures.push('Keychain 未能恢复原值');
          else preserved.push('已恢复 Keychain 原凭据');
        }
      } catch {
        failures.push('Keychain 原状态恢复失败');
        try {
          const left = readRawKeychain();
          preserved.push(left === null ? 'Keychain 当前为未登录状态' : 'Keychain 当前保留未回退凭据');
        } catch {
          preserved.push('Keychain 当前状态待手动核对');
        }
      }
    }

    if (failures.length) {
      const detail = preserved.length ? `（${preserved.join('；')}）` : '';
      throw new Error(`${failures.join('；')}${detail}`);
    }
    if (this.externalChange && this.recoveryRecorded) keepRecoveryForReview();
    this.finish();
  }
}

export function createNativeMutationJournal(): LiveMutationJournal | undefined {
  if (!supportedNativePlatform() || !usingRealRead() || !usingRealWrite()) return undefined;
  return new NativeMutationJournal();
}

function removeUnrecordedFile(file: string): void {
  if (hasUnsafeGeminiAncestor(file)) throw new Error(`Antigravity 认证目录不能是符号链接（${file}）`);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Antigravity 认证文件不是普通文件（${file}）`);
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertFileUnchanged(before: FileSnapshot): void {
  const current = captureSingleFile(before.path);
  if (before.unsafe || current.unsafe) throw new Error(`Antigravity 认证文件不是普通文件（${before.path}）`);
  if (before.exists !== current.exists || before.dev !== current.dev || before.ino !== current.ino || before.mtimeNs !== current.mtimeNs ||
      before.mode !== current.mode || before.activeMarker !== current.activeMarker ||
      (before.bytes && !before.bytes.equals(current.bytes ?? Buffer.alloc(0)))) {
    throw new Error(`切换期间认证文件已变化，已保留外部更改（${before.path}）`);
  }
}

function removeRecordedFile(before: FileSnapshot, journal: NativeMutationJournal): void {
  assertFileUnchanged(before);
  const file = before.path;
  if (!before.exists) return;
  fs.unlinkSync(file);
  journal.fileOps.push({ path: file, before, afterExists: false, afterBytes: null });
}

function replaceFallback(before: FileSnapshot, bytes: Buffer, restore?: RecoveryFile): fs.BigIntStats {
  const file = before.path;
  assertFileUnchanged(before);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (process.platform === 'win32') writePrivateWindowsFile(temp, bytes);
    else {
      fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
      if (restore?.mode !== undefined) fs.chmodSync(temp, restore.mode);
    }
    if (restore?.mtimeMs !== undefined && restore.atimeMs !== undefined) {
      fs.utimesSync(temp, restore.atimeMs / 1000, restore.mtimeMs / 1000);
    }
    const installed = fs.statSync(temp, { bigint: true });
    assertFileUnchanged(before);
    fs.renameSync(temp, file);
    return installed;
  } finally { fs.rmSync(temp, { force: true }); }
}

function writeRecordedFallback(before: FileSnapshot, bytes: Buffer, journal: NativeMutationJournal): void {
  const afterStat = replaceFallback(before, bytes);
  journal.fileOps.push({ path: before.path, before, afterExists: true, afterBytes: bytes, afterStat });
}

function restoreFallback(before: RecoveryFile, current: RecoveryFile): void {
  const snapshot: FileSnapshot = { ...current, exists: current.bytes !== null };
  if (before.bytes !== null) replaceFallback(snapshot, before.bytes, before);
  else {
    assertFileUnchanged(snapshot);
    removeUnrecordedFile(before.path);
  }
}

export async function recoverInterruptedNativeSwitch(): Promise<void> {
  if (!hasPendingAntigravitySwitch()) return;
  if ((await runningClients('agy', { failClosed: true })).length) throw new Error('上次切换中断，请先退出 Antigravity 桌面端以恢复登录');
  if ((await sharedAntigravitySessions()).length) throw new Error('上次切换中断，请先关闭共用认证的 agy 或 IDE 会话以恢复登录');
  const paths = nativePaths();
  recoverPendingSwitch(readRawKeychain, [paths.desktop, paths.cli], captureSingleFile, restoreFallback);
}

function verifyPreparedFallbacks(files: FileSnapshot[], target: Buffer): FileSnapshot[] {
  return files.map(file => {
    const state = captureSingleFile(file.path);
    if (state.unsafe || state.mode !== 0o600 || !state.bytes?.equals(target)) {
      throw new Error(`Antigravity 目标凭据核对失败，已保留外部变更（${file.path}）`);
    }
    return state;
  });
}

function prepareFileSwitch(entry: KeychainEntry, target: Buffer, files: FileSnapshot[], markers: FileSnapshot[], journal: NativeMutationJournal): void {
  const previous = entry.raw;
  for (const before of [...files, ...markers]) assertFileUnchanged(before);
  if (readRawKeychain() !== previous) throw new Error('切换期间钥匙串已变化，已保留当前登录');
  beginSwitchRecovery(previous, target, files);
  journal.recoveryRecorded = true;
  journal.hadKeychainBeforeMigration = previous !== null;
  for (const before of files) {
    if (!before.bytes?.equals(target) || before.mode !== 0o600) writeRecordedFallback(before, target, journal);
  }
  const prepared = verifyPreparedFallbacks(files, target);
  journal.commitPrepared = () => {
    for (const source of [...prepared, ...markers]) assertFileUnchanged(source);
    let revision = '';
    if (previous !== null) {
      // Bracket the already-authorized reader with checks of the exact item and its modification date.
      try {
        revision = prepareRetirement();
      } catch (error) {
        if ((error as { status?: number }).status === 44) journal.markExternalLogout();
        throw new Error('无法唯一识别原钥匙串条目，已取消切换');
      }
    }
    const confirmed = readRawKeychain();
    if (confirmed !== previous) {
      journal.externalChange = true;
      if (confirmed === null) journal.markExternalLogout();
      throw new Error('切换期间钥匙串已变化，已保留当前登录');
    }
    if (previous === null) return;
    let refused = false;
    try {
      retireKeychain(entry, revision);
    } catch (error) {
      const status = (error as { status?: number }).status;
      refused = status === 44 || status === 77 || status === 78;
      // A timeout can follow a completed deletion. Check the observed backend in both cases.
    }
    let observed: string | null;
    try { observed = readRawKeychain(); }
    catch {
      journal.retainPrepared = true;
      throw new Error('未能确认旧钥匙串是否已移除，已保留双端目标凭据和加密恢复记录');
    }
    if (observed !== null) {
      journal.externalChange = observed !== previous;
      throw new Error(journal.externalChange ? '移除期间钥匙串已被其他客户端更改，已保留外部登录'
        : '未能移除旧钥匙串登录，系统拒绝或操作超时');
    }
    if (refused) {
      journal.markExternalLogout();
      throw new Error('切换期间原钥匙串登录已被移除，已保留外部更改');
    }
    try { verifyPreparedFallbacks(files, target); }
    catch {
      journal.retainPrepared = true;
      throw new Error('旧钥匙串已移除，桌面或 CLI 凭据随后变化，已保留现有文件和加密恢复记录');
    }
  };
}

export function writeNativeToken(
  bytes: Buffer | null,
  options: { clearFallbacks?: 'same' | 'all'; expectedFingerprint?: string; expectedRevision?: string; journal?: LiveMutationJournal; allowFileMigration?: boolean } = {},
): 'files' | undefined {
  readSnapshot = undefined; // Mutations and their read-backs never reuse an earlier observation.
  const target = bytes ? toConsumer(bytes) : null;
  if (!supportedNativePlatform()) throw new Error('当前系统尚不支持 Antigravity 原生登录');
  if (hasPendingAntigravitySwitch()) throw new Error('上次 Antigravity 切换尚待核对，请先从账号列表完成恢复再更新登录');
  if (keychainWriteBlocked) throw new Error('钥匙串写入被拒绝或超时，请解锁后手动重试保存或切换');
  const paths = nativePaths();
  const allPaths = [paths.desktop, paths.cli, paths.desktopMarker, paths.cliMarker];
  const confirmed = new Map(allPaths.map(file => [file, captureSingleFile(file)]));
  const previousEntry = readKeychainEntry();
  const previous = previousEntry.raw;
  const keychain = decodeKeychain(previous);
  if (keychain.kind === 'protected' && (bytes !== null || previous !== null)) throw keychain.error;

  const desktop = classifyFallback(paths.desktop);
  const cli = classifyFallback(paths.cli);
  const desktopMarker = inspectMarker(paths.desktopMarker);
  const cliMarker = inspectMarker(paths.cliMarker);
  const fallbacks = [desktop, cli];
  if (options.expectedFingerprint && fingerprintNativeSources(previous) !== options.expectedFingerprint) {
    throw new Error('确认期间当前凭据已变化，未执行切换，请重新核对');
  }
  const clearMode = options.clearFallbacks || 'same';

  if (!target) {
    const conflict = fallbackLogoutConflict(desktop, cli, paths.desktopMarker, paths.cliMarker,
      resolvePrimary(keychain, desktop, cli, desktopMarker.active), previous);
    if (conflict) throw new Error(`${conflict}，无法自动退出`);
  } else if (clearMode === 'all') {
    assertSwitchSources(fallbacks, [desktopMarker, cliMarker]);
  }

  const externalJournal = options.journal instanceof NativeMutationJournal ? options.journal : undefined;
  const journal = externalJournal || new NativeMutationJournal();
  const source = target && clearMode === 'same' && keychain.kind !== 'corrupt'
    ? resolvePrimary(keychain, desktop, cli, desktopMarker.active) : null;
  function belongsToRenewal(entry: ConsumerEntry): boolean {
    return !!source && !!target && source.id === target.id && sameSession(entry, source) && compareCopies(entry, source) <= 0;
  }
  const destinations = fallbacks.filter(entry => entry.kind === 'consumer' && belongsToRenewal(entry));
  const fileLogin = source && (keychain.kind === 'absent' ||
    (source.id === target?.id && keychain.kind === 'consumer' && !belongsToRenewal(keychain.consumer)));
  const filesToRemove = !target || clearMode === 'all' ? allPaths : [];
  if (target && clearMode === 'same' && !fileLogin) {
    for (const [entry, markerPath, marker] of [[desktop, paths.desktopMarker, desktopMarker], [cli, paths.cliMarker, cliMarker]] as const) {
      if (!marker.blocked && (destinations.includes(entry) || (entry.kind === 'stub' && !marker.active))) {
        filesToRemove.push(entry.path, markerPath);
      }
    }
  }
  const encodedTarget = target ? KEYRING_PREFIX + bytes!.toString('base64') : null;
  try {
    if (options.expectedRevision !== undefined) {
      if (!source || !target || source.id !== target.id ||
          credentialStateFromFiles('agy', [[NATIVE_TOKEN_FILE, source.bytes]]).revision !== options.expectedRevision) throw new CredentialChangedError();
    }
    const migrateRenewal = !!source && !!encodedTarget && options.allowFileMigration === true && previous !== null && !canWriteOfficialItem(encodedTarget);
    if (migrateRenewal) {
      assertSwitchSources(fallbacks, [desktopMarker, cliMarker]);
      if (keychain.kind !== 'consumer' || !belongsToRenewal(keychain.consumer) || fallbacks.some(entry => entry.kind === 'consumer' && !belongsToRenewal(entry))) {
        throw new Error('当前认证存储中包含其他登录，已保留现有凭据');
      }
    }
    if (target && encodedTarget && (clearMode === 'all' || migrateRenewal)) {
      const route = switchStorage(encodedTarget, previousEntry, fallbacks);
      if (route === 'migrate' && options.allowFileMigration !== true) {
        const permission = process.platform === 'win32' ? '当前 Windows 用户专用的' : '0600';
        throw new Error(`此凭据需要使用桌面和 CLI 各自的 ${permission} 登录文件，请确认文件存储后切换（CLI 使用 --allow-file-storage）`);
      }
      if (route !== 'keychain') {
        const files = fallbacks.map(entry => confirmed.get(entry.path)!);
        const markers = [paths.desktopMarker, paths.cliMarker].map(file => confirmed.get(file)!);
        prepareFileSwitch(previousEntry, target.bytes, files, markers, journal);
        if (!externalJournal) {
          journal.commitPrepared!();
          try { journal.finish(); } catch { /* The next explicit switch reconciles the recovery record. */ }
        }
        return 'files';
      }
    }
    // A background renewal can only update an existing file belonging to this login.
    if (target && fileLogin) {
      if (!destinations.length) throw new Error('无法确定当前 Antigravity 文件登录的归属，已保留原凭据');
      for (const entry of destinations) {
        const original = confirmed.get(entry.path)!;
        assertFileUnchanged(original);
        if (!original.bytes?.equals(target.bytes) || original.mode !== 0o600) writeRecordedFallback(original, target.bytes, journal);
      }
      if (readRawKeychain() !== previous) throw new Error('更新期间 Antigravity 钥匙串已变化，请重新核对');
      for (const marker of [paths.desktopMarker, paths.cliMarker]) {
        const snapshot = confirmed.get(marker)!;
        if (!snapshot.unsafe) assertFileUnchanged(snapshot);
      }
      verifyPreparedFallbacks(destinations.map(entry => confirmed.get(entry.path)!), target.bytes);
      return;
    }
    journal.keychainOp = { before: previous, target: encodedTarget };
    if (!target) {
      writeRawKeychain(null, previousEntry);
      if (readRawKeychain() !== null) throw new Error('无法还原 Antigravity 未登录状态');
    } else {
      writeRawKeychain(encodedTarget, previousEntry);
      const written = readRawKeychain();
      if (!written || !written.startsWith(KEYRING_PREFIX) ||
          !Buffer.from(written.slice(KEYRING_PREFIX.length), 'base64').equals(bytes!)) {
        throw new Error('Antigravity Keychain 写入未完成');
      }
    }
    for (const file of filesToRemove) removeRecordedFile(confirmed.get(file)!, journal);
  } catch (error) {
    if (!externalJournal) {
      try { journal.restore(); }
      catch (rollbackError) {
        throw new Error(`${(error as Error).message}；且恢复原登录状态未完成：${(rollbackError as Error).message}`);
      }
    }
    throw error;
  }
}

export async function sharedAntigravitySessions(): Promise<number[]> {
  if (process.platform === 'win32') return windowsAntigravitySessions(isolatedCliPids);
  const desktopApps = ['/Applications/Antigravity.app/', path.join(os.homedir(), 'Applications/Antigravity.app/')];
  return sharedCliSessions(isolatedCliPids, command => {
    if (desktopApps.some(prefix => command.startsWith(prefix))) return false;
    const base = path.basename(command);
    const isAntigravityLs = base === 'language_server' && /(?:^|[\\/._-])antigravity(?:[\\/._-]|$)/i.test(command);
    return base === 'agy' || isAntigravityLs;
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
