export const agentMetadata = {
  codex: { label: 'Codex', credential: 'auth.json' },
  agy: { label: 'Antigravity', credential: 'jetski-standalone-oauth-token' },
} as const;

export type AgentId = keyof typeof agentMetadata;
export const agentIds = Object.keys(agentMetadata) as AgentId[];
