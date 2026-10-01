import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
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

  test('concurrent same-session writers insert without a sequence allocator or hash chain', async () => {
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
              source_ledger, source_record_id, phase, authoritative_source,
              on_behalf_of_user_id, credential_kind, credential_id)
           VALUES ($1, $2, $3, 'test.sequence', 'project_session',
                   'audit_v2_test', $4, 'completed', 'system', $5::uuid, $6, $7)`,
            [
              ACCOUNT, PROJECT, SESSION, id,
              index === 2 ? 'a7300000-0000-4000-a000-0000000000b1' : null,
              index === 1 ? 'personal_access_token' : null,
              index === 1 ? 'token-id-1' : null,
            ],
          ),
        ),
      );
    } finally {
      await Promise.all(writers.map((writer) => writer.end()));
    }
    const result = await client!.query<{
      source_record_id: string;
      source: string;
      authoritative_source: string;
      session_sequence: string | null;
      integrity_previous_hash: string | null;
      integrity_hash: string | null;
    }>(
      `SELECT source_record_id, source, authoritative_source, session_sequence,
              integrity_previous_hash, integrity_hash
         FROM kortix.audit_events
        WHERE source_ledger = 'audit_v2_test'
        ORDER BY source_record_id`,
    );
    // The row still gets its source columns from the BEFORE INSERT trigger ...
    expect(result.rows.map((row) => [row.source_record_id, row.source, row.authoritative_source])).toEqual([
      ['one', 'system', 'system'],
      ['three', 'system', 'system'],
      ['two', 'system', 'system'],
    ].sort());
    // ... and nothing else: no per-session sequence, no hash chain (removed from
    // ingestion in favour of S3 Object Lock on the archive). Old rows keep theirs.
    expect(result.rows.every((row) => row.session_sequence === null)).toBe(true);
    expect(result.rows.every((row) => row.integrity_hash === null)).toBe(true);
    expect(result.rows.every((row) => row.integrity_previous_hash === null)).toBe(true);
  });

  test('the prepare trigger takes no advisory lock and never touches audit_session_sequences', async () => {
    const { rows } = await client!.query<{ def: string }>(
      `SELECT pg_get_functiondef('kortix.audit_prepare_event'::regproc) AS def`,
    );
    expect(rows[0]!.def).not.toMatch(/advisory|audit_session_sequences|digest|session_sequence/i);
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

  test('a duplicate source replay inserts nothing; the unique index is the only dedupe check', async () => {
    const insertOne = (client: pg.Client | pg.PoolClient, suffix: string) =>
      client.query<{ event_id: string }>(
        `INSERT INTO kortix.audit_events
           (account_id, project_id, session_id, action, resource_type,
            source_ledger, source_record_id, phase, authoritative_source)
         VALUES ($1, $2, $3, 'test.replay', 'project_session',
                 'audit_v2_replay', $4, 'completed', 'system')
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [ACCOUNT, PROJECT, SESSION, suffix],
      );
    const first = await insertOne(client!, 'same');
    const duplicate = await insertOne(client!, 'same');
    expect(first.rows).toHaveLength(1);
    expect(duplicate.rows).toHaveLength(0);

    // Without ON CONFLICT the same replay is a unique violation: the index, not a
    // trigger, enforces idempotency.
    await expect(
      client!.query(
        `INSERT INTO kortix.audit_events
           (account_id, session_id, action, resource_type, source_ledger, source_record_id,
            phase, authoritative_source)
         VALUES ($1, $2, 'test.replay', 'project_session', 'audit_v2_replay', 'same',
                 'completed', 'system')`,
        [ACCOUNT, SESSION],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Eight connections replay the same new source record at once: exactly one
    // row lands, nobody errors, nobody waits on an advisory lock.
    const writers = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const writer = new pg.Client({ connectionString: databaseUrl });
        await writer.connect();
        return writer;
      }),
    );
    try {
      const results = await Promise.all(writers.map((writer) => insertOne(writer, 'race')));
      expect(results.reduce((total, result) => total + result.rows.length, 0)).toBe(1);
    } finally {
      await Promise.all(writers.map((writer) => writer.end()));
    }
  });

  test('keeps repeated phases when the durable source revision changes', async () => {
    const inserted = await client!.query<{ source_revision: string }>(
      `INSERT INTO kortix.audit_events
         (account_id, project_id, session_id, action, resource_type,
          source_ledger, source_record_id, phase, source_revision, authoritative_source)
       VALUES
         ($1, $2, $3, 'test.retry', 'project_session', 'audit_v2_revision', 'same',
          'running', 'running:1', 'system'),
         ($1, $2, $3, 'test.retry', 'project_session', 'audit_v2_revision', 'same',
          'running', 'running:2', 'system')
       RETURNING source_revision`,
      [ACCOUNT, PROJECT, SESSION],
    );
    expect(inserted.rows.map((row) => row.source_revision)).toEqual(['running:1', 'running:2']);
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
        ORDER BY occurred_at, event_id`,
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
        ORDER BY occurred_at, event_id`,
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
   * The SampleCo audit convoy (2026-08-26) and the 2026-10 ingest 503s came from a
   * row lock on `kortix.audit_session_sequences` that PostgreSQL held until COMMIT.
   * The BEFORE INSERT trigger no longer takes any per-session lock: two writers
   * of ONE session never wait for each other, whatever one of them has not
   * committed.
   */
  describe('no per-session lock', () => {
    const HOLD_SESSION = 'a7300000-0000-4000-a000-0000000000c1';

    async function connect(): Promise<pg.Client> {
      const c = new pg.Client({ connectionString: databaseUrl });
      await c.connect();
      return c;
    }

    function insert(c: pg.Client, recordId: string) {
      return c.query(
        `INSERT INTO kortix.audit_events
           (account_id, project_id, session_id, action, resource_type,
            source_ledger, source_record_id, phase, authoritative_source)
         VALUES ($1, $2, $3, 'test.lock-scope', 'project_session',
                 'audit_v2_lock_scope', $4, 'completed', 'system')`,
        [ACCOUNT, PROJECT, HOLD_SESSION, recordId],
      );
    }

    afterAll(async () => {
      if (!client) return;
      await client.query(`SET kortix.audit_maintenance = 'on'`);
      await client.query(`DELETE FROM kortix.audit_events WHERE session_id = $1`, [HOLD_SESSION]);
      await client.query(`SET kortix.audit_maintenance = 'off'`);
    });

    test('an uncommitted writer holds no lock another writer of the same session can wait on', async () => {
      const holder = await connect();
      const waiter = await connect();
      try {
        await holder.query('BEGIN');
        await insert(holder, 'holder');
        const { rows: held } = await client!.query<{ locktype: string; relation: string | null }>(
          `SELECT l.locktype, l.relation::regclass::text AS relation
             FROM pg_locks l
            WHERE l.pid = $1 AND l.locktype = 'advisory'
               OR (l.pid = $1 AND l.relation = 'kortix.audit_session_sequences'::regclass)`,
          [(await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid],
        );
        expect(held).toEqual([]);

        // Same session, different source record: no wait, even under a tight lock_timeout.
        await waiter.query(`SET lock_timeout = '250ms'`);
        const startedAt = Date.now();
        await insert(waiter, 'waiter');
        expect(Date.now() - startedAt).toBeLessThan(250);
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end();
        await waiter.end();
      }
    }, 30_000);
  });
});
