import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { auditEvents } from '../src/schema/kortix';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'a7600000-0000-4000-a000-000000000001';
const PROJECT = 'a7600000-0000-4000-a000-000000000002';
const SESSION = 'a7600000-0000-4000-a000-000000000003';
const ACTOR = 'a7600000-0000-4000-a000-000000000004';

let client: pg.Client | null = null;

/** Version nibble and variant nibble of a UUID text. */
const nibbles = (id: string) => ({ version: id[14], variant: id[19] });
/** The 48-bit unix-millisecond prefix of a UUIDv7. */
const millis = (id: string) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);

describe.skipIf(!databaseUrl)('audit_events.event_id is a UUIDv7', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(
      `INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'audit-uuid-v7')
       ON CONFLICT (account_id) DO NOTHING`,
      [ACCOUNT],
    );
    await client.query(
      `INSERT INTO kortix.projects(project_id, account_id, name, repo_url)
       VALUES ($1, $2, 'audit-uuid-v7', 'https://example.test/audit-uuid-v7.git')
       ON CONFLICT (project_id) DO NOTHING`,
      [PROJECT, ACCOUNT],
    );
    await client.query(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, created_by)
       VALUES ($1, $2, $3, 'audit-uuid-v7', $4)
       ON CONFLICT (session_id) DO NOTHING`,
      [SESSION, ACCOUNT, PROJECT, ACTOR],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT]);
    await client.query(`DELETE FROM kortix.audit_session_sequences WHERE session_id = $1`, [
      SESSION,
    ]);
    await client.query(`DELETE FROM kortix.projects WHERE project_id = $1`, [PROJECT]);
    await client.query(`DELETE FROM kortix.accounts WHERE account_id = $1`, [ACCOUNT]);
    await client.end();
  });

  test('kortix.uuid_v7() sets version 7, variant 10xx and a current millisecond prefix', async () => {
    const before = Date.now();
    const { rows } = await client!.query<{ id: string }>(
      `SELECT kortix.uuid_v7()::text AS id FROM generate_series(1, 200)`,
    );
    const after = Date.now();
    for (const { id } of rows) {
      expect(nibbles(id).version).toBe('7');
      expect('89ab').toContain(nibbles(id).variant as string);
      expect(millis(id)).toBeGreaterThanOrEqual(before - 5);
      expect(millis(id)).toBeLessThanOrEqual(after + 5);
    }
    expect(new Set(rows.map((row) => row.id)).size).toBe(200);
  });

  test('ids of one multi-row statement sort in generation order (sub-millisecond field)', async () => {
    // 5,000 ids are generated within a few milliseconds, so most share a
    // millisecond. A millisecond-only prefix would order those at random.
    const { rows } = await client!.query<{ id: string }>(
      `SELECT kortix.uuid_v7()::text AS id FROM generate_series(1, 5000) AS n ORDER BY n`,
    );
    const inversions = rows.filter((row, i) => i > 0 && row.id < rows[i - 1]!.id).length;
    // Two ids can still fall in the same microsecond; allow 0.1%.
    expect(inversions).toBeLessThanOrEqual(5);
  });

  test('the column default is kortix.uuid_v7(), and new ids sort by creation time', async () => {
    const { rows: def } = await client!.query<{ expr: string }>(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
         FROM pg_attrdef d
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'kortix.audit_events'::regclass AND a.attname = 'event_id'`,
    );
    expect(def[0]?.expr).toContain('uuid_v7');

    // Ten statements spread over >= 30 ms: the ms prefix never goes backwards,
    // so a btree on event_id appends at its right edge.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { rows } = await client!.query<{ event_id: string }>(
        `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
         VALUES ($1, 'test.uuid-v7.order', 'test', 'system') RETURNING event_id::text`,
        [ACCOUNT],
      );
      ids.push(rows[0]!.event_id);
      await Bun.sleep(3);
    }
    const prefixes = ids.map(millis);
    expect(prefixes).toEqual([...prefixes].sort((a, b) => a - b));
    expect(new Set(prefixes).size).toBe(10);
  });

  test('every database writer produces a v7 id: plain insert, multi-row insert, source triggers', async () => {
    const plain = await client!.query<{ event_id: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
       VALUES ($1, 'test.uuid-v7.plain', 'test', 'system'),
              ($1, 'test.uuid-v7.plain', 'test', 'system')
       RETURNING event_id::text`,
      [ACCOUNT],
    );

    // Trigger writers (audit_connector_call, audit_session_lifecycle_command,
    // audit_project_session, audit_tunnel_operation) INSERT without an event_id.
    await client!.query(
      `INSERT INTO kortix.connector_calls
         (account_id, project_id, action_path, acting_user_id, session_id, status, request_digest)
       VALUES ($1, $2, 'gmail.send_email', $3, $4, 'pending_approval', repeat('a', 64))`,
      [ACCOUNT, PROJECT, ACTOR, SESSION],
    );
    await client!.query(
      `INSERT INTO kortix.session_lifecycle_commands
         (command_type, source, project_id, session_id, account_id, actor_user_id)
       VALUES ('continue', 'cli', $1, $2, $3, $4)`,
      [PROJECT, SESSION, ACCOUNT, ACTOR],
    );
    await client!.query(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, created_by, origin, status)
       VALUES ('a7600000-0000-4000-a000-000000000009', $1, $2, 'audit-uuid-v7-2', $3, 'user', 'queued')`,
      [ACCOUNT, PROJECT, ACTOR],
    );
    const projected = await client!.query<{ source_ledger: string; event_id: string }>(
      `SELECT source_ledger, event_id::text FROM kortix.audit_events
        WHERE account_id = $1 AND source_ledger IS NOT NULL`,
      [ACCOUNT],
    );
    expect(new Set(projected.rows.map((row) => row.source_ledger))).toEqual(
      new Set(['connector_calls', 'session_lifecycle_commands', 'project_sessions']),
    );
    for (const id of [...plain.rows, ...projected.rows].map((row) => row.event_id)) {
      expect(nibbles(id).version).toBe('7');
    }
    await client!.query(`SET kortix.audit_maintenance = 'on'`);
    await client!.query(`DELETE FROM kortix.project_sessions WHERE session_id = $1`, [
      'a7600000-0000-4000-a000-000000000009',
    ]);
    await client!.query(`SET kortix.audit_maintenance = 'off'`);
  });

  test('an explicit v4 id (an existing row) is stored unchanged', async () => {
    const legacy = 'a7600000-0000-4a00-8000-0000000000aa';
    const { rows } = await client!.query<{ event_id: string }>(
      `INSERT INTO kortix.audit_events(event_id, account_id, action, resource_type, authoritative_source)
       VALUES ($1, $2, 'test.uuid-v7.legacy', 'test', 'system') RETURNING event_id::text`,
      [legacy, ACCOUNT],
    );
    expect(rows[0]?.event_id).toBe(legacy);
  });

  test('the ORM writers (API emitters, relay ingest, queue) get the database default', async () => {
    // Every API writer calls `db.insert(auditEvents).values(row)` with no eventId.
    const db = drizzle(client!);
    const rows = await db
      .insert(auditEvents)
      .values([
        { accountId: ACCOUNT, action: 'test.uuid-v7.orm', resourceType: 'test' },
        { accountId: ACCOUNT, action: 'test.uuid-v7.orm', resourceType: 'test' },
      ])
      .onConflictDoNothing()
      .returning({ eventId: auditEvents.eventId });
    expect(rows).toHaveLength(2);
    for (const { eventId } of rows) expect(nibbles(eventId).version).toBe('7');
  });
});
