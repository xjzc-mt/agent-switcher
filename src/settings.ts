import path from 'path';
import { STORE_DIR, withStoreLock } from './store';
import { atomicWrite, readJsonFile } from './utils';
export interface Settings { showResetTimes: boolean; openPrivateLogin: boolean }
const file = path.join(STORE_DIR, 'settings.json');
export function readSettings(): Settings {
  const stored = readJsonFile<Settings>(file);
  // Ignore retired ranking rules and migrate old settings without losing display preferences.
  return {
    showResetTimes: typeof stored?.showResetTimes === 'boolean' ? stored.showResetTimes : true,
    openPrivateLogin: typeof stored?.openPrivateLogin === 'boolean' ? stored.openPrivateLogin : true,
  };
}
export async function saveSettings(settings: Settings): Promise<Settings> {
  if (typeof settings?.showResetTimes !== 'boolean') throw new Error('无效的显示设置');
  if (settings.openPrivateLogin !== undefined && typeof settings.openPrivateLogin !== 'boolean') throw new Error('无效的登录设置');
  return withStoreLock(async () => {
    const clean = { showResetTimes: settings.showResetTimes, openPrivateLogin: settings.openPrivateLogin ?? readSettings().openPrivateLogin };
    atomicWrite(file, JSON.stringify(clean, null, 2)); return clean;
  });
}
