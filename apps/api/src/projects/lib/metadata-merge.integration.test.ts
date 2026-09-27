import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, accounts, projects, type Database } from '@kortix/db';
import { metadataClearSubtreeKey, metadataMerge, metadataMergeSubtree } from './metadata-merge';
import {
  ACTIVE_EXTERNAL_ID_META_KEY,
  ACTIVE_SNAPSHOT_NAME_META_KEY,
  PIN_META_KEY,
  acquireLease,
  activateWithCas,
  readActiveRouting,
  reserveSwitchTransition,
} from '../provider-transition/provider-transition-store';

// DB-backed behavior of the atomic metadata merge. Runs in the `db-suites`
// lane of `pnpm test` against a throwaway migrated database. The static
// no-RMW-writer guard lives in metadata-merge.test.ts.

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = !!DB_URL;
const d = RUN ? describe : describe.skip;

let db: Database;
let accountId: string;

async function freshProject(): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ accountId, name: 'meta', repoUrl: 'https://example.test/r.git', metadata: {} })
    .returning();
  return row!.projectId;
}

async function readMeta(projectId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

/** Reserve a switch (gen=1) and activate it, pinning the project to `provider`. */
async function pinProject(projectId: string, provider: string, snapshotName: string): Promise<void> {
  const res = await reserveSwitchTransition(db, {
    accountId,
    sourceProvider: 'daytona',
    identity: { projectId, targetProvider: provider, commitSha: 'c1', baseRuntimeIdentity: 'kortix-default-r1', snapshotName },
  });
  const out = await activateWithCas(db, {
    projectId,
    transitionId: res.row.transitionId,
    targetProvider: provider,
    generation: res.row.generation!,
    snapshotName,
    externalTemplateId: 'tpl_pinned',
    now: new Date(),
  });
  expect(out.activated).toBe(true);
}

beforeAll(async () => {
  if (!RUN) return;
  db = createDb(DB_URL!);
  const [acct] = await db.insert(accounts).values({ name: 'meta-merge-test' }).returning();
  accountId = acct!.accountId;
});

afterAll(async () => {
  if (!RUN) return;
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

d('atomic merge preserves the routing pin (throwaway Postgres)', () => {
  test('a metadata writer holding a PRE-activation snapshot does NOT revert the pin', async () => {
    const projectId = await freshProject();
    const snap = 'kortix-ppwarm-aaaa1111-deadbeefcafe';

    // A racy writer reads the (empty) metadata BEFORE the pin is activated…
    const staleSnapshot = await readMeta(projectId);
    expect(staleSnapshot[PIN_META_KEY]).toBeUndefined();

    // …the pin is activated in the gap…
    await pinProject(projectId, 'platinum', snap);
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBe('platinum');

    // …and the racy writer now persists its change via the SQL-side atomic merge.
    // Under the OLD whole-object RMW (metadata = {...staleSnapshot, triggers_paused})
    // the pin would be reverted; the merge reads the CURRENT row instead.
    await db
      .update(projects)
      .set({ metadata: metadataMerge({ triggers_paused: true }), updatedAt: new Date() })
      .where(eq(projects.projectId, projectId));

    const after = await readMeta(projectId);
    expect(after[PIN_META_KEY]).toBe('platinum'); // pin SURVIVED
    expect(after[ACTIVE_EXTERNAL_ID_META_KEY]).toBe('tpl_pinned');
    expect(after[ACTIVE_SNAPSHOT_NAME_META_KEY]).toBe(snap);
    expect(after.triggers_paused).toBe(true); // and the writer's change landed
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBe('platinum');
  });

  test('the delete-key path removes a key while preserving the pin', async () => {
    const projectId = await freshProject();
    await pinProject(projectId, 'platinum', 'kortix-ppwarm-bbbb2222-000011112222');
    await db.update(projects).set({ metadata: metadataMerge({ triggers_paused: true }) }).where(eq(projects.projectId, projectId));

    await db.update(projects).set({ metadata: metadataMerge({}, ['triggers_paused']) }).where(eq(projects.projectId, projectId));

    const after = await readMeta(projectId);
    expect(after.triggers_paused).toBeUndefined(); // deleted
    expect(after[PIN_META_KEY]).toBe('platinum'); // pin preserved
  });

  test('nested experimental toggles never clobber each other or the pin, and cleanup drops the empty object', async () => {
    const projectId = await freshProject();
    await pinProject(projectId, 'platinum', 'kortix-ppwarm-cccc3333-000011112222');

    // Two DIFFERENT experimental sub-keys — a shallow `||` of the whole
    // `experimental` object would lose one; the nested merge keeps both.
    await db.update(projects).set({ metadata: metadataMergeSubtree('experimental', { agent_tunnel: true }) }).where(eq(projects.projectId, projectId));
    await db.update(projects).set({ metadata: metadataMergeSubtree('experimental', { llm_gateway: false }) }).where(eq(projects.projectId, projectId));

    let meta = await readMeta(projectId);
    expect(meta.experimental).toEqual({ agent_tunnel: true, llm_gateway: false });
    expect(meta[PIN_META_KEY]).toBe('platinum');

    // Clear one sub-key → the other + the pin remain.
    await db.update(projects).set({ metadata: metadataClearSubtreeKey('experimental', 'agent_tunnel') }).where(eq(projects.projectId, projectId));
    meta = await readMeta(projectId);
    expect(meta.experimental).toEqual({ llm_gateway: false });

    // Clear the last sub-key → the whole `experimental` object is dropped, pin intact.
    await db.update(projects).set({ metadata: metadataClearSubtreeKey('experimental', 'llm_gateway') }).where(eq(projects.projectId, projectId));
    meta = await readMeta(projectId);
    expect(meta.experimental).toBeUndefined();
    expect(meta[PIN_META_KEY]).toBe('platinum');
  });

  test('the generation CAS still rejects a stale activation (unchanged by the merge conversion)', async () => {
    const projectId = await freshProject();
    const snap1 = 'kortix-ppwarm-dddd4444-000011112222';
    const first = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', commitSha: 'c1', baseRuntimeIdentity: 'kortix-default-r1', snapshotName: snap1 },
    });
    // A newer request bumps the project generation to 2 (supersedes gen 1).
    await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', commitSha: 'c2', baseRuntimeIdentity: 'kortix-default-r1', snapshotName: 'kortix-ppwarm-dddd4444-333344445555' },
    });

    const out = await activateWithCas(db, {
      projectId,
      transitionId: first.row.transitionId,
      targetProvider: 'platinum',
      generation: first.row.generation!, // stale (1) vs recorded (2)
      snapshotName: snap1,
      externalTemplateId: 'tpl_stale',
      now: new Date(),
    });
    expect(out.activated).toBe(false);
    expect(out.reason).toBe('lost_cas');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull(); // pin untouched
  });

  test('the lease-epoch fence still rejects a zombie activation at a matching generation', async () => {
    const projectId = await freshProject();
    const snap = 'kortix-ppwarm-eeee5555-000011112222';
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', commitSha: 'c1', baseRuntimeIdentity: 'kortix-default-r1', snapshotName: snap },
    });
    // A live owner acquires the lease, bumping the epoch to 1.
    const leased = await acquireLease(db, res.row.transitionId, 10 * 60 * 1000);
    expect(leased?.leaseEpoch).toBe(1);

    // A zombie drive still carrying epoch 0 tries to activate at the SAME generation.
    const out = await activateWithCas(db, {
      projectId,
      transitionId: res.row.transitionId,
      targetProvider: 'platinum',
      generation: res.row.generation!,
      snapshotName: snap,
      externalTemplateId: 'tpl_zombie',
      now: new Date(),
      leaseEpoch: 0, // stale
    });
    expect(out.activated).toBe(false);
    expect(out.reason).toBe('lost_lease');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull(); // pin untouched
  });
});
