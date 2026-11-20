import { withStoreLock } from './store';
import { migrateCredentialPool } from './credential-vault';
import { initializeTemporaryBoot, reapTemporaryCredentials } from './temporary-credentials';

/** Run before GUI/CLI operations. A failed migration leaves each original intact. */
export async function maintainCredentialStorage() {
  await initializeTemporaryBoot();
  return withStoreLock(async () => {
    const temporary = reapTemporaryCredentials();
    const { migrated, corrupted = [] } = migrateCredentialPool({ isolateFileErrors: true });
    return { migrated, corrupted: corrupted.length, retainedTemporary: temporary.retained.length };
  });
}
