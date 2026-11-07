/**
 * A cancelled or superseded provider transition stays terminal against the
 * runner that still drives it (throwaway PostgreSQL).
 *
 * The runner's writes are fenced on `lease_epoch` only (`fencedWhere`). Cancel
 * (`setPinWithGenerationBump`) and supersede (`reserveSwitchTransition`) set a
 * terminal status but did not bump the epoch, so the runner holding the epoch
 * kept writing `building`/`ready` and the row was live again: counted, re-driven
 * by the resume worker, and holding the live-identity unique index. Both now
 * bump the epoch, so every later fenced write matches 0 rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accounts, createDb, projects, type Database } from '@kortix/db';
import { setPinWithGenerationBump } from './provider-transition-activate';
import { acquireLease, getTransition, reserveSwitchTransition, updateTransition } from './provider-transition-store';

const DB_URL = process.env.TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let db: Database;
let accountId: string;

async function freshProject(): Promise<string> {
  const [row] = await db
    .insert(projects)
    // Every test adds a project to one account: a legacy (split_pending)
    // account, as uq_projects_workspace_account requires for 2+ projects.
    .values({ accountId, name: 'ptx-fence', repoUrl: 'https://example.test/fence.git', metadata: {}, splitPending: true })
    .returning();
  return row!.projectId;
}

async function leasedSwitch(projectId: string, commit: string) {
  const res = await reserveSwitchTransition(db, {
    accountId,
    sourceProvider: 'daytona',
    identity: { projectId, targetProvider: 'platinum', commitSha: commit, baseRuntimeIdentity: `base-${commit}`, snapshotName: `base-${commit}` },
  });
  const leased = await acquireLease(db, res.row.transitionId, 600_000);
  expect(leased).not.toBeNull();
  return { transitionId: res.row.transitionId, epoch: leased!.leaseEpoch ?? 0 };
}

beforeAll(async () => {
  if (!DB_URL) return;
  db = createDb(DB_URL);
  const [acct] = await db.insert(accounts).values({ name: 'ptx-fence-test' }).returning();
  accountId = acct!.accountId;
});

afterAll(async () => {
  if (!DB_URL) return;
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

d('provider transition cancel and supersede fence the runner', () => {
  test('a runner write after a cancel matches nothing and the row stays cancelled', async () => {
    const projectId = await freshProject();
    const run = await leasedSwitch(projectId, 'commit-cancel');
    await setPinWithGenerationBump(db, { projectId, pin: 'daytona', now: new Date() });
    expect(await updateTransition(db, run.transitionId, { status: 'building' }, run.epoch)).toBe(false);
    expect((await getTransition(db, run.transitionId))?.status).toBe('cancelled');
  });

  test('a runner write after a newer request superseded the row matches nothing', async () => {
    const projectId = await freshProject();
    const run = await leasedSwitch(projectId, 'commit-old');
    await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', commitSha: 'commit-new', baseRuntimeIdentity: 'base-new', snapshotName: 'base-new' },
    });
    expect((await getTransition(db, run.transitionId))?.status).toBe('superseded');
    expect(await updateTransition(db, run.transitionId, { status: 'ready' }, run.epoch)).toBe(false);
    expect((await getTransition(db, run.transitionId))?.status).toBe('superseded');
  });

  test('the runner that still owns a live row keeps writing', async () => {
    const projectId = await freshProject();
    const run = await leasedSwitch(projectId, 'commit-live');
    expect(await updateTransition(db, run.transitionId, { status: 'building' }, run.epoch)).toBe(true);
  });
});
