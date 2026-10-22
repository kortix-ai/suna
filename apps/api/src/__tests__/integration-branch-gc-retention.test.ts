/**
 * Integration test (real local PostgreSQL, fully migrated): the session branch
 * GC keeps a deleted session's branch for the retention period after the
 * delete (KRTX-2316).
 *
 * A delete keeps `updated_at`, so the session keeps its list position. The GC
 * selected on `updated_at` alone, so a session idle for 90 days lost its
 * branch at the next sweep after a delete, inside the 30-day restore window.
 * The selection now also requires the delete itself to be older than the
 * retention period.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
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
}) {
  const at = daysAgo(input.idleDays);
  await db.insert(projectSessions).values({
    sessionId: sid(input.id),
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `kortix/${sid(input.id)}`,
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
  await seed({ id: 'deleted-89-ago', status: 'failed', idleDays: 120, deletedDaysAgo: 89 });
  await seed({ id: 'deleted-91-ago', status: 'stopped', idleDays: 120, deletedDaysAgo: 91 });
});

afterAll(async () => {
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('session branch GC retention (KRTX-2316)', () => {
  test('selects a terminal session idle past retention, and a session deleted past retention', async () => {
    expect(await selectedIds()).toEqual(['deleted-91-ago', 'idle-100']);
  });

  test('keeps the branch of a session deleted inside retention, however long it was idle before', async () => {
    const ids = await selectedIds();
    expect(ids).not.toContain('deleted-1-ago');
    expect(ids).not.toContain('deleted-89-ago');
  });

  test('keeps the branch of a recent session and of a session that is not terminal', async () => {
    const ids = await selectedIds();
    expect(ids).not.toContain('idle-10');
    expect(ids).not.toContain('running-100');
  });
});
