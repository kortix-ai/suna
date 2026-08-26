import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.AUDIT_V2_DATABASE_URL;
const ACCOUNT = 'a7100000-0000-4000-a000-000000000001';
const DELETE_ACCOUNT = 'a7100000-0000-4000-a000-000000000002';
const PROJECT = 'a7200000-0000-4000-a000-000000000001';
const SESSION = 'a7300000-0000-4000-a000-000000000001';
const ACTOR = 'a7400000-0000-4000-a000-000000000001';
const TUNNEL = 'a7500000-0000-4000-a000-000000000001';

let client: pg.Client | null = null;

describe.skipIf(!databaseUrl)('centralized audit v2 — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(
      `INSERT INTO kortix.accounts(account_id, name) VALUES
         ($1, 'audit-v2'), ($2, 'audit-v2-delete')
       ON CONFLICT (account_id) DO NOTHING`,
      [ACCOUNT, DELETE_ACCOUNT],
    );
    await client.query(
      `INSERT INTO kortix.projects(project_id, account_id, name, repo_url)
       VALUES ($1, $2, 'audit-v2', 'https://example.test/audit-v2.git')
       ON CONFLICT (project_id) DO NOTHING`,
      [PROJECT, ACCOUNT],
    );
    await client.query(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, created_by)
       VALUES ($1, $2, $3, 'audit-v2', $4)
       ON CONFLICT (session_id) DO NOTHING`,
      [SESSION, ACCOUNT, PROJECT, ACTOR],
    );
    await client.query(
      `INSERT INTO kortix.tunnel_connections(tunnel_id, account_id, name)
       VALUES ($1, $2, 'audit-v2-computer')
       ON CONFLICT (tunnel_id) DO NOTHING`,
      [TUNNEL, ACCOUNT],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(
      `DELETE FROM kortix.audit_webhook_deliveries WHERE event_id IN
      (SELECT event_id FROM kortix.audit_events WHERE account_id IN ($1, $2))`,
      [ACCOUNT, DELETE_ACCOUNT],
    );
    await client.query(`DELETE FROM kortix.audit_events WHERE account_id IN ($1, $2)`, [
      ACCOUNT,
      DELETE_ACCOUNT,
    ]);
    await client.query(`DELETE FROM kortix.audit_session_sequences WHERE session_id = $1`, [
      SESSION,
    ]);
    await client.query(`DELETE FROM kortix.audit_session_sequences WHERE session_id = $1`, [
      'a7300000-0000-4000-a000-000000000099',
    ]);
    await client.query(`DELETE FROM kortix.audit_webhooks WHERE account_id = $1`, [ACCOUNT]);
    await client.query(`DELETE FROM kortix.tunnel_connections WHERE tunnel_id = $1`, [TUNNEL]);
    await client.query(`DELETE FROM kortix.projects WHERE project_id = $1`, [PROJECT]);
    await client.query(`DELETE FROM kortix.accounts WHERE account_id = ANY($1::uuid[])`, [
      [ACCOUNT, DELETE_ACCOUNT],
    ]);
    await client.end();
  });

  test('allocates one ordered hash chain under concurrent session writers', async () => {
    const writers = await Promise.all(
      ['one', 'two', 'three'].map(async () => {
        const writer = new pg.Client({ connectionString: databaseUrl });
        await writer.connect();
        return writer;
      }),
    );
    try {
      await Promise.all(
        ['one', 'two', 'three'].map((id, index) =>
          writers[index]!.query(
            `INSERT INTO kortix.audit_events
             (account_id, project_id, session_id, action, resource_type,
              source_ledger, source_record_id, phase, authoritative_source)
           VALUES ($1, $2, $3, 'test.sequence', 'project_session',
                   'audit_v2_test', $4, 'completed', 'system')`,
            [ACCOUNT, PROJECT, SESSION, id],
          ),
        ),
      );
    } finally {
      await Promise.all(writers.map((writer) => writer.end()));
    }
    const result = await client!.query<{
      session_sequence: string;
      integrity_previous_hash: string | null;
      integrity_hash: string;
      recomputed_hash: string;
    }>(
      `SELECT session_sequence, integrity_previous_hash, integrity_hash,
              encode(extensions.digest(
                convert_to((to_jsonb(a) - 'integrity_hash')::text, 'UTF8'), 'sha256'
              ), 'hex') AS recomputed_hash
       FROM kortix.audit_events
       AS a
       WHERE source_ledger = 'audit_v2_test'
       ORDER BY session_sequence`,
    );
    const sequences = result.rows.map((row) => Number(row.session_sequence));
    expect(sequences).toHaveLength(3);
    expect(sequences[1]).toBe(sequences[0]! + 1);
    expect(sequences[2]).toBe(sequences[1]! + 1);
    expect(result.rows.every((row) => row.integrity_hash.length === 64)).toBe(true);
    expect(result.rows.every((row) => row.integrity_hash === row.recomputed_hash)).toBe(true);
    expect(result.rows[1]!.integrity_previous_hash).toBe(result.rows[0]!.integrity_hash);
    expect(result.rows[2]!.integrity_previous_hash).toBe(result.rows[1]!.integrity_hash);
  });

  test('rejects updates and deletes from the canonical ledger', async () => {
    await expect(
      client!.query(`UPDATE kortix.audit_events SET action = 'tampered'
                     WHERE source_ledger = 'audit_v2_test'`),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      client!.query(`DELETE FROM kortix.audit_events WHERE source_ledger = 'audit_v2_test'`),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  test('duplicate source replay does not advance or detach the session hash chain', async () => {
    const first = await client!.query<{
      session_sequence: string;
      integrity_hash: string;
    }>(
      `INSERT INTO kortix.audit_events
         (account_id, project_id, session_id, action, resource_type,
          source_ledger, source_record_id, phase, authoritative_source)
       VALUES ($1, $2, $3, 'test.replay', 'project_session',
               'audit_v2_replay', 'same', 'completed', 'system')
       RETURNING session_sequence, integrity_hash`,
      [ACCOUNT, PROJECT, SESSION],
    );
    const duplicate = await client!.query(
      `INSERT INTO kortix.audit_events
         (account_id, project_id, session_id, action, resource_type,
          source_ledger, source_record_id, phase, authoritative_source)
       VALUES ($1, $2, $3, 'test.replay', 'project_session',
               'audit_v2_replay', 'same', 'completed', 'system')
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [ACCOUNT, PROJECT, SESSION],
    );
    const next = await client!.query<{
      session_sequence: string;
      integrity_previous_hash: string;
    }>(
      `INSERT INTO kortix.audit_events
         (account_id, project_id, session_id, action, resource_type,
          source_ledger, source_record_id, phase, authoritative_source)
       VALUES ($1, $2, $3, 'test.replay.next', 'project_session',
               'audit_v2_replay', 'next', 'completed', 'system')
       RETURNING session_sequence, integrity_previous_hash`,
      [ACCOUNT, PROJECT, SESSION],
    );
    expect(duplicate.rows).toHaveLength(0);
    expect(Number(next.rows[0]!.session_sequence)).toBe(
      Number(first.rows[0]!.session_sequence) + 1,
    );
    expect(next.rows[0]!.integrity_previous_hash).toBe(first.rows[0]!.integrity_hash);
  });

  test('keeps repeated phases when the durable source revision changes', async () => {
    const inserted = await client!.query<{ source_revision: string; session_sequence: string }>(
      `INSERT INTO kortix.audit_events
         (account_id, project_id, session_id, action, resource_type,
          source_ledger, source_record_id, phase, source_revision, authoritative_source)
       VALUES
         ($1, $2, $3, 'test.retry', 'project_session', 'audit_v2_revision', 'same',
          'running', 'running:1', 'system'),
         ($1, $2, $3, 'test.retry', 'project_session', 'audit_v2_revision', 'same',
          'running', 'running:2', 'system')
       RETURNING source_revision, session_sequence`,
      [ACCOUNT, PROJECT, SESSION],
    );
    expect(inserted.rows.map((row) => row.source_revision)).toEqual(['running:1', 'running:2']);
    expect(Number(inserted.rows[1]!.session_sequence)).toBe(
      Number(inserted.rows[0]!.session_sequence) + 1,
    );
  });

  test('projects connector and lifecycle state in the source transaction', async () => {
    const connector = await client!.query<{ execution_id: string }>(
      `INSERT INTO kortix.connector_calls
         (account_id, project_id, action_path, acting_user_id, session_id, status,
          request_digest, result_summary)
       VALUES ($1, $2, 'gmail.send_email', $3, $4, 'pending_approval', repeat('a', 64),
               '{"args_preview":{"body":"raw prompt","authorization":"Bearer private-credential"},
                 "args_preview_complete":true}'::jsonb)
       RETURNING execution_id`,
      [ACCOUNT, PROJECT, ACTOR, SESSION],
    );
    const lifecycle = await client!.query<{ command_id: string }>(
      `INSERT INTO kortix.session_lifecycle_commands
         (command_type, source, project_id, session_id, account_id, actor_user_id)
       VALUES ('continue', 'cli', $1, $2, $3, $4)
       RETURNING command_id`,
      [PROJECT, SESSION, ACCOUNT, ACTOR],
    );
    await client!.query(
      `UPDATE kortix.session_lifecycle_commands
       SET attempts = 1, result = '{"private":"raw prompt and output"}'::jsonb,
           last_error = 'Bearer private-credential'
       WHERE command_id = $1`,
      [lifecycle.rows[0]!.command_id],
    );
    const projected = await client!.query<{
      source_ledger: string;
      phase: string;
      source_revision: string;
      output_summary: Record<string, unknown> | null;
      output_sha256: string | null;
      error_message: string | null;
    }>(
      `SELECT source_ledger, phase, source_revision, output_summary, output_sha256, error_message
       FROM kortix.audit_events
       WHERE (source_ledger = 'connector_calls' AND source_record_id = $1)
          OR (source_ledger = 'session_lifecycle_commands' AND source_record_id = $2)
       ORDER BY source_ledger, source_revision`,
      [connector.rows[0]!.execution_id, lifecycle.rows[0]!.command_id],
    );
    expect(
      projected.rows.map((row) => [row.source_ledger, row.phase, row.source_revision]),
    ).toEqual([
      ['connector_calls', 'pending', 'pending_approval'],
      ['session_lifecycle_commands', 'queued', 'queued:0'],
      ['session_lifecycle_commands', 'queued', 'queued:1'],
    ]);
    const retried = projected.rows.at(-1)!;
    expect(retried.output_summary).toEqual({ has_error: true, has_result: true });
    expect(retried.output_sha256).toHaveLength(64);
    expect(retried.error_message).toBeNull();
    const connectorProjection = projected.rows.find(
      (row) => row.source_ledger === 'connector_calls',
    )!;
    expect(connectorProjection.output_summary).toEqual({ has_result_summary: true });
    expect(connectorProjection.output_sha256).toHaveLength(64);
    expect(JSON.stringify(retried)).not.toContain('raw prompt');
    expect(JSON.stringify(retried)).not.toContain('private-credential');
    expect(JSON.stringify(connectorProjection)).not.toContain('raw prompt');
    expect(JSON.stringify(connectorProjection)).not.toContain('private-credential');
  });

  test('stores computer intent before relay and a terminal phase after completion', async () => {
    const started = await client!.query<{ log_id: string }>(
      `INSERT INTO kortix.tunnel_audit_logs
         (tunnel_id, account_id, project_id, session_id, actor_user_id, actor_type,
          capability, operation, request_summary, phase, success)
       VALUES ($1, $2, $3, $4, $5, 'agent', 'shell', 'shell.exec',
               '{"method":"shell.exec","command":true,"argumentCount":2}'::jsonb,
               'started', false)
       RETURNING log_id`,
      [TUNNEL, ACCOUNT, PROJECT, SESSION, ACTOR],
    );
    const logId = started.rows[0]?.log_id;
    if (!logId) throw new Error('tunnel audit start did not return a log id');

    await client!.query(
      `UPDATE kortix.tunnel_audit_logs
          SET phase = 'completed', success = true, duration_ms = 42, bytes_transferred = 128
        WHERE log_id = $1`,
      [logId],
    );

    const events = await client!.query<{
      phase: string;
      outcome: string;
      source_revision: string;
      input_summary: Record<string, unknown>;
      output_summary: Record<string, unknown>;
    }>(
      `SELECT phase, outcome, source_revision, input_summary, output_summary
         FROM kortix.audit_events
        WHERE source_ledger = 'tunnel_audit_logs' AND source_record_id = $1
        ORDER BY session_sequence`,
      [logId],
    );
    expect(events.rows.map((event) => [event.phase, event.outcome])).toEqual([
      ['started', 'pending'],
      ['completed', 'success'],
    ]);
    expect(events.rows.map((event) => event.source_revision)).toEqual(['started', 'completed']);
    expect(events.rows[0]?.input_summary).toEqual({
      method: 'shell.exec',
      has_path: false,
      has_command: true,
      has_cwd: false,
      argument_count: 2,
      content_size: 0,
    });
    expect(events.rows[1]?.output_summary).toEqual({
      capability: 'shell',
      bytes_transferred: 128,
    });
  });

  test('projects session creation and status changes in the source transaction', async () => {
    const sessionId = 'a7300000-0000-4000-a000-000000000099';
    await client!.query(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, created_by, origin, status, error,
          metadata)
       VALUES ($1, $2, $3, 'audit-v2-projected', $4, 'user', 'queued',
               'private creation error',
               '{"audit_v2":{"actor_type":"agent","authoritative_source":"agent",
                 "client_reported_source":"cli","initiator_actor_type":"agent",
                 "initiator_actor_id":"parent-session","delegation_depth":1}}'::jsonb)`,
      [sessionId, ACCOUNT, PROJECT, ACTOR],
    );
    await client!.query(
      `UPDATE kortix.project_sessions
          SET status = 'failed', error = 'Bearer private-status-error', updated_at = now()
        WHERE session_id = $1`,
      [sessionId],
    );
    const result = await client!.query<{
      action: string;
      phase: string;
      source_ledger: string;
      source_revision: string;
      input_summary: Record<string, unknown>;
      output_sha256: string | null;
      error_message: string | null;
      actor_type: string | null;
      authoritative_source: string | null;
      client_reported_source: string | null;
      initiator_actor_type: string | null;
      initiator_actor_id: string | null;
      delegation_depth: number;
    }>(
      `SELECT action, phase, source_ledger, source_revision, input_summary,
              output_sha256, error_message, actor_type, authoritative_source,
              client_reported_source, initiator_actor_type, initiator_actor_id,
              delegation_depth
         FROM kortix.audit_events
        WHERE source_ledger = 'project_sessions' AND source_record_id = $1
        ORDER BY session_sequence`,
      [sessionId],
    );
    expect(result.rows.map((row) => [row.action, row.phase])).toEqual([
      ['session.created', 'created'],
      ['session.status.changed', 'failed'],
    ]);
    expect(result.rows[0]?.source_revision).toBe('created');
    expect(result.rows[1]?.source_revision).not.toBe('created');
    expect(result.rows[1]?.input_summary).toMatchObject({
      from_status: 'queued',
      to_status: 'failed',
    });
    expect(result.rows[1]?.output_sha256).toHaveLength(64);
    expect(result.rows[0]).toMatchObject({
      actor_type: 'agent',
      authoritative_source: 'agent',
      client_reported_source: 'cli',
      initiator_actor_type: 'agent',
      initiator_actor_id: 'parent-session',
      delegation_depth: 1,
    });
    expect(result.rows.every((row) => row.error_message === null)).toBe(true);
    expect(JSON.stringify(result.rows)).not.toContain('private creation error');
    expect(JSON.stringify(result.rows)).not.toContain('private-status-error');
  });

  test('queues every matching webhook delivery in the event transaction', async () => {
    const webhook = await client!.query<{ webhook_id: string }>(
      `INSERT INTO kortix.audit_webhooks(account_id, url, secret, name, action_prefix)
       VALUES ($1, 'https://example.test/audit', 'test-secret', 'test', 'webhook.')
       RETURNING webhook_id`,
      [ACCOUNT],
    );
    const event = await client!.query<{ event_id: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
       VALUES ($1, 'webhook.delivery.test', 'test', 'system') RETURNING event_id`,
      [ACCOUNT],
    );
    const delivery = await client!.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM kortix.audit_webhook_deliveries
       WHERE webhook_id = $1 AND event_id = $2`,
      [webhook.rows[0]!.webhook_id, event.rows[0]!.event_id],
    );
    expect(delivery.rows).toEqual([{ status: 'pending', attempts: 0 }]);
  });

  test('preserves canonical events after account deletion', async () => {
    await client!.query(
      `INSERT INTO kortix.audit_webhooks(account_id, url, secret, name)
       VALUES ($1, 'https://example.test/delete-audit', 'test-secret', 'delete-test')`,
      [DELETE_ACCOUNT],
    );
    const event = await client!.query<{ event_id: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
       VALUES ($1, 'account.deleted', 'account', 'system') RETURNING event_id`,
      [DELETE_ACCOUNT],
    );
    await client!.query(`DELETE FROM kortix.accounts WHERE account_id = $1`, [DELETE_ACCOUNT]);
    const persisted = await client!.query<{ account_id: string }>(
      `SELECT account_id FROM kortix.audit_events WHERE event_id = $1`,
      [event.rows[0]!.event_id],
    );
    expect(persisted.rows).toEqual([{ account_id: DELETE_ACCOUNT }]);
    const deliveries = await client!.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM kortix.audit_webhook_deliveries
       WHERE event_id = $1`,
      [event.rows[0]!.event_id],
    );
    expect(deliveries.rows).toEqual([{ count: '0' }]);
  });

  /**
   * The Essentia audit convoy (2026-08-26).
   *
   * `audit_prepare_event` allocates the per-session sequence and hash-chain
   * head out of `kortix.audit_session_sequences`, and PostgreSQL holds that row
   * lock until the inserting transaction COMMITs. Serializing one session is
   * the append-only chain's price. Serializing DIFFERENT sessions is not, and
   * a blocked writer must not burn a whole statement_timeout finding out.
   *
   * Live evidence this pins: POST .../audit/events returned 500 [57014] 445
   * times in 3 hours, each at ~10s, with `insert into "kortix"."audit_events"`
   * blocking other `insert into "kortix"."audit_events"` in chained pids.
   */
  describe('per-session sequence lock scope', () => {
    const HOLD_SESSION = 'a7300000-0000-4000-a000-0000000000c1';
    const OTHER_SESSION = 'a7300000-0000-4000-a000-0000000000c2';

    async function connect(): Promise<pg.Client> {
      const c = new pg.Client({ connectionString: databaseUrl });
      await c.connect();
      return c;
    }

    function insert(c: pg.Client, sessionId: string, recordId: string) {
      return c.query(
        `INSERT INTO kortix.audit_events
           (account_id, project_id, session_id, action, resource_type,
            source_ledger, source_record_id, phase, authoritative_source)
         VALUES ($1, $2, $3, 'test.lock-scope', 'project_session',
                 'audit_v2_lock_scope', $4, 'completed', 'system')`,
        [ACCOUNT, PROJECT, sessionId, recordId],
      );
    }

    afterAll(async () => {
      if (!client) return;
      await client.query(`SET kortix.audit_maintenance = 'on'`);
      await client.query(`DELETE FROM kortix.audit_events WHERE session_id = ANY($1::text[])`, [
        [HOLD_SESSION, OTHER_SESSION],
      ]);
      await client.query(
        `DELETE FROM kortix.audit_session_sequences WHERE session_id = ANY($1::text[])`,
        [[HOLD_SESSION, OTHER_SESSION]],
      );
      await client.query(`SET kortix.audit_maintenance = 'off'`);
    });

    test('an uncommitted writer blocks only its own session, and lock_timeout bounds the wait', async () => {
      const holder = await connect();
      const waiter = await connect();
      try {
        await holder.query('BEGIN');
        await insert(holder, HOLD_SESSION, 'holder');

        // A different session takes a different row lock: no wait at all. This
        // is why the API's flush must never put two sessions in one statement.
        await waiter.query(`SET lock_timeout = '2500ms'`);
        const otherStartedAt = Date.now();
        await insert(waiter, OTHER_SESSION, 'other');
        expect(Date.now() - otherStartedAt).toBeLessThan(2_000);

        // The SAME session waits, and fails with 55P03 (lock_not_available) at
        // the lock budget instead of riding the 10s statement_timeout to 57014.
        const blockedStartedAt = Date.now();
        let code: string | null = null;
        try {
          await insert(waiter, HOLD_SESSION, 'blocked');
        } catch (error) {
          code = (error as { code?: string }).code ?? null;
        }
        const blockedMs = Date.now() - blockedStartedAt;
        expect(code).toBe('55P03');
        expect(blockedMs).toBeGreaterThanOrEqual(2_000);
        expect(blockedMs).toBeLessThan(9_000);
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end();
        await waiter.end();
      }
    }, 30_000);
  });
});
