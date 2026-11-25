import path from 'path';
import { STORE_DIR, withStoreLock } from './store';
import { atomicWrite, readJsonFile } from './utils';
export type LiveRefreshInterval = '1m' | '3m' | '5m' | 'manual';
export type SpareRefreshInterval = '5m' | '15m' | '30m' | 'manual';
export interface Settings {
  showResetTimes: boolean;
  openPrivateLogin: boolean;
  liveRefreshInterval: LiveRefreshInterval;
  spareRefreshInterval: SpareRefreshInterval;
}
type StoredSettings = Partial<Settings> & { autoRefreshInterval?: unknown };
function liveInterval(value: unknown, legacy?: unknown): LiveRefreshInterval {
  if (value === '1m' || value === '3m' || value === '5m' || value === 'manual') return value;
  if (legacy === '15m') return '3m';
  if (legacy === '30m') return '5m';
  if (legacy === 'manual') return 'manual';
  return '1m';
}
function spareInterval(value: unknown, legacy?: unknown): SpareRefreshInterval {
  const candidate = value ?? legacy;
  return candidate === '15m' || candidate === '30m' || candidate === 'manual' ? candidate : '5m';
}
const file = path.join(STORE_DIR, 'settings.json');
export function readSettings(): Settings {
  const stored = readJsonFile<StoredSettings>(file);
  // Ignore retired ranking/coupled rules and migrate old settings without losing display preferences.
  return {
    liveRefreshInterval: liveInterval(stored?.liveRefreshInterval, stored?.autoRefreshInterval),
    spareRefreshInterval: spareInterval(stored?.spareRefreshInterval, stored?.autoRefreshInterval),
    showResetTimes: typeof stored?.showResetTimes === 'boolean' ? stored.showResetTimes : true,
    openPrivateLogin: typeof stored?.openPrivateLogin === 'boolean' ? stored.openPrivateLogin : true,
  };
}
// Keep the account list and explicit refresh available when preferences cannot be read.
export function readRefreshIntervals(): { live: LiveRefreshInterval; spare: SpareRefreshInterval } {
  try {
    const current = readSettings();
    return { live: current.liveRefreshInterval, spare: current.spareRefreshInterval };
  } catch { return { live: 'manual', spare: 'manual' }; }
}
export async function saveSettings(settings: Settings): Promise<Settings> {
  if (typeof settings?.showResetTimes !== 'boolean') throw new Error('无效的显示设置');
  if (settings.openPrivateLogin !== undefined && typeof settings.openPrivateLogin !== 'boolean') throw new Error('无效的登录设置');
  return withStoreLock(async () => {
    const previous = readSettings();
    const clean: Settings = {
      showResetTimes: settings.showResetTimes,
      openPrivateLogin: settings.openPrivateLogin ?? previous.openPrivateLogin,
      liveRefreshInterval: settings.liveRefreshInterval === undefined ? previous.liveRefreshInterval : liveInterval(settings.liveRefreshInterval),
      spareRefreshInterval: settings.spareRefreshInterval === undefined ? previous.spareRefreshInterval : spareInterval(settings.spareRefreshInterval),
    };
    atomicWrite(file, JSON.stringify(clean, null, 2)); return clean;
  });
}
