import { expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { readRewoundMessageFloor } from './session-history';

test.each([
  { floor: null, expected: null },
  { floor: 'msg_000000000010abcdefghijklmn', expected: 16n },
])('reserved history clock remains session scoped: %s', async ({ floor, expected }) => {
  let condition: SQL | undefined;
  const database = {
    select: () => ({ from: () => ({ where: (value: SQL) => {
      condition = value;
      return { limit: async () => [{ floor }] };
    } }) }),
  } as unknown as Pick<Database, 'select'>;
  const sessionId = '00000000-0000-4000-8000-000000000739';
  expect(await readRewoundMessageFloor(database, sessionId)).toBe(expected);
  const query = new PgDialect().sqlToQuery(condition!);
  expect(query.params).toEqual([sessionId]);
  expect(query.sql).toContain('"session_worker_log"."session_id"');
  expect(query.sql).toContain("->>'kind' = 'history'");
});
