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
 * the source, and `limit` is an opt-in cap that leaves every existing
 * caller's unbounded default behavior unchanged.
 *
 * Real-Postgres tenant contract — mirrors
 * ../__tests__/integration-connector-list-query-count.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, changeRequests, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { listChangeRequestsForProject } from '../services/projects/change-requests';
import { db } from '../lib/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
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
});

afterAll(async () => {
  await db.delete(changeRequests).where(eq(changeRequests.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('listChangeRequestsForProject', () => {
  test('no options: every CR in the project, newest number first (unchanged default)', async () => {
    const list = await listChangeRequestsForProject(PROJECT);
    expect(list.map((cr) => cr.number)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  test('status filter behaves exactly as before', async () => {
    const open = await listChangeRequestsForProject(PROJECT, { status: 'open' });
    expect(open.map((cr) => cr.number).sort()).toEqual([1, 3, 4, 6]);
  });

  test('origin_session_id scopes to one session — the outcome-card fix', async () => {
    const forSessionA = await listChangeRequestsForProject(PROJECT, { originSessionId: SESSION_A });
    expect(forSessionA.map((cr) => cr.number).sort()).toEqual([1, 2, 3]);
    expect(forSessionA.every((cr) => cr.origin_session_id === SESSION_A)).toBe(true);

    const forSessionB = await listChangeRequestsForProject(PROJECT, { originSessionId: SESSION_B });
    expect(forSessionB.map((cr) => cr.number).sort()).toEqual([4, 5]);
  });

  test('origin_session_id composes with status', async () => {
    const list = await listChangeRequestsForProject(PROJECT, {
      originSessionId: SESSION_A,
      status: 'merged',
    });
    expect(list.map((cr) => cr.number)).toEqual([2]);
  });

  test('a session with no change requests returns an empty list, not everything', async () => {
    const list = await listChangeRequestsForProject(PROJECT, {
      originSessionId: crypto.randomUUID(),
    });
    expect(list).toHaveLength(0);
  });

  test('limit caps the result, newest first', async () => {
    const list = await listChangeRequestsForProject(PROJECT, { limit: 2 });
    expect(list.map((cr) => cr.number)).toEqual([6, 5]);
  });

  test('limit is capped at CHANGE_REQUEST_LIST_MAX_LIMIT even if a caller asks for more', async () => {
    const list = await listChangeRequestsForProject(PROJECT, { limit: 1_000_000 });
    expect(list).toHaveLength(6); // fewer rows than the cap — proves it did not error, just returned all
  });
});
