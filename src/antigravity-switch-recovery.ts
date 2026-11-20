import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { ANTIGRAVITY_SWITCH_FILE } from './credential-vault';
import { atomicWrite, readBuffer } from './utils';

export interface RecoveryFile {
  path: string;
  bytes: Buffer | null;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
  unsafe?: boolean;
}

interface SavedFile {
  data: string | null;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}
interface SwitchRecord {
  version: 1;
  keychain: string | null;
  target: string;
  before: SavedFile[];
}

function recordPath(): string { return path.join(os.homedir(), '.agent-switcher', ANTIGRAVITY_SWITCH_FILE); }
export function hasPendingAntigravitySwitch(): boolean { return fs.existsSync(recordPath()); }

/** Call under the account-pool write lock, before changing either official file. */
export function beginSwitchRecovery(keychain: string | null, target: Buffer, files: readonly RecoveryFile[]): void {
  if (hasPendingAntigravitySwitch()) throw new Error('仍有上次切换的恢复记录，请先核对并恢复');
  if (files.length !== 2 || files.some(file => file.unsafe)) throw new Error('无法保护原有的 Antigravity 文件登录');
  const before = files.map(({ bytes, mode, atimeMs, mtimeMs }) => ({
    data: bytes?.toString('base64') ?? null, mode, atimeMs, mtimeMs,
  }));
  const record: SwitchRecord = { version: 1, keychain, target: target.toString('base64'), before };
  atomicWrite(recordPath(), JSON.stringify(record));
}

export function finishSwitchRecovery(): void { fs.rmSync(recordPath(), { force: true }); }

export function keepRecoveryForReview(): never {
  const archived = path.join(path.dirname(recordPath()), `.antigravity-switch.retained-${randomUUID()}`);
  fs.renameSync(recordPath(), archived);
  throw new Error(`切换中断期间官方登录已变化，已保留现场和加密恢复副本 ${archived}，请重新核对后切换`);
}

/** The caller supplies the two official paths, in desktop/CLI order, never paths from the record. */
export function recoverPendingSwitch(
  readKeychain: () => string | null,
  paths: readonly [string, string],
  capture: (file: string) => RecoveryFile,
  restore: (before: RecoveryFile, current: RecoveryFile) => void,
): void {
  if (!hasPendingAntigravitySwitch()) return;
  const bytes = readBuffer(recordPath());
  if (!bytes) throw new Error('切换恢复记录已变化，请重试');
  const record: SwitchRecord = JSON.parse(bytes.toString());
  if (!record || record.version !== 1 || (record.keychain !== null && typeof record.keychain !== 'string') ||
      typeof record.target !== 'string' || !Array.isArray(record.before) || record.before.length !== paths.length ||
      record.before.some(file => !file || (file.data !== null && typeof file.data !== 'string'))) {
    throw new Error('切换恢复记录格式无法识别，已保留现场');
  }

  const keychain = readKeychain();
  const target = Buffer.from(record.target, 'base64');
  const current = paths.map(capture);
  const isTarget = (file: RecoveryFile) => !file.unsafe && file.mode === 0o600 && file.bytes?.equals(target);
  if (keychain === null && current.every(isTarget)) {
    finishSwitchRecovery();
    return;
  }
  // A different Keychain login or an external logout owns the current decision.
  if (keychain !== record.keychain) keepRecoveryForReview();
  let conflict = false;
  for (let i = current.length - 1; i >= 0; i--) {
    const saved = record.before[i], actual = current[i];
    const oldBytes = saved.data === null ? null : Buffer.from(saved.data, 'base64');
    if (!actual.unsafe && (oldBytes === null ? actual.bytes === null : actual.bytes?.equals(oldBytes))) continue;
    if (isTarget(actual)) {
      if (readKeychain() !== keychain) keepRecoveryForReview();
      restore({ path: paths[i], bytes: oldBytes, mode: saved.mode, atimeMs: saved.atimeMs, mtimeMs: saved.mtimeMs }, actual);
    } else {
      conflict = true;
    }
  }
  if (conflict) keepRecoveryForReview();
  finishSwitchRecovery();
}
