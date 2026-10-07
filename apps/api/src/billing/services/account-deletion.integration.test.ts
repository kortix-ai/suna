// Account deletion on PostgreSQL: `deleteAccountImmediately` removes the
// account row — whose foreign-key cascade takes every FK'd table — and sweeps
// the tables the cascade cannot reach (no FK to `accounts`, or a non-cascading
// FK edge that would abort the cascade). Nothing account-scoped survives
// except the records the code retains on purpose: the audit trail and the
// financial records.
import { describe, expect, mock, test } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import * as realProviders from '../../platform/providers';
import { db } from '../../shared/db';

const deletedUsers: string[] = [];

// The service's external seams are mocked; the database is real. Spread the
// real module: `mock.module` replaces it WHOLESALE, so a stub that lists
// exports by hand deletes every export it omits.
import * as realSupabase from '../../shared/supabase';
mock.module('../../shared/supabase', () => ({
  ...realSupabase,
  getSupabase: () => ({
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          deletedUsers.push(id);
          return { error: null };
        },
      },
    },
  }),
}));
mock.module('../../shared/stripe', () => ({
  getStripe: () => ({ subscriptions: { cancel: async () => undefined } }),
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits.
mock.module('../../platform/providers', () => ({
  ...realProviders,
  tryGetProvider: () => null,
}));

const { deleteAccountImmediately } = await import('./account-deletion');

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const USER_ID = '22222222-2222-4222-8222-222222222222';
// The user's personal account: its id is the user id, so deleting it also
// deletes the user's login.
const ACCOUNT_ID = USER_ID;
const OTHER_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = 'del-test-session';
const SANDBOX_ID = '66666666-6666-4666-8666-666666666666';
const CONNECTOR_ID = '77777777-7777-4777-8777-777777777777';
const APP_ID = '88888888-8888-4888-8888-888888888888';
const ARTIFACT_ID = '99999999-9999-4999-8999-999999999999';

// Records the deletion retains on purpose (see deleteAccountData): the audit
// trail and the financial records outlive the account, matching
// `performDeletion`'s `payment_status='deleted'` marker. prompt_attachments and
// connector_attachments stay with their existing TTL sweeps.
const RETAINED = new Set([
  'audit_events',
  'audit_events_default',
  'audit_events_legacy',
  'audit_reconciliation_state',
  'billing_customers',
  'credit_accounts',
  'credit_ledger',
  'credit_purchases',
  'credit_usage',
  'prompt_attachments',
  'connector_attachments',
  // SQL-only baseline table with no reader or writer (schema-contract
  // sql-only list, a documented drop candidate) — no drizzle export, no rows.
  'warm_pool_presence',
]);

async function seed(): Promise<void> {
  const statements = [
    sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}, 'deletion-test')`,
    // The cascade core: membership, project, session, sandbox row.
    sql`INSERT INTO kortix.account_memberships (user_id, account_id) VALUES (${USER_ID}, ${ACCOUNT_ID})`,
    sql`INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
      VALUES (${PROJECT_ID}, ${ACCOUNT_ID}, 'deletion-test-project', 'https://example.test/repo.git')`,
    sql`INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
      VALUES (${SESSION_ID}, ${ACCOUNT_ID}, ${PROJECT_ID}, 'main', 'running')`,
    // A neighboring account that must survive untouched.
    sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${OTHER_ACCOUNT_ID}, 'deletion-other')`,
    sql`INSERT INTO kortix.account_memberships (user_id, account_id) VALUES (${OTHER_USER_ID}, ${OTHER_ACCOUNT_ID})`,
    // Live credentials the cascade cannot reach: a kortix_ API key.
    sql`INSERT INTO kortix.api_keys (sandbox_id, account_id, public_key, secret_key_hash, title)
      VALUES (${SANDBOX_ID}, ${ACCOUNT_ID}, 'deletion-test-public', 'deletion-test-hash', 'deletion-test')`,
    // Sandbox-plane orphans.
    sql`INSERT INTO kortix.sandboxes (sandbox_id, account_id, name, base_url)
      VALUES (${SANDBOX_ID}, ${ACCOUNT_ID}, 'deletion-test-box', 'https://example.test/box')`,
    sql`INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id)
      VALUES (${SANDBOX_ID}, ${SESSION_ID}, ${ACCOUNT_ID}, ${PROJECT_ID})`,
    sql`INSERT INTO kortix.session_turns (turn_token, session_id, sandbox_id, project_id, account_id)
      VALUES ('del-test-turn', ${SESSION_ID}, ${SANDBOX_ID}, ${PROJECT_ID}, ${ACCOUNT_ID})`,
    sql`INSERT INTO kortix.session_pending_questions (account_id, project_id, session_id, request_id, questions)
      VALUES (${ACCOUNT_ID}, ${PROJECT_ID}, ${SESSION_ID}, 'del-test-request', '[]'::jsonb)`,
    sql`INSERT INTO kortix.provider_events (account_id, provider, kind, outcome)
      VALUES (${ACCOUNT_ID}, 'daytona', 'deleted', 'ok')`,
    sql`INSERT INTO kortix.legacy_sandbox_migrations (run_id, sandbox_id, account_id)
      VALUES ('del-test-run', ${SANDBOX_ID}, ${ACCOUNT_ID})`,
    sql`INSERT INTO kortix.suna_account_migrations (run_id, account_id)
      VALUES ('del-test-run', ${ACCOUNT_ID})`,
    sql`INSERT INTO kortix.sandbox_compute_sessions (account_id, sandbox_id, cpu_cores, memory_gb, disk_gb)
      VALUES (${ACCOUNT_ID}, ${SANDBOX_ID}, 1, 2, 10)`,
    // Tunnel-plane orphans (device auth and audit log before the connection).
    sql`INSERT INTO kortix.tunnel_connections (tunnel_id, account_id, name)
      VALUES (${SANDBOX_ID}, ${ACCOUNT_ID}, 'deletion-tunnel')`,
    sql`INSERT INTO kortix.tunnel_audit_logs (tunnel_id, account_id, capability, operation, success)
      VALUES (${SANDBOX_ID}, ${ACCOUNT_ID}, 'shell', 'open', true)`,
    sql`INSERT INTO kortix.tunnel_device_auth_requests (device_code, device_secret_hash, account_id, expires_at)
      VALUES ('del-dev1', 'del-test-hash', ${ACCOUNT_ID}, now() + interval '1 hour')`,
    // Connector plane: connector -> connection -> calls + bindings. The
    // bindings RESTRICT the connector and connection deletes; the calls
    // NO-ACTION the connection delete - exactly the edges that abort a bare
    // accounts-row cascade.
    sql`INSERT INTO kortix.connectors (connector_id, account_id, project_id, slug, name, provider_type)
      VALUES (${CONNECTOR_ID}, ${ACCOUNT_ID}, ${PROJECT_ID}, 'deletion-connector', 'Deletion Connector', 'composio')`,
    sql`INSERT INTO kortix.connector_connections (connection_id, account_id, project_id, connector_id, label)
      VALUES (${SANDBOX_ID}, ${ACCOUNT_ID}, ${PROJECT_ID}, ${CONNECTOR_ID}, 'deletion-connection')`,
    sql`INSERT INTO kortix.connector_calls (account_id, project_id, action_path, status)
      VALUES (${ACCOUNT_ID}, ${PROJECT_ID}, '/deletion/action', 'ok')`,
    sql`INSERT INTO kortix.project_session_connector_bindings
      (session_id, account_id, project_id, connector_alias, connector_id, connection_id)
      VALUES (${SESSION_ID}, ${ACCOUNT_ID}, ${PROJECT_ID}, 'deletion-connector', ${CONNECTOR_ID}, ${SANDBOX_ID})`,
    // The apps subtree: artifact -> app -> deployment -> events + runtime.
    sql`INSERT INTO kortix.app_artifacts (artifact_id, account_id, project_id, kind)
      VALUES (${ARTIFACT_ID}, ${ACCOUNT_ID}, ${PROJECT_ID}, 'archive')`,
    sql`INSERT INTO kortix.apps (app_id, account_id, project_id, slug, name, route_key)
      VALUES (${APP_ID}, ${ACCOUNT_ID}, ${PROJECT_ID}, 'deletion-app', 'Deletion App', 'deletion-app')`,
    sql`INSERT INTO kortix.app_deployments (deployment_id, app_id, artifact_id, version, source_kind, runtime_version, created_by)
      VALUES (${SANDBOX_ID}, ${APP_ID}, ${ARTIFACT_ID}, 1, 'static', 'v1', ${USER_ID})`,
    sql`INSERT INTO kortix.app_deployment_events (deployment_id, type, message)
      VALUES (${SANDBOX_ID}, 'built', 'deletion-test event')`,
    sql`INSERT INTO kortix.app_runtimes (deployment_id, account_id, provider, external_id, control_token_hash)
      VALUES (${SANDBOX_ID}, ${ACCOUNT_ID}, 'platinum', 'del-test-external', 'del-test-hash')`,
    // Project-plane children with NO ACTION edges into project sessions.
    sql`INSERT INTO kortix.change_requests (account_id, project_id, number, title, base_ref, head_ref, created_by)
      VALUES (${ACCOUNT_ID}, ${PROJECT_ID}, 1, 'deletion-test', 'base', 'head', ${USER_ID})`,
    sql`INSERT INTO kortix.gateway_request_logs
      (request_id, account_id, requested_model, resolved_model, provider, status, ok)
      VALUES ('del-test-req', ${ACCOUNT_ID}, 'model-a', 'model-a', 'gateway', 200, true)`,
    sql`INSERT INTO kortix.session_lifecycle_commands (command_type, source, project_id, account_id)
      VALUES ('rewind', 'api', ${PROJECT_ID}, ${ACCOUNT_ID})`,
    sql`INSERT INTO kortix.usage_events (account_id, provider, model, route)
      VALUES (${ACCOUNT_ID}, 'gateway', 'model-a', 'chat')`,
    sql`INSERT INTO kortix.review_items (account_id, project_id, kind, title, created_by)
      VALUES (${ACCOUNT_ID}, ${PROJECT_ID}, 'change', 'deletion-test', ${USER_ID})`,
    sql`INSERT INTO kortix.project_trigger_executions
      (execution_id, project_id, slug, schedule_revision, scheduled_for, spec, payload)
      VALUES (${SANDBOX_ID}, ${PROJECT_ID}, 'del-test-trigger', 'r1', now(), '{}'::jsonb, '{}'::jsonb)`,
    sql`INSERT INTO kortix.project_trigger_runtime (project_id, slug)
      VALUES (${PROJECT_ID}, 'del-test-trigger')`,
    // Admin-plane orphans.
    sql`INSERT INTO kortix.platform_user_roles (account_id, role) VALUES (${ACCOUNT_ID}, 'user')`,
    sql`INSERT INTO kortix.impersonation_grants (admin_user_id, target_account_id, expires_at)
      VALUES (${USER_ID}, ${ACCOUNT_ID}, now() + interval '1 hour')`,
    // The pending deletion request row itself.
    sql`INSERT INTO kortix.account_deletion_requests (account_id, user_id, scheduled_for, status)
      VALUES (${ACCOUNT_ID}, ${USER_ID}, now() + interval '14 days', 'pending')`,
    // Retained on purpose: the audit trail and the financial records.
    sql`INSERT INTO kortix.audit_events (account_id, action, resource_type, actor_user_id)
      VALUES (${ACCOUNT_ID}, 'account.deleted.test', 'account', ${USER_ID})`,
    sql`INSERT INTO kortix.credit_accounts (account_id, tier, payment_status, balance) VALUES (${ACCOUNT_ID}, 'free', 'active', 5)`,
    sql`INSERT INTO kortix.billing_customers (account_id, id, provider) VALUES (${ACCOUNT_ID}, 'cus_deletion_test', 'stripe')`,
  ];
  for (const statement of statements) await db.execute(statement);
}

if (confirmed) {
  await seed();
}

/**
 * Every base table in the `kortix` schema that carries an `account_id` column
 * still holds a row for the deleted account? The scan is schema-driven, not a
 * hand list, so a table added tomorrow without a sweep entry fails here.
 */
/** `db.execute` returns postgres.js's RowList — array-like, no `.rows`. */
async function rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
  return Array.from((await db.execute<T>(query)) as unknown as T[]);
}

async function countWhere(table: string, predicate: SQL): Promise<number> {
  const [row] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM kortix.${sql.identifier(table)} WHERE ${predicate}`,
  );
  return row?.n ?? 0;
}

async function accountScopedTablesWithRows(accountId: string): Promise<string[]> {
  const leaked = await rows<{ table_name: string }>(sql`
    SELECT t.table_name
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_schema = t.table_schema AND c.table_name = t.table_name
    WHERE t.table_schema = 'kortix' AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'account_id'
    ORDER BY t.table_name;
  `);
  const survivors: string[] = [];
  for (const { table_name } of leaked) {
    if (RETAINED.has(table_name)) continue;
    // Weekly partitions of the retained audit_events parent (p20261005 …).
    if (/^audit_events_p\d{8}$/.test(table_name)) continue;
    const n = await countWhere(table_name, sql`account_id = ${accountId}`);
    if (n > 0) survivors.push(table_name);
  }
  return survivors;
}

withDb('account deletion on PostgreSQL', () => {
  test('delete-immediately removes the account, every orphaned row, and the auth identity', async () => {
    const result = await deleteAccountImmediately(ACCOUNT_ID, USER_ID);

    expect(result).toEqual({ success: true, message: 'Account deleted' });
    expect(deletedUsers).toEqual([USER_ID]);

    // The invariant: no account-scoped row survives the deletion in ANY table
    // the schema keys by account_id — the cascade tables (projects, sessions,
    // memberships, PATs, chat threads, gateway state…) and the swept orphans
    // (api keys, sandbox/session plane, tunnels, connectors, apps, admin
    // plane) alike.
    // The one retained row is the deletion receipt: the request, `completed`,
    // its free-text reason scrubbed.
    expect(await accountScopedTablesWithRows(ACCOUNT_ID)).toEqual(['account_deletion_requests']);
    expect(
      await rows<{ status: string; reason: string | null }>(
        sql`SELECT status, reason FROM kortix.account_deletion_requests WHERE account_id = ${ACCOUNT_ID}`,
      ),
    ).toEqual([{ status: 'completed', reason: null }]);

    // The neighboring account is untouched.
    expect(await countWhere('accounts', sql`account_id = ${OTHER_ACCOUNT_ID}`)).toBe(1);

    // The retained records survive, with the deletion marker the service wrote.
    const [credit] = await rows<{ tier: string; payment_status: string }>(
      sql`SELECT tier, payment_status FROM kortix.credit_accounts WHERE account_id = ${ACCOUNT_ID}`,
    );
    expect(credit?.tier).toBe('free');
    expect(credit?.payment_status).toBe('deleted');
    expect(
      await countWhere('credit_ledger', sql`account_id = ${ACCOUNT_ID} AND type = 'forfeiture'`),
    ).toBe(1);
    // At least the seeded event: the flow itself also appends audit records
    // for the forfeit and the deletion, which stay retained by design.
    expect(await countWhere('audit_events', sql`account_id = ${ACCOUNT_ID}`)).toBeGreaterThanOrEqual(1);
  });

  test('a sweep failure rolls back: the account and its data all survive', async () => {
    // The account row is already gone from the first test, so re-running
    // against it would prove nothing. Seed a fresh account and make the
    // deletion transaction fail mid-sweep with a test-only trigger, then
    // prove nothing was deleted — and that removing the trigger completes
    // the same deletion.
    const failUser = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const failAccount = failUser;
    const failProject = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    for (const statement of [
      sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${failAccount}, 'deletion-fail')`,
      sql`INSERT INTO kortix.account_memberships (user_id, account_id) VALUES (${failUser}, ${failAccount})`,
      sql`INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
        VALUES (${failProject}, ${failAccount}, 'deletion-fail-project', 'https://example.test/fail.git')`,
      sql`INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
        VALUES ('del-fail-session', ${failAccount}, ${failProject}, 'main', 'running')`,
      sql`INSERT INTO kortix.platform_user_roles (account_id, role) VALUES (${failAccount}, 'user')`,
      // A turn row the injected trigger fails on, so the sweep aborts.
      sql`INSERT INTO kortix.session_turns (turn_token, session_id, sandbox_id, project_id, account_id)
        VALUES ('del-fail-turn', 'del-fail-session', ${SANDBOX_ID}, ${failProject}, ${failAccount})`,
    ]) {
      await db.execute(statement);
    }
    await db.execute(sql`
      CREATE FUNCTION kortix.del_test_fail() RETURNS trigger AS
        $$ BEGIN RAISE EXCEPTION 'deletion-test failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER del_test_fail BEFORE DELETE ON kortix.session_turns
        FOR EACH ROW EXECUTE FUNCTION kortix.del_test_fail();
    `);
    try {
      await expect(deleteAccountImmediately(failAccount, failUser)).rejects.toThrow();

      // Nothing was deleted: the account, its membership and its project all
      // survive, and the auth identity was never touched.
      expect(await countWhere('accounts', sql`account_id = ${failAccount}`)).toBe(1);
      expect(await countWhere('projects', sql`account_id = ${failAccount}`)).toBe(1);
      expect(await countWhere('account_memberships', sql`user_id = ${failUser}`)).toBe(1);
      expect(deletedUsers).toEqual([USER_ID]);
    } finally {
      await db.execute(sql`DROP TRIGGER del_test_fail ON kortix.session_turns`);
      await db.execute(sql`DROP FUNCTION kortix.del_test_fail()`);
    }

    // The same deletion with the obstacle gone completes: the failure came
    // from the injected trigger, not from the seeded data.
    const result = await deleteAccountImmediately(failAccount, failUser);
    expect(result).toEqual({ success: true, message: 'Account deleted' });
    expect(deletedUsers).toEqual([USER_ID, failUser]);
    expect(await countWhere('accounts', sql`account_id = ${failAccount}`)).toBe(0);
  });
});
