import { BaseAgent } from '../agents/base';
import { removeAccount, previewRemoveAccount } from '../accounts';
export async function runRemove(agent: BaseAgent, name: string, options: { yes?: boolean; logout?: boolean } = {}): Promise<void> {
  const preview = await previewRemoveAccount(agent, name);
  if (!options.yes) {
    console.log(`将移除 ${agent.label} 的 ${preview.profiles.length} 条备份：${preview.profiles.join('、')}`);
    console.log(options.logout ? '同时退出已确认属于此账号的本机登录；请先关闭客户端。' : '客户端登录和历史记录保留。');
    console.log('核对后加 --yes 执行；需要退出时同时加 --logout。');
    return;
  }
  const result = await removeAccount(agent, name, { preview, logout: options.logout });
  console.log(`✔ 已移除 ${result.removed.length} 条备份；${result.loggedOut ? '已清除本机登录' : '客户端登录保留'}。`);
}
