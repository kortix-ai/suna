/**
 * Integration test (real local DB): a keyset walk of the session list serves
 * every row, including rows whose `updated_at` differ only below a millisecond.
 *
 * `updated_at` is a microsecond column, but the cursor used to carry a JS Date
 * (milliseconds): the next page compared against the truncated value and
 * skipped a row sorted after the boundary row inside the same millisecond.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { loadProjectSessionInventory } from '../projects/lib/session-list';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const VIEWER = crypto.randomUUID();
const tag = crypto.randomUUID().slice(0, 8);

const page = (cursor: string | null) =>
  loadProjectSessionInventory({
    projectId: PROJECT,
    accountId: ACCOUNT,
    userId: VIEWER,
    effectiveRole: 'write' as never,
    scope: 'visible',
    boundCredentialSessionId: null,
    probeManageCapability: async () => false,
    limit: 1,
    cursor,
  });

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-list-cursor-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
  // Three rows inside one millisecond: .123900, .123500, .123100 (newest first).
  for (const [id, micros] of [['a', '123900'], ['b', '123500'], ['c', '123100']] as const) {
    await db.insert(projectSessions).values({
      sessionId: `${id}-${tag}`,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: `${id}-${tag}`,
      createdBy: VIEWER,
      visibility: 'project',
      metadata: {},
    });
    await db.execute(
      sql`UPDATE kortix.project_sessions SET updated_at = ${`2026-10-01T12:00:00.${micros}Z`}::timestamptz WHERE session_id = ${`${id}-${tag}`}`,
    );
  }
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('a one-row-per-page walk serves all three sub-millisecond rows, once each', async () => {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let step = 0; step < 6; step += 1) {
    const result = await page(cursor);
    seen.push(...result.items.map((item) => item.row.sessionId.replace(`-${tag}`, '')));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  expect(seen).toEqual(['a', 'b', 'c']);
});
