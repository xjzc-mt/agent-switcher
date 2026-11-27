import type { BaseAgent } from './agents/base';
import { stepDiagnostic } from './diagnostics';
import { credentialOrder, credentialStateFromFiles, CredentialChangedError } from './credential-state';
import { pendingCodexQuota, PendingQuotaConflict, ConsumedCodexRotation } from './temporary-credentials';
import { listProfiles, profileDir, readProfileMeta, writeProfileMeta } from './store';
import { extractRefreshToken, fingerprint, parseJsonBytes } from './utils';

export class RecoveredCodexIdentity extends Error {}

const accessToken = (bytes: Buffer) => parseJsonBytes<{ tokens?: { access_token?: string } }>(bytes)?.tokens?.access_token;

/** Plan and commit under the same identity and pool locks. The caller rechecks the live client before a live write. */
export function codexQuotaRecovery(agent: BaseAgent, dir: string, profile: string | undefined, identity: string, original: Buffer) {
  const grant = extractRefreshToken(original);
  if (!grant || !agent.canRecoverQuotaRotation) return;
  const file = agent.authFiles[0];
  const stateOf = (bytes: Buffer) => credentialStateFromFiles(agent.id, [[file, bytes]]);
  const input = stateOf(original), revision = input.revision, pending = pendingCodexQuota(identity, grant, original, revision);
  if (!pending.length) return;
  stepDiagnostic('recovery-found');
  const inputAccess = accessToken(original), meta = profile && readProfileMeta(agent.id, profile);
  let selected = original;
  for (const entry of pending) {
    const { output } = entry;
    if (!output || original.equals(output) ||
        (grant === extractRefreshToken(output) && inputAccess && inputAccess === accessToken(output))) continue;
    if ((meta && meta.snapshot?.refreshConsumed && (meta.snapshot.consumedRefreshFingerprint === fingerprint(grant) ||
          (!meta.snapshot.consumedRefreshFingerprint && meta.snapshot.credentialRevision === revision))) ||
        !agent.canRecoverQuotaRotation(original, output, meta ? meta.email : undefined)) {
      if (extractRefreshToken(output) && grant !== extractRefreshToken(output)) throw new ConsumedCodexRotation(entry.directory);
      throw new PendingQuotaConflict();
    }
    // A newer pool generation sharing the grant must not be overwritten by an older interrupted bearer update.
    if (!entry.exactInput) {
      const order = credentialOrder(stateOf(output), input);
      if (order === 'older') {
        if (grant === extractRefreshToken(output)) continue;
        throw new ConsumedCodexRotation(entry.directory);
      }
      if (grant === extractRefreshToken(output) && order !== 'newer') throw new PendingQuotaConflict();
    }
    if (entry.exactInput === false || (selected !== original && !selected.equals(output))) throw new PendingQuotaConflict();
    selected = output;
  }
  const changed = selected !== original;
  return { changed, selected, apply() {
    if (!agent.readCredentials(dir)[file]?.equals(original)) throw new CredentialChangedError();
    for (const entry of pending) if (changed && entry.output?.equals(selected)) entry.beforeStore(selected);
    let retain = false;
    if (changed || pending.some(entry => entry.alreadyStored)) {
      let live: Buffer | null = null;
      try { live = agent.readCredentials(agent.homeDir)[file]; }
      catch { retain = true; } // An unreadable client may still hold the old grant.
      const liveRevision = live && stateOf(live).revision;
      const copyMatches = (bytes: Buffer) => {
        const version = stateOf(bytes).revision;
        return (changed && version === revision) || pending.some(entry => entry.matchesInput(bytes, version));
      };
      const pendingLive = dir !== agent.homeDir && !!live && !live.equals(selected) && copyMatches(live);
      retain ||= pendingLive;
      for (const name of listProfiles(agent.id)) {
        const dest = profileDir(agent.id, name);
        let copy: Buffer | null;
        try { copy = agent.readCredentials(dest)[file]; }
        catch (error) {
          if (dest === dir) throw error;
          retain = true; // Its generation is unknown. Other readable profiles can still advance.
          continue;
        }
        if (!copy || copy.equals(selected) || !copyMatches(copy)) continue;
        const copyMeta = readProfileMeta(agent.id, name);
        if (!agent.canRecoverQuotaRotation!(copy, selected, copyMeta.email)) throw new PendingQuotaConflict();
        if (pendingLive && liveRevision)
          writeProfileMeta(agent.id, name, { ...copyMeta, pendingLiveRevision: liveRevision });
        agent.writeCredentials(dest, { [file]: selected });
        if (!agent.readCredentials(dest)[file]?.equals(selected)) throw new Error('未能确认账号副本已写回，已保留恢复记录');
      }
      if (dir === agent.homeDir && changed) {
        if (!agent.readCredentials(dir)[file]?.equals(original)) throw new CredentialChangedError();
        agent.writeCredentials(dir, { [file]: selected });
      }
      if (!agent.readCredentials(dir)[file]?.equals(selected)) throw new Error('未能确认账号凭据已写回，已保留恢复记录');
      agent.adoptRecoveredQuota?.(selected);
    }
    if (!retain) {
      for (const entry of pending) entry.finish();
      stepDiagnostic('recovery-complete');
    }
    // A formerly email-only account now has a verified subject. Continue under its new identity lock.
    if (agent.identityFromBytes(selected)?.id !== identity) throw new RecoveredCodexIdentity();
    return selected;
  } };
}
