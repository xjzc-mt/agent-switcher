import { withStoreLock } from './store';
import { migrateCredentialPool } from './credential-vault';
import { reapTemporaryCredentials } from './temporary-credentials';

/** Run before GUI/CLI operations. A failed migration leaves each original intact. */
export async function maintainCredentialStorage() {
  return withStoreLock(async () => {
    const temporary = reapTemporaryCredentials();
    const { migrated } = migrateCredentialPool();
    return { migrated, retainedTemporary: temporary.retained.length };
  });
}
