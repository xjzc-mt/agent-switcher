import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, ensureDir, fingerprint, readJsonFile } from './utils';
import type { StatusResult } from './agents/base';

export const STORE_DIR = path.join(os.homedir(), '.agent-switcher');
export const AGENT_IDS = ['codex', 'claude', 'agy'];
const META_FILE = path.join(STORE_DIR, 'meta.json');
export interface Meta { version: number; activeProfiles: Record<string, string> }
export interface ProfileMeta {
  label?: string;
  plan?: string;
  quotaNote?: string;
  email?: string;
  savedAt?: string;
  snapshot?: StatusResult;
}

export function validateName(name: string): void {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name === '.' || name.includes('..') || /[\\/\x00-\x1f\x7f]/.test(name) || name.length > 100) {
    throw new Error('账号名称不能为空，不能包含路径分隔符、连续点或控制字符');
  }
}

export function profileDir(agentId: string, name: string): string {
  if (!AGENT_IDS.includes(agentId)) throw new Error('未知平台');
  validateName(name);
  const dir = path.join(STORE_DIR, agentId, name);
  for (const p of [STORE_DIR, path.dirname(dir), dir]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('账号目录不能是符号链接');
  }
  return dir;
}

export function readMeta(): Meta {
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
export function profileExists(id: string, name: string): boolean { return fs.existsSync(profileDir(id, name)); }
export function listProfiles(id: string): string[] {
  const dir = path.dirname(profileDir(id, '_'));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.isDirectory()).map(f => f.name).sort();
}
export function readProfileMeta(id: string, name: string): ProfileMeta {
  return readJsonFile<ProfileMeta>(path.join(profileDir(id, name), '_meta.json')) || {};
}
export function writeProfileMeta(id: string, name: string, meta: ProfileMeta): void {
  atomicWrite(path.join(profileDir(id, name), '_meta.json'), JSON.stringify(meta, null, 2));
}

/** Mutations share one lock. Quota readers serialize only against readers of the same identity. */
export async function withStoreLock<T>(work: () => Promise<T>, quotaIdentity?: string): Promise<T> {
  ensureDir(STORE_DIR);
  fs.chmodSync(STORE_DIR, 0o700);
  const lock = path.join(STORE_DIR, quotaIdentity === undefined ? '.lock' : '.quota-' + fingerprint(quotaIdentity));
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try { pid = Number(fs.readFileSync(lock, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try { if (pid) process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { fs.rmSync(lock, { force: true }); continue; }
      }
      if (Date.now() > deadline) throw new Error('另一个账号操作仍在进行，请稍后重试');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await work(); } finally { fs.rmSync(lock, { force: true }); }
}
