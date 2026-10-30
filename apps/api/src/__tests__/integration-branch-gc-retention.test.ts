/**
 * Integration test (real local PostgreSQL, fully migrated): the session branch
 * GC. A live session loses its branch after 90 idle days. A deleted session
 * keeps its branch for its 30-day restore window (KRTX-2316: a delete keeps
 * `updated_at`, so idle time alone must never select it) and loses it when the
 * window ends, with the rest of its content. A deleted session never loses a
 * branch it does not own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, changeRequests, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { selectExpiredSessionBranches } from '../projects/maintenance';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const tag = crypto.randomUUID().slice(0, 8);
const sid = (id: string) => `${tag}-${id}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

async function seed(input: {
  id: string;
  status: 'stopped' | 'completed' | 'failed' | 'running';
  idleDays: number;
  deletedDaysAgo?: number;
  branchName?: string;
}) {
  const at = daysAgo(input.idleDays);
  await db.insert(projectSessions).values({
    sessionId: sid(input.id),
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: input.branchName ?? `kortix/${sid(input.id)}`,
    createdBy: OWNER,
    status: input.status,
    metadata:
      input.deletedDaysAgo === undefined
        ? {}
        : { deletedAt: daysAgo(input.deletedDaysAgo).toISOString(), deletedBy: OWNER },
    createdAt: at,
    updatedAt: at,
  });
}

async function selectedIds(): Promise<string[]> {
  const rows = await selectExpiredSessionBranches(NOW);
  return rows
    .map((row) => row.sessionId)
    .filter((id) => id.startsWith(`${tag}-`))
    .map((id) => id.slice(tag.length + 1))
    .sort();
}

beforeAll(async () => {
  delete process.env.KORTIX_BRANCH_RETENTION_DAYS;
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `branch-gc-${tag}` });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: `branch-gc-${tag}`,
    repoUrl: 'https://example.test/p.git',
  });
  await seed({ id: 'idle-100', status: 'stopped', idleDays: 100 });
  await seed({ id: 'idle-10', status: 'completed', idleDays: 10 });
  await seed({ id: 'running-100', status: 'running', idleDays: 100 });
  await seed({ id: 'deleted-1-ago', status: 'stopped', idleDays: 100, deletedDaysAgo: 1 });
  await seed({ id: 'deleted-29-ago', status: 'failed', idleDays: 120, deletedDaysAgo: 29.9 });
  await seed({ id: 'deleted-30-ago', status: 'stopped', idleDays: 0, deletedDaysAgo: 30 });
  await seed({ id: 'deleted-user-branch', status: 'stopped', idleDays: 120, deletedDaysAgo: 40, branchName: `feature-${tag}` });
  await seed({ id: 'deleted-open-cr', status: 'stopped', idleDays: 120, deletedDaysAgo: 40 });
  await seed({ id: 'deleted-merged-cr', status: 'stopped', idleDays: 120, deletedDaysAgo: 40 });
  for (const [number, id, status] of [[1, 'deleted-open-cr', 'open'], [2, 'deleted-merged-cr', 'merged']] as const) {
    await db.insert(changeRequests).values({
      accountId: ACCOUNT, projectId: PROJECT, number, title: 'synthetic', baseRef: 'main', headRef: `kortix/${sid(id)}`, createdBy: OWNER, status,
    });
  }
});

afterAll(async () => {
  await db.delete(changeRequests).where(eq(changeRequests.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('session branch GC retention', () => {
  test('selects a terminal session idle past retention, and a session deleted 30 days ago, however recently it ran', async () => {
    expect(await selectedIds()).toEqual(['deleted-30-ago', 'deleted-merged-cr', 'idle-100']);
  });

  test('keeps the branch of a session inside its restore window, however long it was idle before (KRTX-2316)', async () => {
    const ids = await selectedIds();
    expect(ids).not.toContain('deleted-1-ago');
    expect(ids).not.toContain('deleted-29-ago');
  });

  test('keeps a branch the deleted session does not own', async () => {
    expect(await selectedIds()).not.toContain('deleted-user-branch');
  });

  test('keeps the head branch of an open change request; a merged one does not hold it', async () => {
    const ids = await selectedIds();
    expect(ids).not.toContain('deleted-open-cr');
    expect(ids).toContain('deleted-merged-cr');
  });

  test('keeps the branch of a recent session and of a session that is not terminal', async () => {
    const ids = await selectedIds();
    expect(ids).not.toContain('idle-10');
    expect(ids).not.toContain('running-100');
  });
});
