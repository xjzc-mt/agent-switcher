import type { BaseAgent } from './agents/base';
import { listProfiles, profileDir, profileNameKey } from './store';

interface Entry { key: string; profile: string; source: 'pool' | 'batch' }

/** One observation per platform and phase. Installation always builds a fresh index under lock. */
interface Pool { names: Set<string>; byIdentity: Map<string, Entry>; byProfile: Map<string, Entry> }
export function importPool() {
  const pools = new Map<string, Pool>();
  return (agent: BaseAgent) => {
    let pool = pools.get(agent.id);
    if (!pool) {
      const profiles = listProfiles(agent.id);
      pool = { names: new Set(profiles.map(profileNameKey)), byIdentity: new Map(), byProfile: new Map() };
      for (const profile of profiles) {
        try {
          const identity = agent.identity(profileDir(agent.id, profile));
          if (!identity) continue;
          const entry: Entry = { key: agent.id + '/' + profile, profile, source: 'pool' };
          pool.byProfile.set(profile, entry);
          if (!pool.byIdentity.has(identity.id)) pool.byIdentity.set(identity.id, entry);
        } catch { /* A damaged account still reserves its name. */ }
      }
      pools.set(agent.id, pool);
    }
    return pool;
  };
}
