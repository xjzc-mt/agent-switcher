import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);
const flags: Record<string, string> = {
  'com.google.Chrome': '--incognito',
  'com.google.Chrome.beta': '--incognito',
  'com.google.Chrome.dev': '--incognito',
  'com.google.Chrome.canary': '--incognito',
  'company.thebrowser.Browser': '--incognito',
  'com.vivaldi.Vivaldi': '--incognito',
  'org.chromium.Chromium': '--incognito',
  'com.brave.Browser': '--incognito',
  'com.brave.Browser.beta': '--incognito',
  'com.brave.Browser.nightly': '--incognito',
  'com.microsoft.edgemac': '--inprivate',
  'com.microsoft.edgemac.Beta': '--inprivate',
  'com.microsoft.edgemac.Dev': '--inprivate',
  'com.microsoft.edgemac.Canary': '--inprivate',
  'org.mozilla.firefox': '-private-window',
  'org.mozilla.firefoxdeveloperedition': '-private-window',
  'org.mozilla.nightly': '-private-window',
};

/** No UI scripting or permission to control another app. Unknown browsers fall back to copying. */
export async function openPrivateBrowser(applicationPath: string, url: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !path.isAbsolute(applicationPath) || !applicationPath.endsWith('.app')) return false;
  const target = URL.parse(url);
  if (!target || !['https://auth.openai.com', 'https://chatgpt.com', 'https://accounts.google.com'].includes(target.origin) || target.username || target.password) return false;
  try {
    const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(applicationPath, 'Contents', 'Info.plist')], { timeout: 2000, maxBuffer: 4096 });
    const flag = flags[stdout.trim()];
    if (!flag) return false;
    // -n delivers command-line arguments even if the browser is already open.
    // The browser handles reuse of its own profile; no shell interprets the URL.
    await run('/usr/bin/open', ['-n', '-a', applicationPath, '--args', flag, url], { timeout: 5000, maxBuffer: 4096 });
    return true;
  } catch { return false; } // exec errors can include the sensitive OAuth URL.
}
