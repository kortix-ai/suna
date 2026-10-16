/**
 * `stops`: who stopped each stopped turn, keyed by the message id that started
 * it, so clients show "Stopped by <name>" to everyone else. The database is a
 * stub that answers by table and records each predicate as Postgres SQL; the
 * real query runs in `src/__tests__/integration-message-authors.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionLifecycleCommands, sessionTurns } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as realIdentity from './user-identity';

const SESSION = '55555555-5555-4555-8555-555555555555';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const AVERY = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';

let promptRows: Array<Record<string, unknown>> = [];
let stoppedTurns: Array<{ messageId: string | null; endError: Record<string, unknown> | null }> = [];
let turnPredicates: string[] = [];
const dialect = new PgDialect();

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (projection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (predicate: SQL) => {
          const rows = () => {
            if (table === sessionLifecycleCommands) return promptRows;
            if (table === sessionTurns && 'endError' in projection) {
              turnPredicates.push(dialect.sqlToQuery(predicate).sql);
              return stoppedTurns;
            }
            if (table === projectSessions) return [];
            return [];
          };
          const limit = async (n: number) => rows().slice(0, n);
          return {
            orderBy: () => ({ limit }),
            limit,
            // biome-ignore lint/suspicious/noThenProperty: awaitable query builder.
            then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
              Promise.resolve().then(rows).then(resolve, reject),
          };
        },
      }),
    }),
  },
}));
mock.module('./user-identity', () => ({
  ...realIdentity,
  resolveUserIdentities: async (ids: string[]) =>
    new Map(
      ids.map((id) => [
        id,
        id === AVERY
          ? { email: 'avery@example.test', displayName: 'Avery', avatarUrl: null, exists: true }
          : { email: null, displayName: null, avatarUrl: null, exists: false },
      ]),
    ),
}));

const { sessionMessageAuthors } = await import('./session-message-authors');
const session = { sessionId: SESSION, projectId: PROJECT, parentSessionId: null, metadata: {} };
const AVERY_AUTHOR = {
  kind: 'member' as const,
  user_id: AVERY,
  name: 'Avery',
  email: 'avery@example.test',
  avatar_url: null,
};

beforeEach(() => {
  promptRows = [];
  stoppedTurns = [];
  turnPredicates = [];
});

describe('sessionMessageAuthors stops', () => {
  test('names the member who stopped each turn, keyed by the message that started it', async () => {
    stoppedTurns = [
      { messageId: 'msg_stopped', endError: { name: 'UserStop', message: null, by: AVERY } },
      // A stopper who no longer resolves is left out rather than named wrong.
      { messageId: 'msg_gone', endError: { name: 'UserStop', message: null, by: GONE } },
    ];
    const result = await sessionMessageAuthors(session);
    expect(result.stops).toEqual({ msg_stopped: AVERY_AUTHOR });
  });

  test('reads only ended turns of this session a person stopped and the ledger names', async () => {
    await sessionMessageAuthors(session);
    expect(turnPredicates).toHaveLength(1);
    const [where] = turnPredicates;
    expect(where).toContain('"session_turns"."session_id" = $1');
    expect(where).toContain(`"session_turns"."state" = $2`);
    expect(where).toContain('"session_turns"."message_id" is not null');
    expect(where).toContain(`->>'name' = 'UserStop'`);
    expect(where).toContain(`->>'by' IS NOT NULL`);
  });

  test('is always present, {} when no turn was stopped by a person', async () => {
    promptRows = [
      { userId: AVERY, payload: { clientMessageId: 'q_1', wireMessageId: 'msg_sent' }, result: {} },
    ];
    const result = await sessionMessageAuthors(session);
    expect(result).toEqual({ authors: { msg_sent: AVERY_AUTHOR }, initial_author: null, stops: {} });
  });
});
