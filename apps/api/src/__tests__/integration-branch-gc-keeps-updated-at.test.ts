/**
 * Integration test (real PostgreSQL, a real bare Git remote): the branch sweep
 * deletes the branch of a session idle past retention and leaves the row's
 * `updated_at` alone. The sidebar reads `updated_at` as the last activity of a
 * session with no activity stamp, so a sweep that bumped it moved every
 * 90-day-old session into "Today".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { sweepExpiredSessionBranches } from '../projects/maintenance';
import { db } from '../shared/db';

const DAY = 86_400_000;
const NOW = new Date();
const IDLE_SINCE = new Date(NOW.getTime() - 100 * DAY);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION = crypto.randomUUID();

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let root = '';
let remote = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kortix-branch-gc-'));
  const seed = join(root, 'seed');
  remote = join(root, 'remote.git');
  git('init', '--initial-branch=main', seed);
  git('-C', seed, 'config', 'user.name', 'Synthetic Test');
  git('-C', seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'fixture'), 'synthetic');
  git('-C', seed, 'add', 'fixture');
  git('-C', seed, 'commit', '-m', 'seed');
  git('clone', '--bare', seed, remote);
  git('--git-dir', remote, 'branch', `session/${SESSION}`, 'main');

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'branch-gc' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'branch-gc', repoUrl: remote, defaultBranch: 'main' });
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `session/${SESSION}`,
    createdBy: crypto.randomUUID(),
    status: 'stopped',
    metadata: {},
    createdAt: IDLE_SINCE,
    updatedAt: IDLE_SINCE,
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await rm(root, { recursive: true, force: true });
});

describe('branch sweep of an idle session', () => {
  test('deletes the branch, records the marker, and keeps updated_at', async () => {
    expect(await sweepExpiredSessionBranches(NOW)).toMatchObject({ deleted: 1, errors: 0 });
    expect(git('ls-remote', '--heads', remote)).not.toContain(`session/${SESSION}`);

    const [row] = await db
      .select({ updatedAt: projectSessions.updatedAt, metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, SESSION));
    expect((row!.metadata as Record<string, unknown>).branch_gc).toMatchObject({ remote_deleted: true });
    expect(row!.updatedAt.toISOString()).toBe(IDLE_SINCE.toISOString());
  });
});
