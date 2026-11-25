#!/usr/bin/env node
import { agentIds as AGENT_IDS } from './agents/metadata';
import { Argument, Command } from 'commander';
import { once } from 'events';
import path from 'path';
import { spawn } from 'child_process';
import { ALL_AGENTS, resolveAgent } from './accounts';
import { runSave } from './commands/save';
import { runUse } from './commands/use';
import { runList } from './commands/list';
import { runStatus } from './commands/status';
import { runRemove } from './commands/remove';
import { maintainCredentialStorage } from './storage-maintenance';


const program = new Command();
program.hook('preAction', async (_root, command) => {
  if (command.name() !== 'gui') await maintainCredentialStorage();
});

program
  .name('ags')
  .description('AgentSwitcher — multi-account & quota manager for AI coding agents')
  .version(require('../package.json').version);

// ── save ──────────────────────────────────────────────────────────────────────
program
  .command('save')
  .addArgument(new Argument('<agent>').choices(AGENT_IDS))
  .argument('<profile>')
  .description('Save current auth of <agent> as named <profile>')
  .addHelpText('after', `\n  Agents:  ${AGENT_IDS.join(', ')}\n  Example: ags save codex work\n           ags save agy  personal`)
  .action(async (agentId: string, profileName: string) => {
    await runSave(resolveAgent(agentId), profileName);
  });

// ── use ───────────────────────────────────────────────────────────────────────
program
  .command('use')
  .addArgument(new Argument('<agent>').choices(AGENT_IDS))
  .argument('<profile>')
  .description('Switch <agent> to a saved <profile>')
  .option('--save-current', 'Save an unmanaged current account before switching')
  .option('--discard-current', 'Switch without saving an unmanaged current account')
  .option('--allow-file-storage', 'Allow Antigravity to use its two private OAuth files and retire its previous system credential for a long login')
  .addHelpText('after', `\n  Example: ags use codex work\n           ags use agy  personal`)
  .action(async (agentId: string, profileName: string, options) => {
    if (options.saveCurrent && options.discardCurrent) throw new Error('只能选择一种当前账号处理方式');
    await runUse(resolveAgent(agentId), profileName, { saveUnmanaged: options.saveCurrent ? true : options.discardCurrent ? false : undefined,
      allowFileMigration: !!options.allowFileStorage });
  });

// ── list ──────────────────────────────────────────────────────────────────────
program
  .command('list')
  .addArgument(new Argument('[agent]').choices(AGENT_IDS))
  .alias('ls')
  .description('List saved profiles (optionally filter by agent)')
  .action(async (agentId?: string) => {
    await runList(ALL_AGENTS, agentId);
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .alias('st')
  .description('Show currently active profile & account for each agent')
  .action(async () => {
    await runStatus(ALL_AGENTS);
  });

// ── rm ────────────────────────────────────────────────────────────────────────
program
  .command('rm')
  .addArgument(new Argument('<agent>').choices(AGENT_IDS))
  .argument('<profile>')
  .alias('remove')
  .description('Delete a saved profile')
  .option('--yes', 'Confirm removing the displayed account and matching backups')
  .option('--logout', 'Also clear the verified current client login')
  .action(async (agentId: string, profileName: string, options) => {
    await runRemove(resolveAgent(agentId), profileName, options);
  });

// ── gui ───────────────────────────────────────────────────────────────────────
program
  .command('gui')
  .description('Open the AgentSwitcher desktop GUI')
  .action(async () => {
    const appRoot = path.join(__dirname, '..');
    let electronBin = 'electron';
    try { electronBin = require('electron'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
    const child = spawn(electronBin, [appRoot], {
      detached: true,
      stdio: 'ignore',
    });
    try { await once(child, 'spawn'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('未找到 Electron，请在 AGS 源码目录运行 npm ci 后重试');
      throw error;
    }
    child.unref();
    console.log('🤖 AgentSwitcher GUI launched.');
  });

program.parseAsync(process.argv).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
