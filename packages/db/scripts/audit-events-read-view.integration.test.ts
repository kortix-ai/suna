import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'a7700000-0000-4000-a000-000000000001';

let client: pg.Client | null = null;

describe.skipIf(!databaseUrl)('kortix.audit_events_all — the one relation audit reads go through', () => {
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

  test('exposes exactly the columns of kortix.audit_events, in the same order and types', async () => {
    // A column added to audit_events but not to the view is invisible to every
    // audit read. The view expands `SELECT *` once, at creation, so the next
    // ADD COLUMN migration must redefine it; this test is the reminder.
    const columns = (relation: string) =>
      client!.query<{ column_name: string; data_type: string }>(
        `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type
           FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [relation],
      );
    const table = await columns('kortix.audit_events');
    const view = await columns('kortix.audit_events_all');
    expect(view.rows.length).toBeGreaterThan(40);
    expect(view.rows).toEqual(table.rows);
  });

  test('returns rows written to kortix.audit_events', async () => {
    const inserted = await client!.query<{ event_id: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
       VALUES ($1, 'test.read-view', 'test', 'system') RETURNING event_id`,
      [ACCOUNT],
    );
    const read = await client!.query<{ event_id: string }>(
      `SELECT event_id FROM kortix.audit_events_all WHERE account_id = $1`,
      [ACCOUNT],
    );
    expect(read.rows).toEqual(inserted.rows);
  });

  test('grants the roles the table grants', async () => {
    const roles = await client!.query<{ rolname: string }>(
      `SELECT DISTINCT r.rolname
         FROM pg_class c, aclexplode(c.relacl) a
         JOIN pg_roles r ON r.oid = a.grantee
        WHERE c.oid = 'kortix.audit_events'::regclass AND a.privilege_type = 'SELECT'`,
    );
    for (const { rolname } of roles.rows) {
      const { rows } = await client!.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, 'kortix.audit_events_all', 'SELECT') AS ok`,
        [rolname],
      );
      expect([rolname, rows[0]?.ok]).toEqual([rolname, true]);
    }
  });
});
