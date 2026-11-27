import path from 'path';
import { parseJsonBytes, readBuffer, replaceFiles } from '../utils';
import { profileDir } from '../store';
import { credentialState, credentialStateFromFiles, CredentialChangedError } from '../credential-state';
import { releaseTemporaryCredentials } from '../temporary-credentials';

export interface SaveResult { ok: boolean; files: string[]; warnings: string[] }
export type UseResult = SaveResult;
export interface QuotaWindow { usedPercent: number; windowMins?: number; resetsAt?: number }
export interface ResetCredit {
  id: string; resetType: string; status: string; grantedAt?: number;
  expiresAt?: number | null; title?: string; description?: string;
}
export interface QuotaDetail {
  plan?: string;
  primaryWindow?: QuotaWindow;
  secondaryWindow?: QuotaWindow;
  credits?: { balance?: string; unlimited?: boolean; hasCredits?: boolean };
  resetCredits?: { availableCount: number; credits: ResetCredit[] | null };
  buckets?: Array<{ id: string; label: string; windows: QuotaWindow[] }>;
}
export type QueryState = 'ok' | 'error' | 'expired' | 'unsupported' | 'unverified' | 'signed-out';
export interface StatusResult {
  available: boolean;
  account?: string;
  plan?: string;
  extra?: string;
  quota?: QuotaDetail;
  authExpired?: boolean;
  refreshConsumed?: true;
  consumedRefreshFingerprint?: string;
  state?: QueryState;
  checkedAt?: string;
  refreshFailures?: number;
  spareActivity?: { activeRounds: number; unchangedRounds: number };
  fetchedAt?: string;
  creditActivity?: { lastDecreaseAt: string; previousBalance: string; currentBalance: string };
  credentialRevision?: string;
  stagedReplacement?: boolean;
  authFailure?: 'refresh-revoked' | 'refresh-reused' | 'refresh-expired' | 'refresh-invalid' | 'authentication-rejected' | 'account-unavailable' | 'quota-recovery-required';
}
export interface Identity { id: string; email?: string }
export type CredentialFiles = Record<string, Buffer | null>;
export interface AuxiliaryCredential { identity: Identity; files: Record<string, Buffer | null> }
export type CredentialTracker = <T>(work: () => Promise<T>) => Promise<T>;
export interface QueryOptions {
  expectedEmail?: string; allowRefresh?: boolean; renewRejectedBearer?: boolean; verifyTarget?: Buffer | null;
  quotaCopies?: Buffer[]; allowUndatedBearer?: boolean; reportRejectedBearer?: boolean; withSharedRenewal?: CredentialTracker;
}
export interface CredentialQuery { status: StatusResult; rotated?: Buffer; temporaryDirectory?: string; verifiedReplacement?: boolean; waitingForClient?: boolean }
export interface LiveMutationJournal {
  hasMutations(): boolean;
  beginWrite?(appliedRevision?: string): void;
  markWriteCompleted?(): void;
  commitPrepared?(): void;
  finish?(): void;
  restore(): void;
}
export interface UseOptions {
  expectedSwitchFingerprint?: string;
  allowFileMigration?: boolean;
  journal?: LiveMutationJournal;
}
export interface AntigravityCliStatus {
  state: 'ready' | 'missing' | 'outdated' | 'unverified';
  version?: string;
}
export interface AccountManagement {
  cliStatus?: AntigravityCliStatus;
  quota: boolean;
  storage: 'file' | 'keychain' | 'unified' | 'unknown';
  canSaveCurrent: boolean;
  isolatedLogin?: boolean;
  notice?: string;
  loginLabel?: string;
  loginHint?: string;
}

export interface SharedQuotaLogin {
  readonly clientOwnsRenewal: boolean;
  /** A desktop-only observation is usable for quota, never for mutations. */
  normalizeQuotaHistory(snapshot: StatusResult): StatusResult;
  desktopLogin(): Buffer | undefined;
  confirmDesktopLogin(expected: Buffer, copies?: Buffer[]): Buffer;
  quotaBearer(bytes: Buffer, copies?: Buffer[], allowUndated?: boolean): { expiry?: string } | undefined;
  ownsQuotaLogin(bytes: Buffer): boolean;
  recoverProfileCredential(dir: string, identity: string, original: Buffer, preview?: boolean): { bytes: Buffer; pending: boolean; readOnly: boolean };
}

export abstract class BaseAgent {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly homeDir: string;
  abstract readonly authFiles: string[];
  abstract identityFromAuth(auth: object | null, live?: boolean): Identity | undefined;
  identityFromBytes(bytes: Buffer | null, live = false): Identity | undefined {
    return this.identityFromAuth(parseJsonBytes<object>(bytes), live);
  }
  identity(dir = this.homeDir, files?: CredentialFiles): Identity | undefined {
    return this.identityFromBytes((files ?? this.readCredentials(dir))[this.authFiles[0]], dir === this.homeDir);
  }
  adoptRecoveredQuota?(output: Buffer): void;
  canRecoverQuotaRotation?(original: Buffer, output: Buffer, registeredEmail?: string): boolean;
  queryCredential?(original: Buffer | null, options?: QueryOptions): Promise<CredentialQuery>;
  // The caller holds the store lock; adapters own file/Keychain writes.
  commitQuery(dir: string, revision: string | undefined, query: CredentialQuery): StatusResult {
    if (credentialState(this, dir).revision !== revision) throw new CredentialChangedError();
    if (query.rotated) {
      const file = this.authFiles[0];
      this.writeCredentials(dir, { [file]: query.rotated });
      revision = credentialStateFromFiles(this.id, [[file, query.rotated]]).revision;
    }
    if (query.temporaryDirectory) releaseTemporaryCredentials(query.temporaryDirectory);
    return { ...query.status, credentialRevision: revision };
  }
  get sharedQuotaLogin(): SharedQuotaLogin | undefined { return undefined; }
  get usesCredentialRevisions(): boolean { return !!this.sharedQuotaLogin; }
  readonly bindsQuotaEmail: boolean = false;
  abstract sharedSessionIssue(): Promise<string | undefined>;
  abstract clientLogoutIssue(): string | undefined;
  assertSwitchSessions?(): Promise<void>;
  retryCredentialAccess?(): void;
  hasInterruptedSwitch?(): boolean;
  needsFileMigration?(bytes: Buffer | null): boolean;
  compareSessionCopies?(a: Buffer | null, b: Buffer | null): number | undefined;
  writeRenewedCredentials?(files: CredentialFiles, expectedRevision?: string): Promise<void>;
  readClientCopies(): Array<Buffer | null> {
    const file = this.authFiles[0];
    return [this.readCredentials()[file], ...this.auxiliaryCredentials(true).map(copy => copy.files[file])];
  }
  switchSupport(): string | undefined { return undefined; }
  abstract management(): AccountManagement;
  credentialStatus(dir = this.homeDir): StatusResult {
    const identity = this.identity(dir);
    return { available: !!identity, account: identity?.email, state: identity ? 'unverified' : 'signed-out' };
  }

  readCredentials(dir = this.homeDir, _quotaCopies?: Buffer[]): Record<string, Buffer | null> {
    return Object.fromEntries(this.authFiles.map(file => [file, readBuffer(path.join(dir, file))]));
  }
  readSwitchableCredentials(): { files: Record<string, Buffer | null>; corrupted?: boolean } {
    return { files: this.readCredentials() };
  }
  hasPendingSwitchCleanup(): boolean { return false; }
  recoverInterruptedSwitch?(): Promise<void> | void;
  switchFingerprint(): string | undefined { return undefined; }
  canVerifyReplacement(_targetBytes: Buffer | null): boolean { return false; }
  createMutationJournal(): LiveMutationJournal {
    let mutated = false, completed = false, wasCorrupted = false;
    let previous: Record<string, Buffer | null> = {};
    let preRevision: string | undefined, appliedRevision: string | undefined;
    return {
      hasMutations: () => mutated,
      beginWrite: (targetRevision?: string) => {
        const snap = this.readSwitchableCredentials();
        previous = snap.files;
        wasCorrupted = snap.corrupted === true;
        preRevision = wasCorrupted ? undefined : credentialStateFromFiles(this.id, Object.entries(previous)).revision;
        appliedRevision = targetRevision;
        mutated = true;
      },
      markWriteCompleted: () => { completed = true; },
      restore: () => {
        if (!mutated) return;
        const { files, corrupted: currentCorrupted } = this.readSwitchableCredentials();
        const currentRevision = currentCorrupted ? undefined : credentialStateFromFiles(this.id, Object.entries(files)).revision;
        if (!currentCorrupted && !wasCorrupted && currentRevision === preRevision) return;
        if (completed) {
          if (!currentCorrupted && currentRevision !== appliedRevision) return;
        } else if (!currentCorrupted && appliedRevision !== undefined && currentRevision !== undefined &&
            currentRevision !== appliedRevision && currentRevision !== preRevision) {
          return;
        }
        this.writeCredentials(this.homeDir, previous);
        if (!wasCorrupted && credentialState(this).revision !== preRevision) throw new Error('本地凭据未能恢复原状');
      },
    };
  }
  auxiliaryCredentials(_requireAllReadable = false): AuxiliaryCredential[] { return []; }
  writeCredentials(dir: string, files: Record<string, Buffer | null>): void { replaceFiles(dir, files); }

  credentials(dir: string, files = this.readCredentials(dir)): CredentialFiles {
    if (!this.identity(dir, files)) throw new Error(`${this.label} 没有可用的认证凭据`);
    return files;
  }

  async save(name: string, source = this.homeDir, captured?: CredentialFiles): Promise<SaveResult> {
    if (source === this.homeDir && !this.management().canSaveCurrent) throw new Error(this.switchSupport() || '当前客户端登录不能保存为文件凭据');
    const files = this.credentials(source, captured);
    this.writeCredentials(profileDir(this.id, name), files);
    return { ok: true, files: Object.keys(files).filter(f => files[f]), warnings: [] };
  }

  async use(name: string, options: UseOptions = {}): Promise<UseResult> {
    const unsupported = this.switchSupport();
    if (unsupported) throw new Error(unsupported);
    const target = profileDir(this.id, name);
    const files = this.credentials(target);
    const fingerprint = options.expectedSwitchFingerprint && this.switchFingerprint();
    if (fingerprint && fingerprint !== options.expectedSwitchFingerprint) {
      throw new Error('确认期间当前凭据已变化，未执行切换，请重新核对');
    }
    return this.commitSwitch(files, options, () => this.writeCredentials(this.homeDir, files));
  }

  protected commitSwitch(files: CredentialFiles, options: UseOptions, write: () => void | string): UseResult {
    options.journal?.beginWrite?.(credentialStateFromFiles(this.id, Object.entries(files)).revision);
    const detail = write();
    options.journal?.markWriteCompleted?.();
    const warnings = ['已更新本地凭据；已打开的终端会话需要重新启动。'];
    if (detail) warnings.push(detail);
    return { ok: true, files: Object.keys(files).filter(file => files[file]), warnings };
  }
}
