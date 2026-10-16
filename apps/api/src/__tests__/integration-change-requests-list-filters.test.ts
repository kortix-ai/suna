/**
 * GET /:projectId/change-requests returned every change request the project
 * ever opened — 565KB on a busy prod project, with no pagination and no way
 * to scope to one session. The session "outcome" cards
 * (apps/web session-outcomes-provider) fetched that whole list every 60s per
 * open session thread just to filter it down to the 1-2 CRs that session
 * opened.
 *
 * `listChangeRequestsForProject` (../change-requests.ts) is the extracted,
 * unit-testable core of the route: `origin_session_id` scopes the query at
 * the source, and every read is one keyset page (default 50, newest number
 * first) with a `next_cursor` (KRTX-2316).
 *
 * Real-Postgres tenant contract — mirrors
 * ../__tests__/integration-connector-list-query-count.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, changeRequests, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import {
  CHANGE_REQUEST_LIST_DEFAULT_LIMIT,
  decodeChangeRequestCursor,
  listChangeRequestsForProject,
} from '../projects/change-requests';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
/** A second project with more change requests than one default page. */
const BIG_PROJECT = crypto.randomUUID();
const BIG_COUNT = 120;
const USER = crypto.randomUUID();
const SESSION_A = crypto.randomUUID();
const SESSION_B = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'cr-list-filters-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'cr-list-filters-test',
    repoUrl: 'https://example.test/cr-list-filters.git',
  });
  await db.insert(projectSessions).values([
    {
      sessionId: SESSION_A,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_A,
      createdBy: USER,
      visibility: 'private',
    },
    {
      sessionId: SESSION_B,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_B,
      createdBy: USER,
      visibility: 'private',
    },
  ]);
  // 3 CRs from session A (1 merged), 2 from session B, 1 with no session.
  await db.insert(changeRequests).values([
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 1,
      title: 'A-1',
      baseRef: 'main',
      headRef: SESSION_A,
      status: 'open',
      originSessionId: SESSION_A,
      createdBy: USER,
    },
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 2,
      title: 'A-2 merged',
      baseRef: 'main',
      headRef: SESSION_A,
      status: 'merged',
      originSessionId: SESSION_A,
      createdBy: USER,
    },
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 3,
      title: 'A-3',
      baseRef: 'main',
      headRef: SESSION_A,
      status: 'open',
      originSessionId: SESSION_A,
      createdBy: USER,
    },
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 4,
      title: 'B-1',
      baseRef: 'main',
      headRef: SESSION_B,
      status: 'open',
      originSessionId: SESSION_B,
      createdBy: USER,
    },
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 5,
      title: 'B-2',
      baseRef: 'main',
      headRef: SESSION_B,
      status: 'closed',
      originSessionId: SESSION_B,
      createdBy: USER,
    },
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 6,
      title: 'no session',
      baseRef: 'main',
      headRef: 'manual-branch',
      status: 'open',
      createdBy: USER,
    },
  ]);
  await db.insert(projects).values({
    projectId: BIG_PROJECT,
    accountId: ACCOUNT,
    name: 'cr-list-pages-test',
    repoUrl: 'https://example.test/cr-list-pages.git',
  });
  await db.insert(changeRequests).values(
    Array.from({ length: BIG_COUNT }, (_, i) => ({
      accountId: ACCOUNT,
      projectId: BIG_PROJECT,
      number: i + 1,
      title: `CR ${i + 1}`,
      baseRef: 'main',
      headRef: `branch-${i + 1}`,
      status: i % 3 === 0 ? ('open' as const) : ('closed' as const),
      createdBy: USER,
    })),
  );
});

afterAll(async () => {
  for (const projectId of [PROJECT, BIG_PROJECT]) {
    await db.delete(changeRequests).where(eq(changeRequests.projectId, projectId));
    await db.delete(projectSessions).where(eq(projectSessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.projectId, projectId));
  }
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const numbers = (page: Awaited<ReturnType<typeof listChangeRequestsForProject>>) =>
  page.change_requests.map((cr) => cr.number);

describe('listChangeRequestsForProject', () => {
  test('no options: the project fits one page, newest number first, no cursor', async () => {
    const page = await listChangeRequestsForProject(PROJECT);
    expect(numbers(page)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(page.next_cursor).toBeNull();
  });

  test('status filter behaves exactly as before', async () => {
    const open = await listChangeRequestsForProject(PROJECT, { status: 'open' });
    expect(numbers(open).sort()).toEqual([1, 3, 4, 6]);
  });

  test('origin_session_id scopes to one session — the outcome-card fix', async () => {
    const forSessionA = await listChangeRequestsForProject(PROJECT, { originSessionId: SESSION_A });
    expect(numbers(forSessionA).sort()).toEqual([1, 2, 3]);
    expect(forSessionA.change_requests.every((cr) => cr.origin_session_id === SESSION_A)).toBe(true);

    const forSessionB = await listChangeRequestsForProject(PROJECT, { originSessionId: SESSION_B });
    expect(numbers(forSessionB).sort()).toEqual([4, 5]);
  });

  test('origin_session_id composes with status', async () => {
    const page = await listChangeRequestsForProject(PROJECT, {
      originSessionId: SESSION_A,
      status: 'merged',
    });
    expect(numbers(page)).toEqual([2]);
  });

  test('a session with no change requests returns an empty list, not everything', async () => {
    const page = await listChangeRequestsForProject(PROJECT, {
      originSessionId: crypto.randomUUID(),
    });
    expect(page).toEqual({ change_requests: [], next_cursor: null });
  });

  test('limit caps the page, newest first, and the cursor names where it stopped', async () => {
    const page = await listChangeRequestsForProject(PROJECT, { limit: 2 });
    expect(numbers(page)).toEqual([6, 5]);
    expect(page.next_cursor).toBe('5');
  });

  test('limit is clamped at CHANGE_REQUEST_LIST_MAX_LIMIT (the route answers 400 first)', async () => {
    const page = await listChangeRequestsForProject(BIG_PROJECT, { limit: 1_000_000 });
    expect(page.change_requests).toHaveLength(BIG_COUNT);
    expect(page.next_cursor).toBeNull();
  });
});

describe('listChangeRequestsForProject pages (KRTX-2316)', () => {
  test('without a limit a busy project returns one default page and a cursor', async () => {
    const page = await listChangeRequestsForProject(BIG_PROJECT);
    expect(page.change_requests).toHaveLength(CHANGE_REQUEST_LIST_DEFAULT_LIMIT);
    expect(numbers(page)[0]).toBe(BIG_COUNT);
    expect(page.next_cursor).toBe(String(BIG_COUNT - CHANGE_REQUEST_LIST_DEFAULT_LIMIT + 1));
  });

  test('following the cursor returns every change request once', async () => {
    for (const status of ['all', 'open'] as const) {
      const seen: number[] = [];
      let cursor: number | undefined;
      let ended = false;
      for (let i = 0; i < 100 && !ended; i += 1) {
        const page = await listChangeRequestsForProject(BIG_PROJECT, { status, limit: 7, cursor });
        seen.push(...numbers(page));
        ended = page.next_cursor === null;
        cursor = page.next_cursor ? (decodeChangeRequestCursor(page.next_cursor) ?? undefined) : undefined;
      }
      expect(ended).toBe(true);
      const expected = Array.from({ length: BIG_COUNT }, (_, i) => BIG_COUNT - i).filter(
        (n) => status === 'all' || (n - 1) % 3 === 0,
      );
      expect(seen).toEqual(expected);
    }
  });

  test('decodeChangeRequestCursor accepts a page number and nothing else', () => {
    expect(decodeChangeRequestCursor('51')).toBe(51);
    for (const raw of ['0', '-1', '1.5', 'abc', '99999999999', "1' or 1=1"]) {
      expect(decodeChangeRequestCursor(raw)).toBeNull();
    }
  });
});
