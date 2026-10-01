import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { auditEvents } from '@kortix/db';
import pg from 'pg';
import { parseAuditSessionCursor, readSessionAuditEvents } from '../shared/audit-query';
import { db } from '../shared/db';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'c7200000-0000-4000-a000-000000000001';
const SESSION = 'c7200000-0000-4000-a000-0000000000a1';
// Rows written before the lock-free ingest carry a session_sequence and a random
// (v4) event_id whose order is unrelated to the sequence.
const LEGACY = [
  { id: 'c7200000-0000-4000-8000-0000000000f3', sequence: 3 },
  { id: 'c7200000-0000-4000-8000-0000000000f1', sequence: 1 },
  { id: 'c7200000-0000-4000-8000-0000000000f2', sequence: 2 },
];

let client: pg.Client | null = null;

async function readAll(limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: ReturnType<typeof parseAuditSessionCursor> = null;
  for (let page = 0; page < 20; page += 1) {
    const { rows, nextCursor } = await readSessionAuditEvents(db, SESSION, cursor, limit);
    expect(rows.length).toBeLessThanOrEqual(limit);
    ids.push(...rows.map((row) => row.eventId));
    if (!nextCursor) return ids;
    cursor = parseAuditSessionCursor(nextCursor);
  }
  throw new Error('session log did not terminate');
}

describe.skipIf(!databaseUrl)('session audit log order — migrated PostgreSQL', () => {
  let fresh: string[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT]);
    await client.query(`SET kortix.audit_maintenance = 'off'`);
    for (const row of LEGACY) {
      await client.query(
        `INSERT INTO kortix.audit_events
           (event_id, account_id, session_id, session_sequence, action, resource_type)
         VALUES ($1, $2, $3, $4, 'test.legacy', 'test')`,
        [row.id, ACCOUNT, SESSION, row.sequence],
      );
    }
    // Five rows from ONE statement (a relay batch): v7 ids sort in insertion order.
    const inserted = await db
      .insert(auditEvents)
      .values(
        Array.from({ length: 5 }, (_, index) => ({
          accountId: ACCOUNT,
          sessionId: SESSION,
          action: `test.fresh.${index}`,
          resourceType: 'test',
        })),
      )
      .returning({ eventId: auditEvents.eventId });
    fresh = inserted.map((row) => row.eventId);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT]);
    await client.end();
  });

  test('sequenced rows first by sequence, then unsequenced rows in event_id order', async () => {
    const expected = [...LEGACY].sort((a, b) => a.sequence - b.sequence).map((r) => r.id).concat(fresh);
    expect(await readAll(1000)).toEqual(expected);
  });

  test('cursors page through both groups without a gap or a repeat, at every page size', async () => {
    const expected = [...LEGACY].sort((a, b) => a.sequence - b.sequence).map((r) => r.id).concat(fresh);
    for (const limit of [1, 2, 3, 4, 7]) expect(await readAll(limit)).toEqual(expected);
  });

  test('a cursor into the unsequenced group (sequence 0) resumes after that event', async () => {
    const { rows } = await readSessionAuditEvents(db, SESSION, { sequence: 0, eventId: fresh[1]! }, 10);
    expect(rows.map((row) => row.eventId)).toEqual(fresh.slice(2));
  });

  test('the last page has no cursor', async () => {
    const { rows, nextCursor } = await readSessionAuditEvents(db, SESSION, null, 100);
    expect(rows).toHaveLength(8);
    expect(nextCursor).toBeNull();
  });
});
