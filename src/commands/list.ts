import { BaseAgent } from '../agents/base';
import { listProfiles } from '../store';
import { activeProfile } from '../accounts';

export async function runList(agents: BaseAgent[], filterAgentId?: string): Promise<void> {
  const chalk = (await import('chalk')).default;

  const targets = filterAgentId
    ? agents.filter((a) => a.id === filterAgentId)
    : agents;

  if (filterAgentId && targets.length === 0) {
    console.error(chalk.red(`✖  Unknown agent: "${filterAgentId}"`));
    process.exit(1);
  }

  let anyProfiles = false;

  for (const agent of targets) {
    const profiles = listProfiles(agent.id);
    const active = activeProfile(agent);

    console.log(chalk.bold.cyan(`\n${agent.label}  `) + chalk.dim(`(${agent.id})`));

    if (profiles.length === 0) {
      console.log(chalk.dim('  (no profiles saved)'));
      continue;
    }

    anyProfiles = true;
    for (const p of profiles) {
      const isActive = p === active;
      const marker = isActive ? chalk.green('● ') : chalk.dim('○ ');
      const name = isActive ? chalk.bold.green(p) : p;
      console.log(`  ${marker}${name}`);
    }
  }

  if (!anyProfiles) {
    console.log(chalk.dim('\nNo profiles saved yet. Run: ags save <agent> <name>'));
  }
}
