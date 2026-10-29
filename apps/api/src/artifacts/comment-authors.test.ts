import { afterEach, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let sessionReads = 0;
const queries: Array<{ sql: string; params: unknown[] }> = [];
const userReads: string[][] = [];
const sessions = [{ id: 'session-one', agentName: 'analyst', metadata: { custom_name: 'Reviewed report', name: 'Generated report' } }];
mock.module('../shared/db', () => ({ db: { select: () => ({ from: () => ({ where: async (query: SQL) => {
  sessionReads++;
  queries.push(new PgDialect().sqlToQuery(query));
  return sessions;
} }) }) } }));
mock.module('../projects/surface', () => ({ resolveUserIdentities: async (ids: string[]) => {
  userReads.push(ids);
  return new Map([['user-one', { displayName: 'Former project member', email: 'member@example.test' }], ['email-user', { displayName: null, email: 'email@example.test' }]]);
} }));
const { hydrateCommentAuthors } = await import('./comment-authors');
const scope = { accountId: 'account-one', projectId: 'project-one' };
afterEach(() => { sessionReads = 0; queries.length = 0; userReads.length = 0; });

test('human authors retain raw identifiers and resolve independently of current project membership', async () => {
  const comments = [
    { comment_id: 'one', body: 'A comment', author_user_id: 'user-one', author_session_id: null },
    { comment_id: 'two', body: '', author_user_id: 'email-user', author_session_id: null },
    { comment_id: 'three', body: '', author_user_id: 'missing-user', author_session_id: null },
  ];
  const hydrated = await hydrateCommentAuthors(scope, comments);
  expect(hydrated[0]).toEqual({ ...comments[0], author: { kind: 'user', user_id: 'user-one', name: 'Former project member' } });
  expect(hydrated[1]!.author).toEqual({ kind: 'user', user_id: 'email-user', name: 'email@example.test' });
  expect(hydrated[2]!.author).toEqual({ kind: 'user', user_id: 'missing-user', name: 'Former user' });
  expect(sessionReads).toBe(0);
});

test('session author reads scope both account and project and prefer the custom title', async () => {
  const hydrated = await hydrateCommentAuthors(scope, [
    { author_user_id: null, author_session_id: 'session-one' },
    { author_user_id: null, author_session_id: 'session-one' },
    { author_user_id: null, author_session_id: 'missing-session' },
  ]);
  expect(hydrated[0]!.author).toEqual({ kind: 'session', session_id: 'session-one', agent_name: 'analyst', title: 'Reviewed report' });
  expect(hydrated[2]!.author).toEqual({ kind: 'session', session_id: 'missing-session', agent_name: 'unknown', title: null });
  expect(sessionReads).toBe(1);
  expect(queries[0]!.sql).toContain('"project_sessions"."account_id" =');
  expect(queries[0]!.sql).toContain('"project_sessions"."project_id" =');
  expect(queries[0]!.params).toContain(scope.accountId);
  expect(queries[0]!.params).toContain(scope.projectId);
  expect(queries[0]!.params.filter((value) => value === 'session-one')).toHaveLength(1);
});

test('empty comment lists do not read identities or sessions', async () => {
  expect(await hydrateCommentAuthors(scope, [])).toEqual([]);
  expect(sessionReads).toBe(0);
  expect(userReads).toEqual([]);
});
