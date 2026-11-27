import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { processProbeError } from './diagnostics';

const run = promisify(execFile);
const appReference = (name: string) => name === 'Codex' ? 'application id "com.openai.codex"' : `application ${JSON.stringify(name)}`;

async function isRunning(name: string): Promise<boolean> {
  const { stdout } = await run('osascript', ['-e', `${appReference(name)} is running`], { timeout: 2000 });
  const result = stdout.trim();
  if (result !== 'true' && result !== 'false') throw new Error('无效的客户端状态');
  return result === 'true';
}

export async function macDesktopRunning(name: string, failClosed = false): Promise<boolean> {
  try { return await isRunning(name); }
  catch (error) {
    const missing = /-1728|-10814|can['’]t get application|unable to find application/i.test(String((error as Error)?.message || ''));
    if (failClosed && !missing) throw processProbeError(error, `无法检测 ${name} 桌面状态，请手动退出该客户端后重试`,
      `检测 ${name} 桌面状态超时，请稍后重试`);
    return false;
  }
}

export async function quitMacDesktop(name: string): Promise<void> {
  await run('osascript', ['-e', `tell ${appReference(name)} to quit`], { timeout: 10000 });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await macDesktopRunning(name, true))) return;
    if (attempt === 49) throw new Error(`${name} 未能正常退出，请手动退出后重试`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

export async function openMacDesktop(name: string): Promise<void> {
  await run('open', name === 'Codex' ? ['-b', 'com.openai.codex'] : ['-a', name]);
}
