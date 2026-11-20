import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, fingerprint, readJsonFile } from './utils';
import { tryAcquireAtomicLock, evictDeadLock, releaseAtomicLock } from './credential-vault';
import type { StatusResult } from './agents/base';

export const STORE_DIR = path.join(os.homedir(), '.agent-switcher');
export const AGENT_IDS = ['codex', 'claude', 'agy'];
const META_FILE = path.join(STORE_DIR, 'meta.json');
export const PENDING_RENAME_FILE = path.join(STORE_DIR, '.pending-rename.json');
export interface Meta { version: number; activeProfiles: Record<string, string> }
export interface PendingCaseRename {
  agentId: string;
  oldName: string;
  newName: string;
  hopName: string;
  wasPreferred: boolean;
  hadLabel: boolean;
  oldLabel?: string;
}
export interface ProfileMeta {
  label?: string;
  plan?: string;
  quotaNote?: string;
  email?: string;
  savedAt?: string;
  snapshot?: StatusResult;
  stagedCheck?: { revision: string; checkedAt: string };
}

export const profileNameError: (name: string, portable?: boolean) => string = require('../renderer/profile-name.js');
const validProfileName = (name: string) => !profileNameError(name, process.platform === 'win32');
export function profileNameKey(name: string): string { return name.normalize('NFC').toLowerCase(); }
export function validateName(name: string, portable = true): void {
  const error = profileNameError(name, portable);
  if (error) throw new Error(error);
}

let reconcilingRename = false;
let activeInProcessRename = false;
export function setInProcessRename(active: boolean): void { activeInProcessRename = active; }

function platformDirectory(agentId: string): string {
  if (!AGENT_IDS.includes(agentId)) throw new Error('未知平台');
  const directory = path.join(STORE_DIR, agentId);
  for (const entry of [STORE_DIR, directory]) {
    if (fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('账号目录不能是符号链接');
  }
  return directory;
}

function reconcilePendingRename(holdsStoreLock = false): void {
  if (reconcilingRename || activeInProcessRename) return;
  if (fs.lstatSync(STORE_DIR, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('账号池不能是符号链接');
  if (!fs.lstatSync(PENDING_RENAME_FILE, { throwIfNoEntry: false })) return;
  const lock = path.join(STORE_DIR, '.lock');
  let owner: string | null = null;
  if (!holdsStoreLock) {
    // Readers may recover a crashed writer, but may never advance a live transaction.
    const acquire = () => tryAcquireAtomicLock(lock, String(process.pid));
    owner = acquire();
    if (!owner && evictDeadLock(lock)) owner = acquire();
    if (!owner) return;
  }
  reconcilingRename = true;
  try {
    const entry = fs.lstatSync(PENDING_RENAME_FILE, { throwIfNoEntry: false });
    if (!entry) return;
    const pending = entry.isFile() ? readJsonFile<PendingCaseRename>(PENDING_RENAME_FILE) : null;
    const retainRecord = () => fs.renameSync(PENDING_RENAME_FILE, path.join(STORE_DIR, `.retained-rename-${randomUUID()}.json`));
    // Older versions prefixed the temporary name with the original profile name.
    const suffix = typeof pending?.oldName === 'string' && typeof pending.hopName === 'string' && pending.hopName.startsWith(pending.oldName + '.rename-')
      ? pending.hopName.slice(pending.oldName.length) : pending?.hopName;
    if (!pending || !AGENT_IDS.includes(pending.agentId) || !validProfileName(pending.oldName) || !validProfileName(pending.newName) ||
        !sameProfileName(pending.oldName, pending.newName) || pending.oldName === pending.newName ||
        typeof suffix !== 'string' || !/^\.rename-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(suffix)) {
      retainRecord();
      return;
    }
    const agentDir = platformDirectory(pending.agentId);
    const entries = fs.existsSync(agentDir) ? fs.readdirSync(agentDir) : [];
    const hopPath = path.join(agentDir, pending.hopName);
    const destPath = path.join(agentDir, pending.newName);
    let finalName = pending.newName;
    if (entries.includes(pending.hopName)) {
      // An external login or directory may have occupied the destination since the interrupted rename.
      if (fs.lstatSync(destPath, { throwIfNoEntry: false }) || !fs.lstatSync(hopPath).isDirectory() || entries.includes(pending.oldName)) {
        retainRecord();
        return;
      }
      fs.renameSync(hopPath, destPath);
    } else if (!entries.includes(pending.newName)) {
      if (!entries.includes(pending.oldName)) {
        fs.rmSync(PENDING_RENAME_FILE, { force: true });
        return;
      }
      finalName = pending.oldName;
    }
    const label = finalName === pending.newName ? pending.newName : pending.oldLabel;
    if (pending.hadLabel && label !== undefined) {
      const metaPath = path.join(profileDir(pending.agentId, finalName), '_meta.json');
      const pm = readJsonFile<ProfileMeta>(metaPath) || {};
      if (pm.label !== label) atomicWrite(metaPath, JSON.stringify({ ...pm, label }, null, 2));
    }
    if (pending.wasPreferred) {
      const meta = fs.existsSync(META_FILE) ? readJsonFile<Meta>(META_FILE) : { version: 1, activeProfiles: {} };
      if (meta?.activeProfiles && meta.activeProfiles[pending.agentId] !== finalName) {
        meta.activeProfiles[pending.agentId] = finalName;
        atomicWrite(META_FILE, JSON.stringify(meta, null, 2));
      }
    }
    fs.rmSync(PENDING_RENAME_FILE, { force: true });
  } finally {
    reconcilingRename = false;
    if (owner) releaseAtomicLock(lock, owner);
  }
}

export function profileDir(agentId: string, name: string): string {
  const directory = platformDirectory(agentId);
  reconcilePendingRename();
  validateName(name, process.platform === 'win32');
  const dir = path.join(directory, name);
  const entry = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw new Error('账号目录不能是符号链接');
  if (!entry) validateName(name);
  return dir;
}

export function readMeta(): Meta {
  reconcilePendingRename();
  if (!fs.existsSync(META_FILE)) return { version: 1, activeProfiles: {} };
  const meta = readJsonFile<Meta>(META_FILE);
  if (!meta?.activeProfiles || typeof meta.activeProfiles !== 'object') throw new Error('meta.json 损坏，请从备份恢复');
  return meta;
}
export function writeMeta(meta: Meta): void { atomicWrite(META_FILE, JSON.stringify(meta, null, 2)); }
export function setActiveProfile(id: string, name: string): void {
  const meta = readMeta(); meta.activeProfiles[id] = name; writeMeta(meta);
}
export function clearActiveProfile(id: string): void {
  const meta = readMeta(); delete meta.activeProfiles[id]; writeMeta(meta);
}
export function getActiveProfile(id: string): string | undefined { return readMeta().activeProfiles[id]; }
export function profileExists(id: string, name: string): boolean {
  return fs.existsSync(profileDir(id, name));
}
export function listProfiles(id: string, options: { includeInvalid?: boolean } = {}): string[] {
  const dir = platformDirectory(id);
  reconcilePendingRename();
  if (!fs.existsSync(dir)) return [];
  const pending = readJsonFile<PendingCaseRename>(PENDING_RENAME_FILE);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(f => (f.isDirectory() || (options.includeInvalid && f.isSymbolicLink())) &&
      (options.includeInvalid || validProfileName(f.name)) && !(pending?.agentId === id && f.name === pending.hopName))
    .map(f => f.name)
    .sort();
}
export function readProfileMeta(id: string, name: string): ProfileMeta {
  return readJsonFile<ProfileMeta>(path.join(profileDir(id, name), '_meta.json')) || {};
}
export function writeProfileMeta(id: string, name: string, meta: ProfileMeta): void {
  atomicWrite(path.join(profileDir(id, name), '_meta.json'), JSON.stringify(meta, null, 2));
}

export function sameProfileName(a: string, b: string): boolean {
  return profileNameKey(a) === profileNameKey(b);
}

/** Mutations share one lock. Quota readers serialize only against readers of the same identity. */
export async function withStoreLock<T>(work: () => Promise<T>, quotaIdentity?: string): Promise<T> {
  ensureDir(STORE_DIR);
  const root = fs.lstatSync(STORE_DIR);
  if (!root.isDirectory()) throw new Error('账号池必须是普通目录，不能是符号链接');
  if (process.platform !== 'win32' && (root.mode & 0o777) !== 0o700) {
    const fd = fs.openSync(STORE_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fchmodSync(fd, 0o700); } finally { fs.closeSync(fd); }
  }
  const lock = path.join(STORE_DIR, quotaIdentity === undefined ? '.lock' : '.quota-' + fingerprint(quotaIdentity));
  const payload = `${process.pid}\n${randomUUID()}`;
  const deadline = Date.now() + 20000;
  let ownerId: string | null = null;
  while (true) {
    ownerId = tryAcquireAtomicLock(lock, payload);
    if (ownerId !== null) break;
    const evicted = evictDeadLock(lock);
    if (Date.now() > deadline) throw new Error('另一个账号操作仍在进行，请稍后重试');
    if (!evicted) await new Promise(resolve => setTimeout(resolve, 100));
  }
  try {
    if (quotaIdentity === undefined) reconcilePendingRename(true);
    return await work();
  } finally { releaseAtomicLock(lock, ownerId); }
}
