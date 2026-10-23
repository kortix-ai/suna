/**
 * Integration test (real PostgreSQL, a real bare Git remote): on day 30 a
 * deleted session is gone. The two workers that end it run in either order on
 * the same day: the retention purge (content) and the branch sweep (the
 * session branch on the project remote). Whatever the order, the remote loses
 * the branch and keeps the default branch, and the session row is a shell of
 * ids, dates and the `branch_gc` marker, with no content.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { sweepExpiredSessionBranches } from '../projects/maintenance';
import { restoreSession } from '../projects/session-lifecycle/restore-session';
import { purgeSessionContent } from '../projects/session-log-purge';
import { db } from '../shared/db';

const DAY = 86_400_000;
const NOW = new Date();
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const PURGE_FIRST = crypto.randomUUID();
const SWEEP_FIRST = crypto.randomUUID();
const store = { removeSession: async () => {} };

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let root = '';
let remote = '';
const heads = () => git('ls-remote', '--heads', remote);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kortix-day-30-'));
  const seed = join(root, 'seed');
  remote = join(root, 'remote.git');
  git('init', '--initial-branch=main', seed);
  git('-C', seed, 'config', 'user.name', 'Synthetic Test');
  git('-C', seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'fixture'), 'synthetic');
  git('-C', seed, 'add', 'fixture');
  git('-C', seed, 'commit', '-m', 'seed');
  git('clone', '--bare', seed, remote);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'day-30' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'day-30', repoUrl: remote, defaultBranch: 'main' });
  for (const sessionId of [PURGE_FIRST, SWEEP_FIRST]) {
    git('--git-dir', remote, 'branch', `session/${sessionId}`, 'main');
    await db.insert(projectSessions).values({
      sessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: `session/${sessionId}`,
      createdBy: USER,
      status: 'stopped',
      metadata: { title: 'synthetic title', initial_prompt: 'synthetic prompt', deletedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(), deletedBy: USER },
    });
  }
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await rm(root, { recursive: true, force: true });
});

const metadataOf = async (sessionId: string) =>
  (await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)))[0]!.metadata as Record<string, unknown>;

describe('a deleted session on day 30', () => {
  test('the purge runs first for one session, the sweep first for the other; both branches leave the remote, main stays', async () => {
    // Purge both, then sweep: PURGE_FIRST's order. Then SWEEP_FIRST is checked after a second purge.
    expect(await purgeSessionContent({ now: NOW, store })).toMatchObject({ sessions: 2, failed: 0 });
    expect(await sweepExpiredSessionBranches(NOW)).toMatchObject({ deleted: 2, errors: 0 });
    expect(heads()).not.toContain('refs/heads/session/');
    expect(heads()).toContain('refs/heads/main');
  });

  test('after purge then sweep, the row keeps ids, dates and the branch marker only', async () => {
    const metadata = await metadataOf(PURGE_FIRST);
    expect(Object.keys(metadata).sort()).toEqual(['branch_gc', 'copiesPurgedAt', 'deletedAt', 'deletedBy']);
    expect(metadata.branch_gc).toMatchObject({ branch_name: `session/${PURGE_FIRST}`, remote_deleted: true });
  });

  test('a purge after the sweep keeps the branch marker, so the sweep does not select the session again', async () => {
    await db.update(projectSessions).set({ metadata: { ...(await metadataOf(SWEEP_FIRST)), title: 'synthetic title' } }).where(eq(projectSessions.sessionId, SWEEP_FIRST));
    await db.execute(`delete from kortix.session_content_purges where session_id = '${SWEEP_FIRST}'`);
    expect(await purgeSessionContent({ now: NOW, store })).toMatchObject({ sessions: 1 });
    expect(Object.keys(await metadataOf(SWEEP_FIRST)).sort()).toEqual(['branch_gc', 'copiesPurgedAt', 'deletedAt', 'deletedBy']);
    expect(await sweepExpiredSessionBranches(NOW)).toEqual({ candidates: 0, deleted: 0, skipped: 0, errors: 0 });
  });

  test('a purge that lands between the sweep read and its write is not undone by the write', async () => {
    const RACE = crypto.randomUUID();
    git('--git-dir', remote, 'branch', `session/${RACE}`, 'main');
    const deletedAt = new Date(NOW.getTime() - 30 * DAY).toISOString();
    await db.insert(projectSessions).values({
      sessionId: RACE, accountId: ACCOUNT, projectId: PROJECT, branchName: `session/${RACE}`, createdBy: USER, status: 'stopped',
      metadata: { title: 'synthetic title', deletedAt, deletedBy: USER },
    });
    let sweep: Promise<unknown> = Promise.resolve();
    // Hold the row: the sweep reads the old metadata, deletes the branch, then waits on its write.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from kortix.project_sessions where session_id = ${RACE} for update`);
      sweep = sweepExpiredSessionBranches(NOW);
      for (let i = 0; i < 200; i++) {
        const [row] = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'update "kortix"."project_sessions"%'`);
        if ((row as { n: number }).n > 0) break;
        await Bun.sleep(25);
      }
      // The purge's shell write, inside the window.
      await tx.update(projectSessions).set({ metadata: { deletedAt, deletedBy: USER } }).where(eq(projectSessions.sessionId, RACE));
    });
    expect(await sweep).toMatchObject({ deleted: 1, errors: 0 });
    expect(Object.keys(await metadataOf(RACE)).sort()).toEqual(['branch_gc', 'deletedAt', 'deletedBy']);
  });

  test('a branch whose delete fails waits a day, so it cannot hold the batch', async () => {
    const BROKEN_PROJECT = crypto.randomUUID();
    const BROKEN = crypto.randomUUID();
    await db.insert(projects).values({ projectId: BROKEN_PROJECT, accountId: ACCOUNT, name: 'day-30-broken', repoUrl: join(root, 'missing.git'), defaultBranch: 'main' });
    await db.insert(projectSessions).values({
      sessionId: BROKEN, accountId: ACCOUNT, projectId: BROKEN_PROJECT, branchName: `session/${BROKEN}`, createdBy: USER, status: 'stopped',
      metadata: { deletedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(), deletedBy: USER },
    });
    expect(await sweepExpiredSessionBranches(NOW)).toMatchObject({ candidates: 1, errors: 1 });
    expect((await metadataOf(BROKEN)).branch_gc).toEqual({ failed_at: NOW.toISOString() });
    expect(await sweepExpiredSessionBranches(new Date(NOW.getTime() + DAY - 1))).toMatchObject({ candidates: 0 });
    expect(await sweepExpiredSessionBranches(new Date(NOW.getTime() + DAY + 1))).toMatchObject({ candidates: 1, errors: 1 });
  });

  test('a restore answers 410 session_purged', async () => {
    expect(await restoreSession({ projectId: PROJECT, sessionId: PURGE_FIRST, accountId: ACCOUNT, now: NOW })).toMatchObject({
      status: 410,
      code: 'session_purged',
    });
  });
});
