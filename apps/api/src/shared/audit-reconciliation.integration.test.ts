import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { reconcileAuditEvents } from './audit-reconciliation';
import { runAuditReconciliationPage } from './audit-reconciliation-worker';

const databaseUrl = process.env.AUDIT_V2_DATABASE_URL;
const ACCOUNT = 'b7100000-0000-4000-a000-000000000001';
const SECOND_ACCOUNT = 'b7100000-0000-4000-a000-000000000002';
const PROJECT = 'b7200000-0000-4000-a000-000000000001';
const SESSION = 'b7300000-0000-4000-a000-000000000001';
const ACTOR = 'b7400000-0000-4000-a000-000000000001';
const TUNNEL = 'b7500000-0000-4000-a000-000000000001';

let client: pg.Client | null = null;

async function cursorImmediatelyBefore(accountId: string): Promise<string | null> {
  const result = await client!.query<{ account_id: string }>(
    `SELECT account_id
       FROM kortix.accounts
      WHERE account_id < $1
      ORDER BY account_id DESC
      LIMIT 1`,
    [accountId],
  );
  return result.rows[0]?.account_id ?? null;
}

describe.skipIf(!databaseUrl)('audit reconciliation — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // These append-only source ledgers intentionally have no account FK.
    // Remove fixtures from an interrupted previous test run before reseeding.
    await client.query('DELETE FROM kortix.provider_events WHERE account_id = $1', [ACCOUNT]);
    await client.query('DELETE FROM kortix.voice_call_turns WHERE session_id = $1', [SESSION]);
    await client.query(
      `INSERT INTO kortix.accounts(account_id, name) VALUES
         ($1, 'audit-reconcile'), ($2, 'audit-reconcile-second')`,
      [ACCOUNT, SECOND_ACCOUNT],
    );
    await client.query(
      `INSERT INTO kortix.projects(project_id, account_id, name, repo_url)
       VALUES ($1, $2, 'audit-reconcile', 'https://example.test/audit-reconcile.git')`,
      [PROJECT, ACCOUNT],
    );
    await client.query(`SET session_replication_role = 'replica'`);
    try {
      await client.query(
        `INSERT INTO kortix.project_sessions
           (session_id, account_id, project_id, branch_name, created_by, origin,
            agent_name, metadata)
         VALUES ($1, $2, $3, 'audit-reconcile', $4, 'backend', 'audit-agent',
                 '{"audit_v2":{"actor_type":"agent","authoritative_source":"agent",
                   "client_reported_source":"cli","initiator_actor_type":"human",
                   "initiator_actor_id":"b7400000-0000-4000-a000-000000000001",
                   "delegation_depth":1}}'::jsonb)`,
        [SESSION, ACCOUNT, PROJECT, ACTOR],
      );
    } finally {
      await client.query(`SET session_replication_role = 'origin'`);
    }
    await client.query(
      `INSERT INTO kortix.tunnel_connections(tunnel_id, account_id, name)
       VALUES ($1, $2, 'audit-reconcile')`,
      [TUNNEL, ACCOUNT],
    );

    // Simulate durable rows that predate projection triggers. Replica mode is
    // connection-local and suppresses only these test inserts' user triggers.
    await client.query(`SET session_replication_role = 'replica'`);
    try {
      await client.query(
        `INSERT INTO kortix.connector_calls
           (account_id, project_id, action_path, acting_user_id, session_id, status, request_digest)
         VALUES ($1, $2, 'gmail.list_messages', $3, $4, 'ok', repeat('a', 64))`,
        [ACCOUNT, PROJECT, ACTOR, SESSION],
      );
      await client.query(
        `INSERT INTO kortix.session_lifecycle_commands
           (command_type, source, status, project_id, session_id, account_id, actor_user_id)
         VALUES ('continue', 'cli', 'succeeded', $1, $2, $3, $4)`,
        [PROJECT, SESSION, ACCOUNT, ACTOR],
      );
      await client.query(
        `INSERT INTO kortix.project_trigger_executions
           (project_id, slug, schedule_revision, scheduled_for, status, spec, payload, session_id)
         VALUES ($1, 'daily', 'rev-1', now(), 'completed', '{}'::jsonb, '{}'::jsonb, $2)`,
        [PROJECT, SESSION],
      );
      await client.query(
        `INSERT INTO kortix.provider_events
           (provider, kind, outcome, total_ms, session_id, account_id)
         VALUES ('daytona', 'provision', 'ok', 125, $1, $2)`,
        [SESSION, ACCOUNT],
      );
      await client.query(
        `INSERT INTO kortix.usage_events
           (account_id, project_id, session_id, actor_user_id, provider, model, route,
            input_tokens, output_tokens, upstream_status)
         VALUES ($1, $2, $3, $4, 'openai', 'gpt-test', '/chat/completions', 10, 5, 200)`,
        [ACCOUNT, PROJECT, SESSION, ACTOR],
      );
      await client.query(
        `INSERT INTO kortix.gateway_request_logs
           (request_id, account_id, project_id, actor_user_id, session_id, requested_model,
            resolved_model, provider, status, ok, input_tokens, output_tokens)
         VALUES ('audit-reconcile-request', $1, $2, $3, $4, 'kortix/test',
                 'openai/test', 'openai', 200, true, 10, 5)`,
        [ACCOUNT, PROJECT, ACTOR, SESSION],
      );
      await client.query(
        `INSERT INTO kortix.voice_call_turns(call_id, project_id, session_id, role, speaker, text)
         VALUES ($1, $2, $1, 'user', NULL, 'content hashed but not copied')`,
        [SESSION, PROJECT],
      );
      await client.query(
        `INSERT INTO kortix.tunnel_audit_logs
           (tunnel_id, account_id, capability, operation, success, request_summary)
         VALUES ($1, $2, 'filesystem', 'list', true, '{"path_count":1}'::jsonb)`,
        [TUNNEL, ACCOUNT],
      );
    } finally {
      await client.query(`SET session_replication_role = 'origin'`);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(
      `DELETE FROM kortix.audit_webhook_deliveries WHERE event_id IN
         (SELECT event_id FROM kortix.audit_events WHERE account_id = ANY($1::uuid[]))`,
      [[ACCOUNT, SECOND_ACCOUNT]],
    );
    await client.query('DELETE FROM kortix.audit_events WHERE account_id = ANY($1::uuid[])', [
      [ACCOUNT, SECOND_ACCOUNT],
    ]);
    await client.query('DELETE FROM kortix.audit_session_sequences WHERE session_id = $1', [
      SESSION,
    ]);
    await client.query('DELETE FROM kortix.provider_events WHERE account_id = $1', [ACCOUNT]);
    await client.query('DELETE FROM kortix.voice_call_turns WHERE session_id = $1', [SESSION]);
    await client.query('DELETE FROM kortix.tunnel_connections WHERE tunnel_id = $1', [TUNNEL]);
    await client.query('DELETE FROM kortix.accounts WHERE account_id = ANY($1::uuid[])', [
      [ACCOUNT, SECOND_ACCOUNT],
    ]);
    await client.end();
  });

  test('converges nine durable ledgers through bounded idempotent pages', async () => {
    const totals: Record<string, number> = {};
    let inserted = 0;
    let complete = false;
    for (let page = 0; page < 4 && !complete; page += 1) {
      const result = await reconcileAuditEvents(ACCOUNT, 3);
      inserted += result.inserted;
      complete = result.complete;
      for (const [source, count] of Object.entries(result.by_source)) {
        totals[source] = (totals[source] ?? 0) + count;
      }
    }

    expect(inserted).toBe(9);
    expect(complete).toBe(true);
    expect(Object.keys(totals).sort()).toEqual([
      'connector_calls',
      'gateway_request_logs',
      'project_sessions',
      'project_trigger_executions',
      'provider_events',
      'session_lifecycle_commands',
      'tunnel_audit_logs',
      'usage_events',
      'voice_call_turns',
    ]);
    const digests = await client!.query<{
      source_ledger: string;
      input_sha256: string | null;
    }>(
      `SELECT source_ledger, input_sha256
         FROM kortix.audit_events
        WHERE account_id = $1
          AND source_ledger IN ('connector_calls', 'voice_call_turns')
        ORDER BY source_ledger`,
      [ACCOUNT],
    );
    expect(digests.rows).toHaveLength(2);
    expect(digests.rows[0]?.source_ledger).toBe('connector_calls');
    expect(digests.rows[0]?.input_sha256).toBe('a'.repeat(64));
    expect(digests.rows[1]?.source_ledger).toBe('voice_call_turns');
    expect(digests.rows[1]?.input_sha256).toHaveLength(64);
    const sessionAttribution = await client!.query<{
      actor_type: string | null;
      authoritative_source: string | null;
      client_reported_source: string | null;
      initiator_actor_type: string | null;
      initiator_actor_id: string | null;
      delegation_depth: number;
      agent_name: string | null;
    }>(
      `SELECT actor_type, authoritative_source, client_reported_source,
              initiator_actor_type, initiator_actor_id, delegation_depth, agent_name
         FROM kortix.audit_events
        WHERE account_id = $1 AND source_ledger = 'project_sessions'`,
      [ACCOUNT],
    );
    expect(sessionAttribution.rows[0]).toMatchObject({
      actor_type: 'agent',
      authoritative_source: 'agent',
      client_reported_source: 'cli',
      initiator_actor_type: 'human',
      initiator_actor_id: ACTOR,
      delegation_depth: 1,
      agent_name: 'audit-agent',
    });

    const repeat = await reconcileAuditEvents(ACCOUNT, 3);
    expect(repeat).toEqual({ inserted: 0, complete: true, by_source: {} });

    await client!.query(`SET session_replication_role = 'replica'`);
    try {
      await client!.query(
        `INSERT INTO kortix.provider_events
           (provider, kind, outcome, total_ms, session_id, account_id)
         VALUES ('daytona', 'stop', 'ok', 25, $1, $2)`,
        [SESSION, ACCOUNT],
      );
    } finally {
      await client!.query(`SET session_replication_role = 'origin'`);
    }
    const concurrent = await Promise.all([
      reconcileAuditEvents(ACCOUNT, 1),
      reconcileAuditEvents(ACCOUNT, 1),
    ]);
    expect(concurrent.reduce((total, result) => total + result.inserted, 0)).toBe(1);
    expect(concurrent.every((result) => result.complete)).toBe(true);
    expect(await reconcileAuditEvents(ACCOUNT, 1)).toEqual({
      inserted: 0,
      complete: true,
      by_source: {},
    });

    // Start immediately before this fixture. The integration database can
    // contain unrelated accounts from other suites; scanning from null would
    // reconcile and append markers for those accounts as a test side effect.
    const fixtureCursor = await cursorImmediatelyBefore(ACCOUNT);
    const automatic = await runAuditReconciliationPage(fixtureCursor);
    expect(automatic.accountId).toBe(ACCOUNT);
    expect(automatic.result).toEqual({ inserted: 0, complete: true, by_source: {} });
    const marker = await client!.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM kortix.audit_events
        WHERE source_ledger = 'audit_reconciliation'
          AND source_record_id = $1
          AND source_revision = 'v2'`,
      [ACCOUNT],
    );
    expect(marker.rows[0]?.count).toBe(1);

    const secondAccount = await runAuditReconciliationPage(ACCOUNT);
    expect(secondAccount).toEqual({
      accountId: SECOND_ACCOUNT,
      result: { inserted: 0, complete: true, by_source: {} },
    });
    const secondMarker = await client!.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM kortix.audit_events
        WHERE source_ledger = 'audit_reconciliation'
          AND source_record_id = $1
          AND source_revision = 'v2'`,
      [SECOND_ACCOUNT],
    );
    expect(secondMarker.rows[0]?.count).toBe(1);

    // The completion marker is a backfill checkpoint, not a permanent opt-out.
    // A source row missed after the first scan must still converge on the next
    // continuous reconciliation cycle.
    await client!.query(`SET session_replication_role = 'replica'`);
    try {
      await client!.query(
        `INSERT INTO kortix.provider_events
           (provider, kind, outcome, total_ms, session_id, account_id)
         VALUES ('daytona', 'restart', 'ok', 15, $1, $2)`,
        [SESSION, ACCOUNT],
      );
    } finally {
      await client!.query(`SET session_replication_role = 'origin'`);
    }
    const nextCycle = await runAuditReconciliationPage(fixtureCursor);
    expect(nextCycle.accountId).toBe(ACCOUNT);
    expect(nextCycle.result).toEqual({
      inserted: 1,
      complete: true,
      by_source: { provider_events: 1 },
    });
  });
});
