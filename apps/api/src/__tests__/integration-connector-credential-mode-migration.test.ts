/**
 * Integration test (real local DB): the `per_user` → `shared` credential-mode
 * removal migration (packages/db/migrations/20260705191549103_remove_per_user_
 * credential_mode.sql, docs/specs/2026-07-05-agent-first-config-unification.md
 * §2.5). The migration itself already ran on every environment (immutable —
 * never re-applied), so this replays its exact DELETE+UPDATE statements against
 * freshly seeded fixture rows to prove the data-safety properties hold:
 *
 *   1. NO SILENT CREDENTIAL PROMOTION — a per-member credential row is deleted,
 *      never becomes the shared one.
 *   2. An existing shared (userId-null) row is left untouched.
 *   3. Every `per_user` connector flips to `shared`.
 *   4. The `connectors_credential_mode_shared_only` CHECK constraint
 *      rejects any future `per_user` write.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql, eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { connectors, connectionCredentials } from '@kortix/db';

const CONN_SHARED_ALREADY = crypto.randomUUID();
const CONN_PER_USER_WITH_SHARED = crypto.randomUUID();
const CONN_PER_USER_NO_SHARED = crypto.randomUUID();
const CONNECTOR_IDS = [CONN_SHARED_ALREADY, CONN_PER_USER_WITH_SHARED, CONN_PER_USER_NO_SHARED];

const CONSTRAINT_NAME = 'connectors_credential_mode_shared_only';
const LEGACY_CREDENTIAL_INDEX = 'idx_connection_credentials_legacy_connector_unique';

let workspaceId = '';
let accountId = '';
let memberUserId = '';
let seeded = false;

/** Replays the migration's exact up-statements (idempotent — safe to re-run). */
async function runMigrationLogic(): Promise<void> {
  await db.execute(sql`
    delete from kortix.connection_credentials as ec
    using kortix.connectors as conn
    where ec.connector_id = conn.connector_id
      and conn.credential_mode = 'per_user'
      and ec.user_id is not null
  `);
  await db.execute(sql`
    update kortix.connectors
    set credential_mode = 'shared'
    where credential_mode = 'per_user'
  `);
}

/** Idempotent add-back — the constraint already exists in every real environment
 *  (this migration applied it); dropped only transiently below so this test can
 *  seed pre-migration `per_user` fixture rows the constraint would otherwise reject. */
async function restoreCheckConstraint(): Promise<void> {
  await db.execute(sql.raw(`
    DO $$ BEGIN
      ALTER TABLE kortix.connectors
        ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (credential_mode = 'shared');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `));
}

async function restoreLegacyCredentialIndex(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${LEGACY_CREDENTIAL_INDEX}
      ON kortix.connection_credentials (connector_id)
      WHERE connection_id IS NULL;
  `));
}

async function cleanupFixture(): Promise<void> {
  await db.delete(connectionCredentials).where(inArray(connectionCredentials.connectorId, CONNECTOR_IDS));
  await db.delete(connectors).where(inArray(connectors.connectorId, CONNECTOR_IDS));
}

async function restoreSchemaGuards(): Promise<void> {
  // A failed setup can leave a fixture connector in the historical state. Run
  // the idempotent migration logic before restoring the production guards.
  await runMigrationLogic();
  await restoreCheckConstraint();
  await restoreLegacyCredentialIndex();
}

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  const proj = rows[0];
  if (!proj) {
    console.warn('[integration] no project in local DB — skipping credential-mode migration test');
    return;
  }
  workspaceId = proj.project_id;
  accountId = proj.account_id;
  memberUserId = accountId; // any real uuid works as the "member" for this fixture

  // Remove remnants for the current fixture IDs before seeding so repeated
  // execution in the same process remains deterministic.
  await cleanupFixture();

  try {
    // Transiently drop both production guards so the fixture can recreate the
    // historical state. The legacy index rejects its shared/member row pair
    // because both rows have connection_id=NULL.
    await db.execute(sql.raw(`ALTER TABLE kortix.connectors DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`));
    await db.execute(sql.raw(`DROP INDEX IF EXISTS kortix.${LEGACY_CREDENTIAL_INDEX}`));

    await db.insert(connectors).values([
      {
        connectorId: CONN_SHARED_ALREADY,
        accountId,
        workspaceId,
        slug: 'migration-test-shared',
        name: 'Migration Test Shared',
        providerType: 'pipedream',
        credentialMode: 'shared',
      },
      {
        connectorId: CONN_PER_USER_WITH_SHARED,
        accountId,
        workspaceId,
        slug: 'migration-test-peruser-with-shared',
        name: 'Migration Test PerUser w/ shared',
        providerType: 'pipedream',
        credentialMode: 'per_user',
      },
      {
        connectorId: CONN_PER_USER_NO_SHARED,
        accountId,
        workspaceId,
        slug: 'migration-test-peruser-no-shared',
        name: 'Migration Test PerUser no shared',
        providerType: 'pipedream',
        credentialMode: 'per_user',
      },
    ]);

    await db.insert(connectionCredentials).values([
      { connectorId: CONN_PER_USER_WITH_SHARED, userId: null, kind: 'connection', valueEnc: 'enc-shared' },
      { connectorId: CONN_PER_USER_WITH_SHARED, userId: memberUserId, kind: 'connection', valueEnc: 'enc-member-1' },
      { connectorId: CONN_PER_USER_NO_SHARED, userId: memberUserId, kind: 'connection', valueEnc: 'enc-member-2' },
    ]);
    seeded = true;
  } catch (error) {
    try {
      await cleanupFixture();
    } finally {
      await restoreSchemaGuards();
    }
    throw error;
  }
});

afterAll(async () => {
  try {
    await cleanupFixture();
  } finally {
    // Restore both production guards even when setup or an assertion fails.
    await restoreSchemaGuards();
  }
});

describe('per_user → shared credential-mode migration', () => {
  test('flips every per_user connector to shared, leaves already-shared connectors untouched', async () => {
    if (!seeded) return;
    await runMigrationLogic();
    const rows = await db
      .select({ connectorId: connectors.connectorId, credentialMode: connectors.credentialMode })
      .from(connectors)
      .where(inArray(connectors.connectorId, CONNECTOR_IDS));
    for (const row of rows) expect(row.credentialMode).toBe('shared');
  });

  test('no silent credential promotion: per-member rows are deleted, the shared row is preserved', async () => {
    if (!seeded) return;
    await runMigrationLogic();
    const remaining = await db
      .select({ connectorId: connectionCredentials.connectorId, userId: connectionCredentials.userId })
      .from(connectionCredentials)
      .where(inArray(connectionCredentials.connectorId, CONNECTOR_IDS));
    // The shared (userId-null) row on CONN_PER_USER_WITH_SHARED survives...
    expect(remaining).toContainEqual({ connectorId: CONN_PER_USER_WITH_SHARED, userId: null });
    // ...but every per-member row (userId set) is gone, on both connectors.
    expect(remaining.some((r) => r.userId !== null)).toBe(false);
    expect(remaining).toHaveLength(1);
  });

  test('a connector with no shared row ends up with zero credentials (reconnect required)', async () => {
    if (!seeded) return;
    await runMigrationLogic();
    const remaining = await db
      .select({ connectorId: connectionCredentials.connectorId })
      .from(connectionCredentials)
      .where(eq(connectionCredentials.connectorId, CONN_PER_USER_NO_SHARED));
    expect(remaining).toHaveLength(0);
  });

  test('the CHECK constraint rejects writing per_user back', async () => {
    if (!seeded) return;
    // By now every fixture row is `shared` (prior tests already ran the
    // migration logic), so re-adding the constraint here cannot fail on an
    // existing violation.
    await restoreCheckConstraint();
    const attemptBadWrite = async () => {
      await db.execute(
        sql`update kortix.connectors set credential_mode = 'per_user' where connector_id = ${CONN_SHARED_ALREADY}::uuid`,
      );
    };
    await expect(attemptBadWrite()).rejects.toThrow();
    const [row] = await db
      .select({ credentialMode: connectors.credentialMode })
      .from(connectors)
      .where(eq(connectors.connectorId, CONN_SHARED_ALREADY));
    expect(row?.credentialMode).toBe('shared');
  });
});
