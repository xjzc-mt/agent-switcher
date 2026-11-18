import { BaseAgent } from '../agents/base';
import { saveAccount } from '../accounts';
export async function runSave(agent: BaseAgent, name: string): Promise<void> {
  const result = await saveAccount(agent, name);
  console.log(`✔ 已${result.updated ? '更新' : '保存'} ${agent.label} / ${result.profile || name} (${result.files.join(', ')})`);
}
