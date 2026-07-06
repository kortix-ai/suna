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
 *   4. The `executor_connectors_credential_mode_shared_only` CHECK constraint
 *      rejects any future `per_user` write.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql, eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { projects, executorConnectors, executorCredentials } from '@kortix/db';

const CONN_SHARED_ALREADY = 'bbbbbbbb-1111-4000-8000-000000000001';
const CONN_PER_USER_WITH_SHARED = 'bbbbbbbb-1111-4000-8000-000000000002';
const CONN_PER_USER_NO_SHARED = 'bbbbbbbb-1111-4000-8000-000000000003';
const CONNECTOR_IDS = [CONN_SHARED_ALREADY, CONN_PER_USER_WITH_SHARED, CONN_PER_USER_NO_SHARED];

const CONSTRAINT_NAME = 'executor_connectors_credential_mode_shared_only';

let projectId = '';
let accountId = '';
let memberUserId = '';
let seeded = false;

/** Replays the migration's exact up-statements (idempotent — safe to re-run). */
async function runMigrationLogic(): Promise<void> {
  await db.execute(sql`
    delete from kortix.executor_credentials as ec
    using kortix.executor_connectors as conn
    where ec.connector_id = conn.connector_id
      and conn.credential_mode = 'per_user'
      and ec.user_id is not null
  `);
  await db.execute(sql`
    update kortix.executor_connectors
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
      ALTER TABLE kortix.executor_connectors
        ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (credential_mode = 'shared');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `));
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
  projectId = proj.project_id;
  accountId = proj.account_id;
  memberUserId = accountId; // any real uuid works as the "member" for this fixture

  // Transiently drop the CHECK constraint so we can seed `per_user` fixture rows
  // (the pre-migration state) — restored by the last test / afterAll below.
  await db.execute(sql.raw(`ALTER TABLE kortix.executor_connectors DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`));

  await db.insert(executorConnectors).values([
    {
      connectorId: CONN_SHARED_ALREADY,
      accountId,
      projectId,
      slug: 'migration-test-shared',
      name: 'Migration Test Shared',
      providerType: 'pipedream',
      credentialMode: 'shared',
    },
    {
      connectorId: CONN_PER_USER_WITH_SHARED,
      accountId,
      projectId,
      slug: 'migration-test-peruser-with-shared',
      name: 'Migration Test PerUser w/ shared',
      providerType: 'pipedream',
      credentialMode: 'per_user',
    },
    {
      connectorId: CONN_PER_USER_NO_SHARED,
      accountId,
      projectId,
      slug: 'migration-test-peruser-no-shared',
      name: 'Migration Test PerUser no shared',
      providerType: 'pipedream',
      credentialMode: 'per_user',
    },
  ]);

  await db.insert(executorCredentials).values([
    { connectorId: CONN_PER_USER_WITH_SHARED, userId: null, kind: 'connection', valueEnc: 'enc-shared' },
    { connectorId: CONN_PER_USER_WITH_SHARED, userId: memberUserId, kind: 'connection', valueEnc: 'enc-member-1' },
    { connectorId: CONN_PER_USER_NO_SHARED, userId: memberUserId, kind: 'connection', valueEnc: 'enc-member-2' },
  ]);
  seeded = true;
});

afterAll(async () => {
  if (!seeded) return;
  await db.delete(executorCredentials).where(inArray(executorCredentials.connectorId, CONNECTOR_IDS));
  await db.delete(executorConnectors).where(inArray(executorConnectors.connectorId, CONNECTOR_IDS));
  // Defensive: guarantee the constraint is back even if an assertion above threw
  // before the dedicated test restored it.
  await restoreCheckConstraint();
});

describe('per_user → shared credential-mode migration', () => {
  test('flips every per_user connector to shared, leaves already-shared connectors untouched', async () => {
    if (!seeded) return;
    await runMigrationLogic();
    const rows = await db
      .select({ connectorId: executorConnectors.connectorId, credentialMode: executorConnectors.credentialMode })
      .from(executorConnectors)
      .where(inArray(executorConnectors.connectorId, CONNECTOR_IDS));
    for (const row of rows) expect(row.credentialMode).toBe('shared');
  });

  test('no silent credential promotion: per-member rows are deleted, the shared row is preserved', async () => {
    if (!seeded) return;
    await runMigrationLogic();
    const remaining = await db
      .select({ connectorId: executorCredentials.connectorId, userId: executorCredentials.userId })
      .from(executorCredentials)
      .where(inArray(executorCredentials.connectorId, CONNECTOR_IDS));
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
      .select({ connectorId: executorCredentials.connectorId })
      .from(executorCredentials)
      .where(eq(executorCredentials.connectorId, CONN_PER_USER_NO_SHARED));
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
        sql`update kortix.executor_connectors set credential_mode = 'per_user' where connector_id = ${CONN_SHARED_ALREADY}::uuid`,
      );
    };
    await expect(attemptBadWrite()).rejects.toThrow();
    const [row] = await db
      .select({ credentialMode: executorConnectors.credentialMode })
      .from(executorConnectors)
      .where(eq(executorConnectors.connectorId, CONN_SHARED_ALREADY));
    expect(row?.credentialMode).toBe('shared');
  });
});
