/**
 * KRTX-4437: `GET /approvals` and `GET /approvals/needs-input` read the same
 * pending-approval set, and needs-input counts open agent questions and
 * permission asks with the same unresolved-and-unexpired rule. The SQL each
 * read sends is rendered and pinned, so building the predicates once changes
 * nothing the database sees.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import type { QueryWithTypings, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
let wheres: SQL[];

const query = (rows: unknown[]) => {
  const stage = {
    orderBy: () => stage,
    limit: async () => rows,
    // biome-ignore lint/suspicious/noThenProperty: awaitable query builder.
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return stage;
};
const realDb = await import('../../shared/db');
mock.module('../../shared/db', () => ({
  ...realDb,
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: SQL) => {
          wheres.push(predicate);
          return query([]);
        },
      }),
    }),
  },
}));
const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({ userId: 'u1', row: { accountId: 'a1' } }),
  assertProjectCapability: async () => {},
  lookupEmailsByUserIds: async () => new Map(),
}));
const realSpaces = await import('../../shared/space-access');
mock.module('../../shared/space-access', () => ({
  ...realSpaces,
  hiddenSpaceIds: async () => new Set(),
  sessionsInSpaces: async () => new Set(),
}));
const { projectsApp } = await import('../lib/app');
(await import('./approvals')).registerApprovalsRoutes();

const dialect = new PgDialect();
const rendered = () => wheres.map((where) => dialect.sqlToQuery(where));
beforeEach(() => {
  wheres = [];
});

const T = '"kortix"."connector_calls"';
const PENDING_APPROVAL: QueryWithTypings = {
  sql:
    `(${T}."project_id" = $1 and ${T}."status" = $2 and ${T}."approved_by" is null and ` +
    `${T}."resolved_at" is null and (${T}."expires_at" is null or ${T}."expires_at" > now()))`,
  params: [PROJECT_ID, 'pending_approval'],
  typings: ['uuid', 'none'],
};
const openAsk = (table: string, resolved: string): QueryWithTypings => ({
  sql:
    `("kortix"."${table}"."project_id" = $1 and "kortix"."${table}"."${resolved}" is null and ` +
    `("kortix"."${table}"."expires_at" is null or "kortix"."${table}"."expires_at" > NOW()))`,
  params: [PROJECT_ID],
  typings: ['uuid'],
});

test('GET /approvals filters the project, pending_approval, unapproved, unresolved and unexpired', async () => {
  expect((await projectsApp.request(`/${PROJECT_ID}/approvals`)).status).toBe(200);
  expect(rendered()).toEqual([PENDING_APPROVAL]);
});

test('GET /approvals/needs-input sends the same pending-approval filter, then the open question and permission filters', async () => {
  expect((await projectsApp.request(`/${PROJECT_ID}/approvals/needs-input`)).status).toBe(200);
  expect(rendered()).toEqual([
    PENDING_APPROVAL,
    openAsk('session_pending_questions', 'answered_at'),
    openAsk('session_pending_permissions', 'decided_at'),
  ]);
});
