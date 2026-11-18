import { BaseAgent } from '../agents/base';
import { activeProfile, refreshAccount } from '../accounts';

export async function runStatus(agents: BaseAgent[]): Promise<void> {
  const chalk = (await import('chalk')).default;

  console.log(chalk.bold('\n 🤖 AgentSwitcher — Multi-Account & Quota Status\n'));
  console.log(
    chalk.dim(
      ` ${'AGENT'.padEnd(22)} ${'ACTIVE PROFILE'.padEnd(16)} ${'ACCOUNT / PLAN'.padEnd(36)} LIVE STATUS / QUOTA`
    )
  );
  console.log(chalk.dim(' ' + '─'.repeat(100)));

  for (const agent of agents) {
    const profile = activeProfile(agent) ?? chalk.dim('(none)');
    let accountStr = chalk.dim('—');
    let extraStr = '';

    try {
      const result = await refreshAccount(agent);
      if (result.available) {
        const planBadge = result.plan ? chalk.magenta(` [${result.plan.toUpperCase()}]`) : '';
        accountStr = (result.account ?? chalk.dim('—')) + planBadge;
        extraStr = chalk.dim(result.extra || [result.quota?.primaryWindow, result.quota?.secondaryWindow].filter(Boolean).map(w => `${w!.windowMins ?? '?'}分钟: 剩余 ${100 - w!.usedPercent}%`).join(' | '));
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
