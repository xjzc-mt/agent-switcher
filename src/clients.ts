import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
const run = promisify(execFile);
const MAC_APPS: Record<string, string[]> = { codex: ['Codex'], agy: ['Antigravity'], claude: [] };
const CODEX_BUNDLE_ID = 'com.openai.codex';
const appReference = (name: string) => name === 'Codex' ? `application id "${CODEX_BUNDLE_ID}"` : `application ${JSON.stringify(name)}`;
async function isRunning(name: string): Promise<boolean> {
  const { stdout } = await run('osascript', ['-e', `${appReference(name)} is running`], { timeout: 2000 });
  return stdout.trim() === 'true';
}
export async function runningClients(id: string): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const running: string[] = [];
  for (const name of MAC_APPS[id] || []) {
    try {
      if (await isRunning(name)) running.push(name);
    } catch { /* App not installed. */ }
  }
  return running;
}
export async function quitClients(names: string[]): Promise<void> {
  for (const name of names) {
    await run('osascript', ['-e', `tell ${appReference(name)} to quit`], { timeout: 10000 });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await isRunning(name))) break;
      if (attempt === 49) throw new Error(`${name} 未能正常退出，请手动退出后重试`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
export async function openClients(names: string[]): Promise<void> {
  for (const name of names) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await run('open', name === 'Codex' ? ['-b', CODEX_BUNDLE_ID] : ['-a', name]);
        break;
      } catch (error) {
        // Launch Services may report an error after the app has actually started.
        try { if (await isRunning(name)) break; } catch { /* Retry the launch. */ }
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 800));
      }
    }
  }
}
export async function loginInTerminal(binary: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('请在终端运行官方登录命令后保存账号');
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const command = ['env', ...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`), quote(binary), ...args.map(quote)].join(' ');
  try {
    await run('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate']);
  } catch (error) {
    const message = String((error as Error).message);
    if (/-1743|not authorized to send Apple events|未获得授权将Apple事件/i.test(message)) {
      throw new Error('macOS 未允许控制 Terminal。可改用 Session 导入；如需终端登录，请在系统设置 → 隐私与安全性 → 自动化中允许 AgentSwitcher 控制 Terminal。');
    }
    throw new Error('无法打开登录终端，可改用 Session 导入或在终端完成官方登录。');
  }
}
export function findClaudeBinary(): string {
  const local = path.join(os.homedir(), '.local/bin/claude');
  return fs.existsSync(local) ? local : 'claude';
}
