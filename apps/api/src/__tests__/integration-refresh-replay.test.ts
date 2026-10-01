import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';

// Run against migrated local PostgreSQL: a mock Set cannot validate the SQL constraint.
const token = randomUUID();
const digest = createHash('sha256').update(token).digest('hex');

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.used_refresh_tokens WHERE token_hash = ${digest}`);
});

describe('refresh claim across concurrent requests', () => {
  test('only one request claims a token and a later replay cannot claim it', async () => {
    const claim = () => db.execute<{ token_hash: string }>(sql`
      INSERT INTO kortix.used_refresh_tokens (token_hash, expires_at)
      VALUES (${digest}, now() + interval '90 days')
      ON CONFLICT DO NOTHING RETURNING token_hash
    `);
    const results = await Promise.all(Array.from({ length: 8 }, claim));
    expect(results.map((rows) => rows.length).sort()).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(await claim()).toHaveLength(0);
  });
});
