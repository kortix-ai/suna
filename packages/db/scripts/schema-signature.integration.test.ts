import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const SIGNATURE_SQL = readFileSync(join(import.meta.dir, 'schema-signature.sql'), 'utf8');

describe.skipIf(!databaseUrl)('schema-signature.sql ignores runtime-created audit partitions', () => {
  let client: pg.Client;
  const signature = async () => {
    const results = (await client.query(SIGNATURE_SQL)) as unknown as Array<{ rows: Array<Record<string, string>> }>;
    return results.flatMap((r) => r.rows.map((row) => Object.values(row)[0]!)).join('\n');
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    for (const t of ['audit_events_p19990104', 'audit_events_p_declared']) {
      await client.query(
        `CREATE TABLE kortix.${t} (id integer PRIMARY KEY, at timestamptz NOT NULL);
         CREATE INDEX ${t}_at_idx ON kortix.${t} (at);`,
      );
    }
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS kortix.audit_events_p19990104, kortix.audit_events_p_declared');
    await client.end();
  });

  test('a weekly partition name adds no COL, IDX or CON line; a declared table named alike still does', async () => {
    const sig = await signature();
    expect(sig).not.toContain('audit_events_p19990104');
    expect(sig).toContain('COL|audit_events_p_declared.id|');
    expect(sig).toContain('IDX|audit_events_p_declared_at_idx|');
    expect(sig).toContain('CON|kortix.audit_events_p_declared|audit_events_p_declared_pkey|');
  });
});
