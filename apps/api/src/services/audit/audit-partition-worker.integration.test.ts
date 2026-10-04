import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { ensureAuditPartitions } from './audit-partition-worker';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'b9100000-0000-4000-a000-000000000001';

let client: pg.Client | null = null;

describe.skipIf(!databaseUrl)('audit partition maintenance — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query(`DELETE FROM kortix.audit_events WHERE account_id = $1`, [ACCOUNT]);
    await client.end();
  });

  test('is a no-op while the next 8 weeks exist, and extends the range when the calendar moves', async () => {
    const quiet = await ensureAuditPartitions();
    expect(quiet).toEqual({ created: 0, defaultPartitionHasRows: false });
    // 12 weeks ahead stands in for "four weeks later": the weeks past the migration's range appear.
    const later = await ensureAuditPartitions(12);
    expect(later.created).toBe(4);
    expect((await ensureAuditPartitions(12)).created).toBe(0);
  });

  test('reports rows stranded in the default partition', async () => {
    // Far enough ahead that no weekly partition exists yet, so the row lands in the default one.
    await client!.query(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at)
       VALUES ($1, 'test.partition.stray', 'test', 'system', now() + interval '400 days')`,
      [ACCOUNT],
    );
    expect((await ensureAuditPartitions()).defaultPartitionHasRows).toBe(true);
  });
});
