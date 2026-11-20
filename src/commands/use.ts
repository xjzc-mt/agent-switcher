import { BaseAgent } from '../agents/base';
import { useAccount } from '../accounts';
export async function runUse(agent: BaseAgent, name: string, options: { saveUnmanaged?: boolean; allowFileMigration?: boolean } = {}): Promise<void> {
  const result = await useAccount(agent, name, options);
  console.log(`✔ 已切换 ${agent.label} / ${name}`);
  result.warnings.forEach(message => console.log(message));
}
