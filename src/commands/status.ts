import { BaseAgent, type QuotaWindow } from '../agents/base';
import { activeProfile, refreshAccount } from '../accounts';
import { readRefreshIntervals } from '../settings';

export async function runStatus(agents: BaseAgent[]): Promise<void> {
  const chalk = (await import('chalk')).default;

  console.log(chalk.bold('\n 🤖 AgentSwitcher — Multi-Account & Quota Status\n'));
  console.log(
    chalk.dim(
      ` ${'AGENT'.padEnd(22)} ${'ACTIVE PROFILE'.padEnd(16)} ${'ACCOUNT / PLAN'.padEnd(36)} LIVE STATUS / QUOTA`
    )
  );
  console.log(chalk.dim(' ' + '─'.repeat(100)));

  const manual = readRefreshIntervals().live === 'manual';
  for (const agent of agents) {
    let profile = chalk.dim('(none)');
    let accountStr = chalk.dim('—');
    let extraStr = '';

    try {
      profile = activeProfile(agent) ?? profile;
      const result = await refreshAccount(agent, undefined, manual);
      if (result.available) {
        const planBadge = result.plan ? chalk.magenta(` [${result.plan.toUpperCase()}]`) : '';
        accountStr = (result.account ?? chalk.dim('—')) + planBadge;
        const format = (w: QuotaWindow) => `${w.windowMins ?? '?'}分钟: 剩余 ${100 - w.usedPercent}%`;
        const quota = result.quota;
        const usage = agent.id === 'agy' && quota?.buckets ? quota.buckets.map(group => [group.label, ...group.windows.map(format)].join(' ')) :
          [quota?.primaryWindow, quota?.secondaryWindow].filter((w): w is QuotaWindow => !!w).map(format);
        extraStr = chalk.dim(result.extra || usage.join(' | '));
      } else {
        accountStr = chalk.dim('未识别文件凭据');
        extraStr = chalk.dim(result.extra || '未登录或暂不支持此认证方式');
      }
    } catch {
      accountStr = chalk.red('error reading status');
    }

    const labelCol = chalk.cyan(agent.label.padEnd(22));
    const profileCol = (typeof profile === 'string' && !profile.includes('\x1b'))
      ? chalk.green(profile.padEnd(16))
      : profile.toString().padEnd(16);
    const accountCol = accountStr.padEnd(36);

    console.log(` ${labelCol} ${profileCol} ${accountCol} ${extraStr}`);
  }

  console.log('');
}
