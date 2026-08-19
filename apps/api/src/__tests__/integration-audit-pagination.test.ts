import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { auditEvents } from '@kortix/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../shared/db';
import { buildAuditCursorCondition, parseAuditCursor } from '../shared/audit-query';

const databaseUrl = process.env.AUDIT_V2_DATABASE_URL;
const ACCOUNT = 'c7100000-0000-4000-a000-000000000001';
const OLDER = 'c7100000-0000-4000-a000-000000000011';
const NEWER = 'c7100000-0000-4000-a000-000000000012';

let client: pg.Client | null = null;

describe.skipIf(!databaseUrl)('audit cursor pagination — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT]);
    await client.query(`SET kortix.audit_maintenance = 'off'`);
    await client.query(
      `INSERT INTO kortix.audit_events
         (event_id, account_id, action, resource_type, occurred_at)
       VALUES
         ($1, $3, 'test.cursor.older', 'test', '2026-08-07T12:00:00.000123Z'),
         ($2, $3, 'test.cursor.newer', 'test', '2026-08-07T12:00:00.000987Z')`,
      [OLDER, NEWER, ACCOUNT],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT]);
    await client.end();
  });

  test('resolves the cursor event timestamp before ascending export pagination', async () => {
    const cursor = parseAuditCursor(`2026-08-07T12:00:00.000Z|${OLDER}`)!;
    const rows = await db
      .select({ eventId: auditEvents.eventId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.accountId, ACCOUNT),
          buildAuditCursorCondition(cursor, ACCOUNT, 'ascending'),
        ),
      )
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.eventId));

    expect(rows.map((row) => row.eventId)).toEqual([NEWER]);
  });

  test('resolves the cursor event timestamp before descending list pagination', async () => {
    const cursor = parseAuditCursor(`2026-08-07T12:00:00.000Z|${NEWER}`)!;
    const rows = await db
      .select({ eventId: auditEvents.eventId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.accountId, ACCOUNT),
          buildAuditCursorCondition(cursor, ACCOUNT, 'descending'),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.eventId));

    expect(rows.map((row) => row.eventId)).toEqual([OLDER]);
  });
});
