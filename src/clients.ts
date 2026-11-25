import { agentMetadata, type AgentId } from './agents/metadata';
import { openMacDesktop, quitMacDesktop, macDesktopRunning } from './macos-desktop';
import { openWindowsDesktop, quitWindowsDesktop, runningWindowsClients, windowsDesktopReopened } from './windows-desktop';

const knownDesktop = (name: string): name is 'Codex' | 'Antigravity' => name === 'Codex' || name === 'Antigravity';

export async function runningClients(id: string, options: { failClosed?: boolean } = {}): Promise<string[]> {
  if (!Object.hasOwn(agentMetadata, id)) return [];
  const name = agentMetadata[id as AgentId].label;
  // Windows cannot distinguish a missing desktop from an inaccessible inventory by retrying the same query.
  if (process.platform === 'win32') return runningWindowsClients(name);
  return process.platform === 'darwin' && await macDesktopRunning(name, options.failClosed) ? [name] : [];
}

export async function quitClients(names: string[]): Promise<void> {
  for (const name of names) {
    if (process.platform === 'win32') {
      if (!knownDesktop(name)) throw new Error('请手动退出客户端');
      await quitWindowsDesktop(name, names);
    } else await quitMacDesktop(name);
  }
}

export async function openClients(names: string[]): Promise<void> {
  for (const name of names) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (process.platform === 'win32') {
          if (!knownDesktop(name)) throw new Error('请手动打开客户端');
          await openWindowsDesktop(name);
        } else await openMacDesktop(name);
        break;
      } catch (error) {
        try {
          const running = process.platform === 'win32'
            ? knownDesktop(name) && await windowsDesktopReopened(name)
            : await macDesktopRunning(name);
          if (running) break;
        } catch { /* Startup can succeed while desktop discovery is briefly unavailable. */ }
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 800));
      }
    }
  }
}
