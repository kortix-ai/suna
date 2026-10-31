import { expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';

const statements: string[] = [];
const db = drizzle(async (query) => {
  statements.push(query);
  return { rows: [] };
});
mock.module('../../shared/db', () => ({ db, hasDatabase: true, withDbTransaction: db.transaction.bind(db), afterDbCommit: async () => undefined }));

const { firePeerIdleNotices } = await import('./service');

test('idle-notice watch claiming correlates the lifecycle receipt to the outer peer message', async () => {
  expect(await firePeerIdleNotices({ sessionId: 'synthetic-receiver', outcome: 'idle', excerpt: null })).toBe(0);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("'peer:' || \"kortix\".\"session_peer_messages\".\"id\"");
  expect(statements[0]).toContain('exists (select 1 from "kortix"."session_lifecycle_commands"');
  expect(statements[1]).not.toContain('exists');
});
