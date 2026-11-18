#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ALL_AGENTS } from './accounts';
import { runSave } from './commands/save';
import { runUse } from './commands/use';
import { runList } from './commands/list';
import { runStatus } from './commands/status';
import { runRemove } from './commands/remove';
import { maintainCredentialStorage } from './storage-maintenance';

const AGENT_IDS  = ALL_AGENTS.map((a) => a.id);

function resolveAgent(id: string) {
  const agent = ALL_AGENTS.find((a) => a.id === id);
  if (!agent) {
    console.error(`Unknown agent: "${id}". Available: ${AGENT_IDS.join(', ')}`);
    process.exit(1);
  }
  return agent;
}

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
  .command('save <agent> <profile>')
  .description('Save current auth of <agent> as named <profile>')
  .addHelpText('after', `\n  Agents:  ${AGENT_IDS.join(', ')}\n  Example: ags save codex work\n           ags save agy  personal`)
  .action(async (agentId: string, profileName: string) => {
    await runSave(resolveAgent(agentId), profileName);
  });

// ── use ───────────────────────────────────────────────────────────────────────
program
  .command('use <agent> <profile>')
  .description('Switch <agent> to a saved <profile>')
  .option('--save-current', 'Save an unmanaged current account before switching')
  .option('--discard-current', 'Switch without saving an unmanaged current account')
  .addHelpText('after', `\n  Example: ags use codex work\n           ags use agy  personal`)
  .action(async (agentId: string, profileName: string, options) => {
    if (options.saveCurrent && options.discardCurrent) throw new Error('只能选择一种当前账号处理方式');
    await runUse(resolveAgent(agentId), profileName, { saveUnmanaged: options.saveCurrent ? true : options.discardCurrent ? false : undefined });
  });

// ── list ──────────────────────────────────────────────────────────────────────
program
  .command('list [agent]')
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
  .command('rm <agent> <profile>')
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
  .action(() => {
    const appRoot = path.join(__dirname, '..');
    let electronBin = path.join(appRoot, 'node_modules', '.bin', 'electron');
    if (!fs.existsSync(electronBin)) {
      electronBin = 'electron';
    }

    const child = spawn(electronBin, [appRoot], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('🤖 AgentSwitcher GUI launched.');
  });

program.parseAsync(process.argv).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
