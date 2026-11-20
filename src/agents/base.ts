import path from 'path';
import { readBuffer, replaceFiles } from '../utils';
import { profileDir, withStoreLock } from '../store';
import { credentialState, credentialStateFromFiles, CredentialChangedError } from '../credential-state';
import { assertCredentialWriteReady } from '../credential-vault';
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
  authMethod?: string;
  state?: QueryState;
  checkedAt?: string;
  refreshFailures?: number;
  fetchedAt?: string;
  creditActivity?: { lastDecreaseAt: string; previousBalance: string; currentBalance: string };
  credentialRevision?: string;
  stagedReplacement?: boolean;
  authFailure?: 'refresh-revoked' | 'refresh-reused' | 'refresh-expired' | 'refresh-invalid' | 'authentication-rejected' | 'account-unavailable';
}
export interface Identity { id: string; email?: string }
export type CredentialFiles = Record<string, Buffer | null>;
export interface AuxiliaryCredential { identity: Identity; files: Record<string, Buffer | null> }
export interface QueryOptions { expectedEmail?: string; allowRefresh?: boolean; verifyTarget?: Buffer | null }
export interface CredentialQuery { status: StatusResult; rotated?: Buffer; temporaryDirectory?: string; verifiedReplacement?: boolean }
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
export interface AccountManagement {
  quota: boolean;
  storage: 'file' | 'keychain' | 'unified' | 'unknown';
  canSaveCurrent: boolean;
  isolatedLogin?: boolean;
  notice?: string;
  loginLabel?: string;
  loginHint?: string;
}

export abstract class BaseAgent {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly homeDir: string;
  abstract readonly authFiles: string[];
  abstract identityFromAuth(auth: object | null, live?: boolean): Identity | undefined;
  identityFromBytes(bytes: Buffer | null, live = false): Identity | undefined {
    let auth = null;
    try { if (bytes) auth = JSON.parse(bytes.toString()); } catch { return undefined; }
    return this.identityFromAuth(auth, live);
  }
  identity(dir = this.homeDir, files?: CredentialFiles): Identity | undefined {
    return this.identityFromBytes((files ?? this.readCredentials(dir))[this.authFiles[0]], dir === this.homeDir);
  }
  queryCredential?(original: Buffer | null, options?: QueryOptions): Promise<CredentialQuery>;
  async status(dir = this.homeDir): Promise<StatusResult> {
    if (!this.queryCredential) return this.credentialStatus(dir);
    const file = this.authFiles[0], original = this.readCredentials(dir)[file];
    const { revision } = credentialStateFromFiles(this.id, [[file, original]]);
    assertCredentialWriteReady(path.join(dir, file));
    const query = await this.queryCredential(original);
    try { return await withStoreLock(async () => this.commitQuery(dir, revision, query)); }
    catch (error) {
      if (query.temporaryDirectory && error instanceof Error) {
        error.message += `；未写回的凭据已保留在 ${query.temporaryDirectory}，恢复前请勿清理该目录`;
      }
      throw error;
    }
  }
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
  switchSupport(): string | undefined { return undefined; }
  management(): AccountManagement { return { quota: this.id === 'codex', storage: 'file', canSaveCurrent: true, isolatedLogin: this.id === 'codex' }; }
  credentialStatus(dir = this.homeDir): StatusResult {
    const identity = this.identity(dir);
    return { available: !!identity, account: identity?.email, state: identity ? 'unverified' : 'signed-out' };
  }
  displayStatus(): StatusResult { return this.credentialStatus(); }

  readCredentials(dir = this.homeDir): Record<string, Buffer | null> {
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
        let currentFiles: Record<string, Buffer | null> | undefined;
        let currentCorrupted = false;
        try { currentFiles = this.readCredentials(); }
        catch (error) {
          const snap = this.readSwitchableCredentials();
          currentFiles = snap.files;
          currentCorrupted = snap.corrupted === true;
          if (!currentCorrupted) throw error;
        }
        const currentRevision = currentCorrupted ? undefined : credentialStateFromFiles(this.id, Object.entries(currentFiles!)).revision;
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
  auxiliaryCredentials(): AuxiliaryCredential[] { return []; }
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
    if (options.expectedSwitchFingerprint && this.switchFingerprint() && this.switchFingerprint() !== options.expectedSwitchFingerprint) {
      throw new Error('确认期间当前凭据已变化，未执行切换，请重新核对');
    }
    options.journal?.beginWrite?.(credentialStateFromFiles(this.id, Object.entries(files)).revision);
    this.writeCredentials(this.homeDir, files);
    options.journal?.markWriteCompleted?.();
    return { ok: true, files: Object.keys(files).filter(f => files[f]), warnings: ['已更新本地凭据；已打开的终端会话需要重新启动。'] };
  }
}
