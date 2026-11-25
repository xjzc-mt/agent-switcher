import type { BaseAgent, StatusResult } from './agents/base';
import { fingerprint, jwtInfo } from './utils';

export interface CredentialState { revision?: string; updatedAt?: number }

/** Only a digest leaves this module. Formatting and bookkeeping aren't a token generation. */
export function credentialState(agent: BaseAgent, dir = agent.homeDir): CredentialState {
  const files = Object.entries(agent.readCredentials(dir));
  return credentialStateFromFiles(agent.id, files);
}

export function credentialStateFromFiles(agentId: string, files: ReadonlyArray<readonly [string, Buffer | null]>): CredentialState {
  if (!files.some(([, data]) => data)) return {};
  if (agentId === 'agy') {
    try {
      const auth = JSON.parse(files[0][1]!.toString()), token = auth.token || auth;
      const updatedAt = Date.parse(token.expiry ?? auth.expiry);
      return { revision: fingerprint(JSON.stringify([auth.auth_method, auth.id_token_email, auth.id_token,
        token.id_token, token.access_token, token.refresh_token])), updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined };
    } catch { /* Invalid data still has its own revision. */ }
  }
  if (agentId === 'codex') {
    try {
      const auth = JSON.parse(files[0][1]!.toString());
      const tokens = auth.tokens || {};
      const material = [auth.auth_mode || 'chatgpt', auth.OPENAI_API_KEY || null,
        tokens.account_id, tokens.id_token, tokens.access_token, tokens.refresh_token, tokens.email];
      if (tokens.oauth_provenance || tokens.login_owner_id) {
        material.push(tokens.oauth_provenance?.issuer, tokens.oauth_provenance?.client_id, tokens.login_owner_id);
      }
      let updatedAt = Date.parse(auth.last_refresh);
      if (!Number.isFinite(updatedAt)) {
        updatedAt = Number(jwtInfo(tokens.access_token).iat) * 1000;
      }
      return { revision: fingerprint(JSON.stringify(material)), updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined };
    } catch { /* Malformed files still invalidate a previous snapshot. */ }
  }
  return { revision: fingerprint(JSON.stringify(files.map(([name, data]) => [name, data?.toString('base64') ?? null]))) };
}

export function credentialOrder(source: CredentialState, target: CredentialState, previousRevision?: string): 'same' | 'newer' | 'older' | 'unknown' {
  if (source.revision && source.revision === target.revision) return 'same';
  // This query demonstrably rotated the exact generation still held by the target.
  if (previousRevision && target.revision === previousRevision) return 'newer';
  if (source.updatedAt !== undefined && target.updatedAt !== undefined && source.updatedAt !== target.updatedAt) {
    return source.updatedAt > target.updatedAt ? 'newer' : 'older';
  }
  return 'unknown';
}

export function snapshotForCredentials(status: StatusResult | undefined, revision?: string): StatusResult | undefined {
  if (!status) return undefined;
  if (revision && status.credentialRevision === revision) {
    // Older official re-login snapshots copied the previous login's flag onto an unverified replacement.
    if (status.refreshConsumed && status.state !== 'expired') {
      return { ...status, refreshConsumed: undefined, consumedRefreshFingerprint: undefined };
    }
    return status;
  }
  // Keep useful quota history and its colors, but recheck this credential version.
  return { ...status, state: status.state === 'ok' ? 'ok' : 'unverified', authExpired: false,
    checkedAt: undefined, extra: undefined, authFailure: undefined, refreshConsumed: undefined, consumedRefreshFingerprint: undefined, refreshFailures: undefined,
    creditActivity: undefined, credentialRevision: revision };
}

export class CredentialChangedError extends Error {
  constructor() { super('查询期间登录凭据已更新，请重试'); }
}

export class QuotaBearerRejected extends Error {}
export class LiveWriteDeferred extends Error {}
