import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const appReference = (name: string) => name === 'Codex' ? 'application id "com.openai.codex"' : `application ${JSON.stringify(name)}`;

async function isRunning(name: string): Promise<boolean> {
  const { stdout } = await run('osascript', ['-e', `${appReference(name)} is running`], { timeout: 2000 });
  return stdout.trim() === 'true';
}

export async function macDesktopRunning(name: string, failClosed = false): Promise<boolean> {
  try { return await isRunning(name); }
  catch (error) {
    const missing = /-2700|-1728|-10814|can['’]t get application|unable to find application/i.test(String((error as Error)?.message || ''));
    if (failClosed && !missing) throw error;
    return false;
  }
}

export async function quitMacDesktop(name: string): Promise<void> {
  await run('osascript', ['-e', `tell ${appReference(name)} to quit`], { timeout: 10000 });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await isRunning(name))) return;
    if (attempt === 49) throw new Error(`${name} 未能正常退出，请手动退出后重试`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

export async function openMacDesktop(name: string): Promise<void> {
  await run('open', name === 'Codex' ? ['-b', 'com.openai.codex'] : ['-a', name]);
}
