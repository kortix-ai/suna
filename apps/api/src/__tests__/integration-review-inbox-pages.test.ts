/**
 * The Review inbox read every review item and every change request of the
 * project on each poll and filtered in memory (KRTX-1727 scenario F). It is now
 * one bounded page per request, filtered in SQL, and the always-mounted
 * counters read `reviewSummary` (KRTX-2316).
 *
 * Real Postgres: the keyset predicate, the segment rank and the microsecond
 * cursor are SQL, so only a real database proves them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  changeRequests,
  connectorCalls,
  projectSessions,
  projects,
  reviewItems,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ApprovalCaller } from '../projects/lib/approval-authority';
import {
  type InboxCursor,
  REVIEW_PAGE_MAX_LIMIT,
  decodeInboxCursor,
  getInboxItem,
  listInboxItems,
  reviewSummary,
} from '../projects/review-items';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const LAUNCHER = crypto.randomUUID();
const OTHER = crypto.randomUUID();
/** A session LAUNCHER started: LAUNCHER may resolve its calls. */
const USER_SESSION = crypto.randomUUID();
/** A backend session: only a manager may resolve its calls. */
const BACKEND_SESSION = crypto.randomUUID();
const DONE_COUNT = 5_000;

const human = (over: Partial<ApprovalCaller>): ApprovalCaller => ({
  isManager: false,
  callerUserId: LAUNCHER,
  callerAuthType: 'supabase',
  callerCredentialKind: 'jwt',
  callerSessionId: null,
  ...over,
});
const asLauncher = async () => human({});
const asManager = async () => human({ isManager: true, callerUserId: OTHER });
const asMember = async () => human({ callerUserId: OTHER });
// The manager read view (`projectReadView`): no row filter.
const FULL_VIEW = { where: () => undefined, allows: async () => true };

const NATIVE_PENDING: string[] = [];
let tiedIds: string[] = [];

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'review-inbox-pages-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'review-inbox-pages-test',
    repoUrl: 'https://example.test/review-inbox-pages.git',
  });
  await db.insert(projectSessions).values([
    {
      sessionId: USER_SESSION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: USER_SESSION,
      createdBy: LAUNCHER,
      origin: 'user',
    },
    {
      sessionId: BACKEND_SESSION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: BACKEND_SESSION,
      createdBy: LAUNCHER,
      origin: 'backend',
    },
  ]);
  const base = Date.parse('2026-07-01T00:00:00.000Z');
  // 5,000 done items, older than everything pending.
  for (let start = 0; start < DONE_COUNT; start += 1_000) {
    await db.insert(reviewItems).values(
      Array.from({ length: 1_000 }, (_, i) => ({
        accountId: ACCOUNT,
        projectId: PROJECT,
        kind: 'output' as const,
        status: (i % 2 ? 'done' : 'approved') as 'done' | 'approved',
        title: `done ${start + i}`,
        createdBy: LAUNCHER,
        originSessionId: USER_SESSION,
        createdAt: new Date(base + (start + i) * 1_000),
      })),
    );
  }
  // 1 pending native item on the user session, 1 with no session.
  const pending = await db
    .insert(reviewItems)
    .values([
      {
        accountId: ACCOUNT,
        projectId: PROJECT,
        kind: 'decision' as const,
        status: 'needs_you' as const,
        title: 'pending on a session',
        createdBy: LAUNCHER,
        originSessionId: USER_SESSION,
        createdAt: new Date(base - 60_000),
      },
      {
        accountId: ACCOUNT,
        projectId: PROJECT,
        kind: 'output' as const,
        status: 'needs_you' as const,
        title: 'pending without a session',
        createdBy: LAUNCHER,
        createdAt: new Date(base - 120_000),
      },
    ])
    .returning({ id: reviewItems.reviewItemId });
  NATIVE_PENDING.push(...pending.map((row) => row.id));
  // One open CR (needs you), two closed (done).
  await db.insert(changeRequests).values(
    [1, 2, 3].map((number) => ({
      accountId: ACCOUNT,
      projectId: PROJECT,
      number,
      title: `CR ${number}`,
      baseRef: 'main',
      headRef: `branch-${number}`,
      status: number === 1 ? ('open' as const) : ('closed' as const),
      originSessionId: USER_SESSION,
      createdBy: LAUNCHER,
      createdAt: new Date(base + number * 500),
    })),
  );
  // Two pending connector calls: the launcher may resolve the first only.
  await db.insert(connectorCalls).values([
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      actionPath: 'gmail.send_email',
      actingUserId: LAUNCHER,
      sessionId: USER_SESSION,
      status: 'pending_approval',
      risk: 'write',
    },
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      actionPath: 'gmail.send_email',
      actingUserId: LAUNCHER,
      sessionId: BACKEND_SESSION,
      status: 'pending_approval',
      risk: 'write',
    },
  ]);
  // Three done items in the same millisecond, apart by microseconds, and two
  // with the exact same instant: the cursor must page through all five.
  const tied = await db
    .insert(reviewItems)
    .values(
      Array.from({ length: 5 }, (_, i) => ({
        accountId: ACCOUNT,
        projectId: PROJECT,
        kind: 'batch' as const,
        status: 'dismissed' as const,
        title: `tied ${i}`,
        createdBy: LAUNCHER,
      })),
    )
    .returning({ id: reviewItems.reviewItemId });
  tiedIds = tied.map((row) => row.id);
  const micros = ['100', '900', '500', '500', '500'];
  for (const [i, id] of tiedIds.entries()) {
    await db.execute(
      sql`update kortix.review_items set created_at = ${`2027-01-01T00:00:00.123${micros[i]}Z`}::timestamptz where review_item_id = ${id}`,
    );
  }
});

afterAll(async () => {
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, PROJECT));
  await db.delete(reviewItems).where(eq(reviewItems.projectId, PROJECT));
  await db.delete(changeRequests).where(eq(changeRequests.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function walkAll(
  query: Parameters<typeof listInboxItems>[1],
  caller: () => Promise<ApprovalCaller>,
  start: InboxCursor | null = null,
) {
  const items: Awaited<ReturnType<typeof listInboxItems>>['items'] = [];
  let after = start;
  for (let i = 0; i < 200; i += 1) {
    const page = await listInboxItems(PROJECT, { ...query, after }, caller, FULL_VIEW);
    expect(page.items.length).toBeLessThanOrEqual(query.limit ?? 50);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    after = decodeInboxCursor(page.nextCursor);
  }
  throw new Error('the cursor never ended');
}

describe('reviewSummary', () => {
  test('counts what needs the caller, by session, in under 2 KB', async () => {
    const summary = await reviewSummary(PROJECT, asLauncher, FULL_VIEW);
    // 2 native + 1 open CR + 1 call the launcher may resolve.
    expect(summary).toEqual({
      needs_you_total: 4,
      needs_you_by_session: { [USER_SESSION]: 3 },
    });
    expect(JSON.stringify(summary).length).toBeLessThan(2_048);
  });

  test('a call the caller may not resolve is Waiting and counts nowhere', async () => {
    expect((await reviewSummary(PROJECT, asMember, FULL_VIEW)).needs_you_total).toBe(3);
    expect(await reviewSummary(PROJECT, asManager, FULL_VIEW)).toEqual({
      needs_you_total: 5,
      needs_you_by_session: { [USER_SESSION]: 3, [BACKEND_SESSION]: 1 },
    });
  });

  test('agrees with the needs_you segment of the list', async () => {
    for (const caller of [asLauncher, asMember, asManager]) {
      const summary = await reviewSummary(PROJECT, caller, FULL_VIEW);
      const needsYou = await walkAll({ segment: 'needs_you', limit: REVIEW_PAGE_MAX_LIMIT }, caller);
      expect(needsYou).toHaveLength(summary.needs_you_total);
    }
  });
});

describe('listInboxItems', () => {
  test('page one of an unsegmented list holds every pending item first', async () => {
    const page = await listInboxItems(PROJECT, { limit: 10 }, asLauncher, FULL_VIEW);
    expect(page.items.slice(0, 5).map((item) => item.status)).toEqual([
      'needs_you',
      'needs_you',
      'needs_you',
      'needs_you',
      'waiting',
    ]);
    expect(page.items.slice(5).every((item) => !['needs_you', 'waiting'].includes(item.status))).toBe(
      true,
    );
    expect(page.nextCursor).not.toBeNull();
  });

  test('the done segment pages through every row once, newest first', async () => {
    const done = await walkAll({ segment: 'done', limit: REVIEW_PAGE_MAX_LIMIT }, asLauncher);
    const ids = done.map((item) => item.review_item_id);
    expect(ids).toHaveLength(DONE_COUNT + 2 + tiedIds.length);
    expect(new Set(ids).size).toBe(ids.length);
    const times = done.map((item) => item.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test('rows that share a millisecond or an instant page apart with no gap or repeat', async () => {
    const tied = await walkAll({ segment: 'done', kind: 'batch', limit: 1 }, asLauncher);
    expect(tied.map((item) => item.review_item_id).sort()).toEqual([...tiedIds].sort());
    expect(tied[0].review_item_id).toBe(tiedIds[1]);
    expect(tied[tied.length - 1].review_item_id).toBe(tiedIds[0]);
  });

  // `done 1` (a native item) and CR #2 share the instant base + 1 s. With
  // limit 1 a page ends on the native row, and the CR query must still return
  // the CR after that cursor: the source tie decides it in SQL.
  test('a native item and a change request at the same instant page apart in source order', async () => {
    const [done2] = await db
      .select({ id: reviewItems.reviewItemId })
      .from(reviewItems)
      .where(and(eq(reviewItems.projectId, PROJECT), eq(reviewItems.title, 'done 2')));
    const start = { rank: 2, at: '2026-07-01T00:00:02.000000Z', source: 0, id: done2.id };
    const rows = await walkAll({ segment: 'done', limit: 1 }, asLauncher, start);
    expect(rows.map((item) => item.title)).toEqual(['CR 3', 'done 1', 'CR 2', 'done 0']);
  });

  test('kind and session filters apply in SQL', async () => {
    const changes = await walkAll({ kind: 'change', limit: 2 }, asLauncher);
    expect(changes.map((item) => item.review_item_id.startsWith('cr:'))).toEqual([true, true, true]);
    expect(changes[0].status).toBe('needs_you');
    const backend = await walkAll({ sessionId: BACKEND_SESSION }, asManager);
    expect(backend.map((item) => [item.kind, item.status])).toEqual([['approval', 'needs_you']]);
  });

  test('a call the caller may not resolve is under Waiting with no arguments', async () => {
    const waiting = await walkAll({ segment: 'waiting' }, asLauncher);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: 'approval', can_resolve: false, resolvers: 'managers' });
  });

  test('getInboxItem reads any item by id, off every page, with the list verdict', async () => {
    const [closed] = await db
      .select({ crId: changeRequests.crId })
      .from(changeRequests)
      .where(and(eq(changeRequests.projectId, PROJECT), eq(changeRequests.number, 3)));
    const [backendCall] = await db
      .select({ executionId: connectorCalls.executionId })
      .from(connectorCalls)
      .where(sql`${connectorCalls.sessionId}::text = ${BACKEND_SESSION}`);
    expect(await getInboxItem(PROJECT, `cr:${closed.crId}`, asLauncher, FULL_VIEW)).toMatchObject({
      kind: 'change',
      status: 'rejected',
    });
    expect(await getInboxItem(PROJECT, `call:${backendCall.executionId}`, asLauncher, FULL_VIEW)).toMatchObject({
      status: 'waiting',
      can_resolve: false,
    });
    expect(await getInboxItem(PROJECT, `call:${backendCall.executionId}`, asManager, FULL_VIEW)).toMatchObject({
      status: 'needs_you',
      can_resolve: true,
    });
    expect(await getInboxItem(PROJECT, tiedIds[0], asLauncher, FULL_VIEW)).toMatchObject({ kind: 'batch' });
    for (const id of ['cr:not-a-uuid', 'call:', 'garbage', `cr:${crypto.randomUUID()}`]) {
      expect(await getInboxItem(PROJECT, id, asLauncher, FULL_VIEW)).toBeNull();
    }
  });

  test('the pending native items are the ones the summary counts', async () => {
    const needsYou = await walkAll({ segment: 'needs_you', kind: 'decision' }, asLauncher);
    expect(needsYou.map((item) => item.review_item_id)).toEqual([NATIVE_PENDING[0]]);
    const rows = await db
      .select({ id: reviewItems.reviewItemId })
      .from(reviewItems)
      .where(inArray(reviewItems.reviewItemId, NATIVE_PENDING));
    expect(rows).toHaveLength(2);
  });
});
