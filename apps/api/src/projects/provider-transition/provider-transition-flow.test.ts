import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, accounts, projects, providerTransitions, type Database } from '@kortix/db';
import { perProjectWarmImageName } from '../../snapshots/ppwarm-names';
import {
  driveProviderTransition,
  type ResolvedPrepIdentity,
  type TransitionDeps,
} from './provider-transition-runner';
import {
  activateWithCas,
  findResumableTransitions,
  getTransition,
  insertPrebuildTransition,
  readActiveRouting,
  reserveSwitchTransition,
  setPinWithGenerationBump,
  updateTransition,
} from './provider-transition-store';

const DB_URL = process.env.PTX_TEST_DB_URL;
const RUN = !!DB_URL;
const d = RUN ? describe : describe.skip;

let db: Database;
let accountId: string;

async function freshProject(defaultProvider = 'daytona'): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ accountId, name: 'ptx', repoUrl: 'https://example.test/r.git', metadata: {} })
    .returning();
  return row!.projectId;
}

interface FakeWorld {
  state: Map<string, string>;
  externalIds: Map<string, string>;
  buildCount: number;
  currentIdentity: ResolvedPrepIdentity;
  identityByCall: ResolvedPrepIdentity[];
  callIndex: number;
  ensureBehavior: 'activate' | 'leave_building' | 'throw_permanent' | 'throw_transient';
  kicked: string[];
  /** When set, getSnapshotState THROWS this instead of returning a state — models
   *  a real provider adapter propagating an auth failure (see
   *  platinum-snapshot-state-auth.test.ts) rather than a build-call failure. */
  stateThrows: Error | null;
}

function makeWorld(identity: ResolvedPrepIdentity): FakeWorld {
  return {
    state: new Map(),
    externalIds: new Map(),
    buildCount: 0,
    currentIdentity: identity,
    identityByCall: [],
    callIndex: 0,
    ensureBehavior: 'activate',
    kicked: [],
    stateThrows: null,
  };
}

function makeDeps(world: FakeWorld, now: () => Date = () => new Date()): TransitionDeps {
  return {
    db,
    now,
    leaseTtlMs: 10 * 60 * 1000,
    getProvider: () => ({
      getSnapshotState: async (name: string) => {
        if (world.stateThrows) throw world.stateThrows;
        return (world.state.get(name) ?? 'missing') as never;
      },
      getSnapshotExternalId: async (name: string) => world.externalIds.get(name) ?? null,
      deleteSnapshot: async () => {},
    }),
    ensureWarmImage: async (_project, opts) => {
      world.buildCount += 1;
      if (world.ensureBehavior === 'throw_permanent') throw new Error('HTTP 401 Unauthorized: bad platinum key');
      if (world.ensureBehavior === 'throw_transient') throw new Error('ETIMEDOUT talking to platinum');
      const name = world.currentIdentity.snapshotName;
      if (world.ensureBehavior === 'activate') {
        world.state.set(name, 'active');
        world.externalIds.set(name, `tpl_${name.slice(-8)}`);
      }
      return { snapshotName: name, built: true, provider: opts.provider } as never;
    },
    resolvePrepIdentity: async () => {
      const scripted = world.identityByCall[world.callIndex];
      world.callIndex += 1;
      return scripted ?? world.currentIdentity;
    },
    loadProject: async (projectId: string) => {
      const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
      if (!row) return null;
      return {
        projectId: row.projectId,
        repoUrl: row.repoUrl,
        defaultBranch: row.defaultBranch,
        manifestPath: row.manifestPath,
        accountId: row.accountId,
      };
    },
    kick: (id) => world.kicked.push(id),
  };
}

function identity(projectId: string, commit: string, base: string): ResolvedPrepIdentity {
  return { commitSha: commit, baseRuntimeIdentity: base, snapshotName: perProjectWarmImageName(projectId, commit, base) };
}

beforeAll(async () => {
  if (!RUN) return;
  db = createDb(DB_URL!);
  const [acct] = await db.insert(accounts).values({ name: 'ptx-test' }).returning();
  accountId = acct!.accountId;
});

afterAll(async () => {
  if (!RUN) return;
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

d('provider transition — durable flow (throwaway Postgres)', () => {
  test('request records a pending transition and does NOT flip the active provider', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    expect(res.created).toBe(true);
    const routing = await readActiveRouting(db, projectId);
    expect(routing?.activeProvider).toBeNull();
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('pending');
    expect(row?.snapshotName).toBe(id.snapshotName);
  });

  test('drive does not activate while the image is not yet ready', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.ensureBehavior = 'leave_building';
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).not.toBe('activated');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });

  test('an already-active image activates immediately with NO rebuild', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.state.set(id.snapshotName, 'active');
    world.externalIds.set(id.snapshotName, 'tpl_preexisting');
    world.ensureBehavior = 'throw_permanent';
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('activated');
    expect(world.buildCount).toBe(0);
    const routing = await readActiveRouting(db, projectId);
    expect(routing?.activeProvider).toBe('platinum');
    expect(routing?.activeExternalTemplateId).toBe('tpl_preexisting');
  });

  test('a permanent build failure leaves the SOURCE active and dead-letters', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.ensureBehavior = 'throw_permanent';
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('failed');
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('failed');
    expect(row?.errorClass).toBe('auth_terminal');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });

  test('an unknown provider state is retried, NEVER treated as a missing image', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.state.set(id.snapshotName, 'unknown');
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('building');
    expect(world.buildCount).toBe(0);
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).not.toBe('failed');
    expect(row?.errorClass).toBe('transient');
    expect(row?.nextRetryAt).not.toBeNull();
  });

  test('a 401/403 surfaced by the readiness check (not the build call) fails FAST as auth_terminal — never retried, never "missing"', async () => {
    // Regression for platinum.ts's getSnapshotState: a real auth failure used to
    // be swallowed into the generic 'unknown' state, which this same runner
    // correctly treats as indeterminate (not "missing") but then reports up as a
    // message-less error the classifier can't recognize as permanent — silently
    // downgrading a dead API key into a multi-attempt transient retry loop. The
    // fix (platinum.ts) makes the adapter PROPAGATE the 401/403 so it reaches
    // this exact code path with the real message intact.
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.stateThrows = new Error('platinum GET /v1/templates -> 403 {"error":"forbidden"}');
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('failed');
    expect(world.buildCount).toBe(0);
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(1);
    expect(row?.errorClass).toBe('auth_terminal');
    expect(row?.nextRetryAt).toBeNull();
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });

  test('duplicate switch requests dedup to ONE transition and ONE build', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const a = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    const b = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    expect(b.row.transitionId).toBe(a.row.transitionId);
    expect(b.created).toBe(false);
    const world = makeWorld(id);
    await driveProviderTransition(makeDeps(world), a.row.transitionId);
    expect(world.buildCount).toBe(1);
  });

  test('a new commit during prep prevents a stale activation (forks a new identity)', async () => {
    const projectId = await freshProject();
    const orig = identity(projectId, 'commit-a', 'kortix-default-r1');
    const drifted = identity(projectId, 'commit-b', 'kortix-default-r1');
    const world = makeWorld(orig);
    world.identityByCall = [drifted];
    const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...orig } });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('rebuilt');
    const old = await getTransition(db, res.row.transitionId);
    expect(old?.status).toBe('superseded');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
    expect(world.kicked.length).toBe(1);
  });

  test('a runtime/base-image change during prep prevents a stale activation', async () => {
    const projectId = await freshProject();
    const orig = identity(projectId, 'commit-a', 'kortix-default-r1');
    const drifted = identity(projectId, 'commit-a', 'kortix-default-r2');
    const world = makeWorld(orig);
    world.identityByCall = [drifted];
    const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...orig } });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('rebuilt');
    expect((await getTransition(db, res.row.transitionId))?.status).toBe('superseded');
  });

  test('a newer request supersedes the older; only the newest can activate', async () => {
    const projectId = await freshProject();
    const idA = identity(projectId, 'commit-a', 'kortix-default-r1');
    const idB = identity(projectId, 'commit-b', 'kortix-default-r1');
    const a = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...idA } });
    const b = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...idB } });
    expect((await getTransition(db, a.row.transitionId))?.status).toBe('superseded');
    expect(b.row.generation!).toBeGreaterThan(a.row.generation!);

    const world = makeWorld(idB);
    const outB = await driveProviderTransition(makeDeps(world), b.row.transitionId);
    expect(outB).toBe('activated');
    const outA = await driveProviderTransition(makeDeps(world), a.row.transitionId);
    expect(outA).toBe('not_leased');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBe('platinum');
  });

  test('concurrent activation CAS: only the generation matching the project wins (clobber race)', async () => {
    const projectId = await freshProject();
    const idA = identity(projectId, 'commit-a', 'kortix-default-r1');
    const idB = identity(projectId, 'commit-b', 'kortix-default-r1');
    const a = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...idA } });
    const b = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...idB } });
    const now = new Date();
    const older = await activateWithCas(db, { projectId, transitionId: a.row.transitionId, targetProvider: 'platinum', generation: a.row.generation!, snapshotName: idA.snapshotName, externalTemplateId: 'tpl_a', now });
    const newer = await activateWithCas(db, { projectId, transitionId: b.row.transitionId, targetProvider: 'platinum', generation: b.row.generation!, snapshotName: idB.snapshotName, externalTemplateId: 'tpl_b', now });
    expect(older.activated).toBe(false);
    expect(older.reason).toBe('lost_cas');
    expect(newer.activated).toBe(true);
    expect((await readActiveRouting(db, projectId))?.activeExternalTemplateId).toBe('tpl_b');
  });

  test('the prepared snapshot name equals the session warm-lookup name (first session does not clone)', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'deadbeef', 'kortix-default-r1');
    expect(id.snapshotName).toBe(perProjectWarmImageName(projectId, 'deadbeef', 'kortix-default-r1'));
    const world = makeWorld(id);
    const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    await driveProviderTransition(makeDeps(world), res.row.transitionId);
    const routing = await readActiveRouting(db, projectId);
    expect(routing?.activeProvider).toBe('platinum');
    expect(routing?.activeExternalTemplateId).toBe(world.externalIds.get(id.snapshotName));
  });

  test('API restart resumes a stranded building transition to activation', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    await updateTransition(db, res.row.transitionId, {
      status: 'building',
      startedAt: new Date(Date.now() - 30 * 60_000),
      heartbeatAt: new Date(Date.now() - 30 * 60_000),
    });
    const resumable = await findResumableTransitions(db, 10 * 60_000, 10);
    expect(resumable.some((r) => r.transitionId === res.row.transitionId)).toBe(true);
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('activated');
  });

  test('the reconciler resumes a stranded READY row and a stranded ACTIVATING row', async () => {
    for (const strandedStatus of ['ready', 'activating'] as const) {
      const projectId = await freshProject();
      const id = identity(projectId, 'commit-a', 'kortix-default-r1');
      const world = makeWorld(id);
      world.state.set(id.snapshotName, 'active');
      world.externalIds.set(id.snapshotName, 'tpl_ready');
      const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
      await updateTransition(db, res.row.transitionId, {
        status: strandedStatus,
        readyAt: new Date(Date.now() - 30 * 60_000),
        heartbeatAt: new Date(Date.now() - 30 * 60_000),
      });
      const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
      expect(outcome).toBe('activated');
      expect((await readActiveRouting(db, projectId))?.activeProvider).toBe('platinum');
    }
  });

  test('a vanished image (GC\'d after ready) never activates stale — it re-verifies and refuses', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.ensureBehavior = 'leave_building';
    const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    await updateTransition(db, res.row.transitionId, { status: 'ready', readyAt: new Date(Date.now() - 30 * 60_000), heartbeatAt: new Date(Date.now() - 30 * 60_000), externalTemplateId: 'tpl_ready' });
    world.state.set(id.snapshotName, 'missing');
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).not.toBe('activated');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });

  test('crash between kick and persist is safe: the reserved pending row is resumable to activation', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    const resumable = await findResumableTransitions(db, 10 * 60_000, 10);
    expect(resumable.some((r) => r.transitionId === res.row.transitionId)).toBe(true);
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('activated');
  });

  test('switching back (setPin + generation bump) supersedes an in-flight prepare — no late re-flip', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    const res = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    await setPinWithGenerationBump(db, { projectId, pin: 'daytona', now: new Date() });
    expect((await getTransition(db, res.row.transitionId))?.status).toBe('cancelled');
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('not_leased');
    const routing = await readActiveRouting(db, projectId);
    expect(routing?.activeProvider).toBe('daytona');
  });

  test('a prebuild row builds the image but stays invisible to routing until adopted', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    const { row, created } = await insertPrebuildTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    expect(created).toBe(true);
    expect(row.generation).toBeNull();
    const outcome = await driveProviderTransition(makeDeps(world), row.transitionId);
    expect(outcome).toBe('prebuilt');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();

    const adopt = await reserveSwitchTransition(db, { accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id } });
    expect(adopt.adopted).toBe(true);
    expect(adopt.row.transitionId).toBe(row.transitionId);
    expect(adopt.row.generation).not.toBeNull();
    const outcome2 = await driveProviderTransition(makeDeps(world), adopt.row.transitionId);
    expect(outcome2).toBe('activated');
    expect(world.buildCount).toBe(1);
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBe('platinum');
  });
});
