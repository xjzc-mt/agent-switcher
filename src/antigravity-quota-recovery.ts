import fs from 'fs';
import path from 'path';
import type { AntigravityAgent } from './agents/antigravity';
import { cliTokenPath } from './antigravity-cli';
import { compareNativeSessionCopies, findQuotaBearer, parseNativeToken } from './antigravity-native';
import { stepDiagnostic } from './diagnostics';
import { pendingAntigravityQuota, PendingQuotaConflict } from './temporary-credentials';

function readRecoveryOutput(directory: string): Buffer | undefined {
  const file = cliTokenPath(directory);
  try {
    for (const dir of [directory, path.join(directory, '.gemini'), path.dirname(file)]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o022)) throw new PendingQuotaConflict();
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o022) || stat.size > 1024 * 1024) throw new PendingQuotaConflict();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const actual = fs.fstatSync(fd);
      if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new PendingQuotaConflict();
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Only for credentials owned by AGS, while holding the identity and store locks. */
export function recoverAntigravityQuota(agent: AntigravityAgent, identity: string, original: Buffer, storage: {
  read: () => Buffer | null; write: (bytes: Buffer) => void;
  confirmCopies?: (output: Buffer, matchesInput: (bytes: Buffer) => boolean) => void;
}): { bytes: Buffer; pending: boolean; readOnly: boolean } {
  const input = parseNativeToken(original);
  try {
    const pending = pendingAntigravityQuota(identity, input.token.refresh_token, original);
    if (!pending) return { bytes: original, pending: false, readOnly: false };
    stepDiagnostic('recovery-found');
    // The authenticated Windows intent is sealed after the kernel job drains. An unsealed sandbox file
    // on that platform has no POSIX owner/mode evidence and cannot by itself authorize a pool write.
    const output = process.platform === 'win32' ? pending.savedOutput ?? (pending.alreadyStored ? original : undefined)
      : readRecoveryOutput(pending.directory) ?? pending.savedOutput;
    pending.checkOutput(output);
    if (pending.alreadyStored) stepDiagnostic('recovery-stored');
    let selected = original;
    let confirmed = true;
    if (pending.alreadyStored || !pending.launched) {
      // No child could have used the input, or the pool write completed before interruption.
      if ((output && !output.equals(original)) || (pending.alreadyStored && !output)) throw new PendingQuotaConflict();
    } else {
      if (!output) throw new PendingQuotaConflict(true, 'recovery-missing');
      if (output.equals(original) || agent.identityFromBytes(output)?.id !== identity) throw new PendingQuotaConflict();
      const next = parseNativeToken(output).token;
      if (next.refresh_token !== input.token.refresh_token) selected = output;
      else {
        // v1.0.1 only bound the refresh token. Its output must not replace a newer saved bearer.
        const order = compareNativeSessionCopies(output, original);
        if (!next.access_token || next.access_token === input.token.access_token || (!pending.exactInput && !order)) throw new PendingQuotaConflict();
        if (pending.exactInput || (order !== undefined && order > 0)) selected = output;
        // Without the old input bytes this may be the seed itself, left behind after a request.
        // It can supply a newer bearer, but cannot authorize reusing the same refresh token.
        confirmed = pending.exactInput;
      }
    }
    if (!confirmed && !findQuotaBearer(parseNativeToken(selected), [], false)) throw new PendingQuotaConflict();
    if (!storage.read()?.equals(original)) throw new Error('账号凭据已变化，已保留恢复副本');
    if (selected !== original) {
      if (confirmed) pending.beforeStore(selected);
      try {
        storage.write(selected);
        if (!storage.read()?.equals(selected)) throw new Error('未能确认账号凭据已安全写回，已保留恢复副本');
      } catch (error) { stepDiagnostic('storage-unavailable'); throw error; }
    }
    if (!confirmed) return { bytes: selected, pending: true, readOnly: true };
    if (pending.alreadyStored || selected !== original) {
      const successor = parseNativeToken(selected).token.refresh_token;
      storage.confirmCopies?.(selected, bytes => {
        if (agent.identityFromBytes(bytes)?.id !== identity) return false;
        const token = parseNativeToken(bytes).token.refresh_token;
        // Even differently formatted copies of a consumed grant must advance together.
        // A bearer-only update can only replace the exact input copy.
        return pending.matchesInput(bytes, token !== successor ? token : undefined);
      });
    }
    pending.finish();
    stepDiagnostic('recovery-complete');
    return { bytes: selected, pending: true, readOnly: false };
  } catch (error) {
    if (!(error instanceof PendingQuotaConflict)) throw error;
    stepDiagnostic('recovery-found');
    stepDiagnostic(error.diagnostic);
    // A valid bearer can still query quota without consuming the unconfirmed grant.
    if (findQuotaBearer(input, [], false)) return { bytes: original, pending: true, readOnly: true };
    throw error;
  }
}
