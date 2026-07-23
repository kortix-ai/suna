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
  ensureBehavior:
    | 'activate'
    | 'leave_building'
    | 'leave_provider_building'
    | 'throw_permanent'
    | 'throw_transient';
  kicked: string[];
  /** When set, getSnapshotState THROWS this instead of returning a state — models
   *  a real provider adapter propagating an auth failure (see
   *  platinum-snapshot-state-auth.test.ts) rather than a build-call failure. */
  stateThrows: Error | null;
  /** When non-null, the fake provider exposes getSnapshotStateByExternalId backed
   *  by this map (externalId → provider state). Left null so most tests keep the
   *  method ABSENT and exercise the name-based fallback unchanged. */
  byIdState: Map<string, string> | null;
  /** External ids the by-id verifier was actually asked about (proves wiring). */
  byIdCalls: string[];
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
    byIdState: null,
    byIdCalls: [],
  };
}

function makeDeps(world: FakeWorld, now: () => Date = () => new Date()): TransitionDeps {
  return {
    db,
    now,
    leaseTtlMs: 10 * 60 * 1000,
    getProvider: () => {
      const base = {
        getSnapshotState: async (name: string) => {
          if (world.stateThrows) throw world.stateThrows;
          return (world.state.get(name) ?? 'missing') as never;
        },
        getSnapshotExternalId: async (name: string) => world.externalIds.get(name) ?? null,
        deleteSnapshot: async () => {},
      };
      // Only expose the by-id verifier when a test opts in — otherwise the method
      // is ABSENT and the runner uses the name-based fallback (unchanged path).
      if (world.byIdState) {
        return {
          ...base,
          getSnapshotStateByExternalId: async (externalId: string) => {
            world.byIdCalls.push(externalId);
            return (world.byIdState!.get(externalId) ?? 'missing') as never;
          },
        };
      }
      return base;
    },
    ensureWarmImage: async (_project, opts) => {
      world.buildCount += 1;
      if (world.ensureBehavior === 'throw_permanent') throw new Error('HTTP 401 Unauthorized: bad platinum key');
      if (world.ensureBehavior === 'throw_transient') throw new Error('ETIMEDOUT talking to platinum');
      const name = world.currentIdentity.snapshotName;
      if (world.ensureBehavior === 'activate') {
        world.state.set(name, 'active');
        world.externalIds.set(name, `tpl_${name.slice(-8)}`);
      }
      // Models Platinum's async build: from-build registers a build and returns,
      // but the provider still reports `building` well past this drive.
      if (world.ensureBehavior === 'leave_provider_building') {
        world.state.set(name, 'building');
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

  test('BUILDING ≠ FAILURE: an image already building on the target is NOT rebuilt and does NOT consume an attempt', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    // The content-addressed image is already building (another drive/replica or
    // an on-push ppwarm bake kicked it). ensureWarmImage MUST NOT be called.
    world.state.set(id.snapshotName, 'building');
    world.ensureBehavior = 'throw_permanent'; // would blow up if ensureWarmImage ran
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('waiting');
    expect(world.buildCount).toBe(0); // never re-triggered the build
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('building');
    expect(row?.attempts ?? 0).toBe(0); // a healthy build is not a failed attempt
    expect(row?.errorClass).toBe('waiting');
    expect(row?.nextRetryAt).not.toBeNull();
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });

  test('BUILDING ≠ FAILURE: a build still in progress after ensureWarmImage waits without consuming an attempt', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    // Pre-build the image is absent → ensureWarmImage runs (registers the build)
    // but the provider still reports `building` afterward (async completion).
    world.ensureBehavior = 'leave_provider_building';
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('waiting');
    expect(world.buildCount).toBe(1); // it DID register the build once
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('building');
    expect(row?.attempts ?? 0).toBe(0); // still-building is not a failure
    expect(row?.errorClass).toBe('waiting');
  });

  test('BUILDING ≠ FAILURE: a long healthy build re-drives many times WITHOUT ever dead-lettering', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.state.set(id.snapshotName, 'building'); // stuck healthily building
    world.ensureBehavior = 'throw_permanent';
    const res = await reserveSwitchTransition(db, {
      accountId,
      sourceProvider: 'daytona',
      identity: { projectId, targetProvider: 'platinum', ...id },
    });
    // Drive far more times than MAX_TRANSITION_ATTEMPTS. Each drive clears the
    // heartbeat + a next_retry gate; a fresh `now` past the gate re-leases it.
    let outcome = '';
    for (let i = 0; i < 10; i++) {
      const now = () => new Date(Date.now() + i * 60_000);
      outcome = await driveProviderTransition(makeDeps(world, now), res.row.transitionId);
    }
    expect(outcome).toBe('waiting');
    expect(world.buildCount).toBe(0);
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('building'); // never 'failed'
    expect(row?.attempts ?? 0).toBe(0); // 10 waits, zero attempts consumed
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
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

  // ── FIX 2: BUILDING≠FAILURE completed — reset-on-healthy + wall-clock ────────

  test('scattered indeterminate blips interspersed with `building` NEVER dead-letter (attempts reset)', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.ensureBehavior = 'throw_permanent'; // would blow up if a build ever ran
    const res = await reserveSwitchTransition(db, {
      accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id },
    });
    // Alternate a ~3-min provider blip (unknown ⇒ indeterminate) with a healthy
    // `building` poll, many times. Each indeterminate burns one attempt; the very
    // next `building` resets it to 0 — so attempts oscillate 0/1 and never hit 6.
    let outcome = '';
    for (let i = 0; i < 12; i++) {
      world.state.set(id.snapshotName, i % 2 === 0 ? 'unknown' : 'building');
      const now = () => new Date(Date.now() + i * 40_000); // clears poll + backoff gates, well under 1h
      outcome = await driveProviderTransition(makeDeps(world, now), res.row.transitionId);
    }
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).not.toBe('failed'); // never dead-lettered
    expect(row?.status).toBe('building');
    expect(row?.attempts ?? 0).toBeLessThanOrEqual(1); // bounded — reset by every healthy building poll
    expect(world.buildCount).toBe(0);
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
    expect(outcome).toBe('waiting'); // last drive (i=11) is `building`
  });

  test('6 CONSECUTIVE indeterminate/transient drives DO dead-letter (sustained outage)', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.state.set(id.snapshotName, 'unknown'); // provider can't confirm, every drive
    world.ensureBehavior = 'throw_permanent';
    const res = await reserveSwitchTransition(db, {
      accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id },
    });
    let outcome = '';
    for (let i = 0; i < 6; i++) {
      const now = () => new Date(Date.now() + i * 6 * 60_000); // 6-min steps clear the exp backoff (max 5m)
      outcome = await driveProviderTransition(makeDeps(world, now), res.row.transitionId);
    }
    expect(outcome).toBe('failed');
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(6);
    expect(row?.errorClass).toBe('exhausted');
    expect(world.buildCount).toBe(0);
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });

  test('a forever-`building` build FAILS with build_timeout once past the wall-clock deadline', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.state.set(id.snapshotName, 'building'); // stuck building forever
    world.ensureBehavior = 'throw_permanent';
    const res = await reserveSwitchTransition(db, {
      accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const base = Date.now();
    // Drive 1 anchors startedAt (elapsed 0 → waits, attempts stay 0).
    const first = await driveProviderTransition(makeDeps(world, () => new Date(base)), res.row.transitionId);
    expect(first).toBe('waiting');
    expect((await getTransition(db, res.row.transitionId))?.attempts ?? 0).toBe(0);
    // Drive 2 is > MAX_BUILDING_MS (default 1h) past startedAt → terminal timeout.
    const second = await driveProviderTransition(
      makeDeps(world, () => new Date(base + 61 * 60_000)),
      res.row.transitionId,
    );
    expect(second).toBe('failed');
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.status).toBe('failed');
    expect(row?.errorClass).toBe('build_timeout');
    expect(row?.nextRetryAt).toBeNull(); // terminal, not retried
    expect(world.buildCount).toBe(0);
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });

  test('verify-stage `building` re-polls WITHOUT an attempt, then activates when it turns ready', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    // The name lists as active (so the build phase is a no-op reuse), but the EXACT
    // id the transition pinned is still `building` — the by-id verifier catches it.
    world.state.set(id.snapshotName, 'active');
    world.externalIds.set(id.snapshotName, 'tpl_verify');
    world.byIdState = new Map([['tpl_verify', 'building']]);
    world.ensureBehavior = 'throw_permanent'; // no build should run
    const res = await reserveSwitchTransition(db, {
      accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const base = Date.now();
    const first = await driveProviderTransition(makeDeps(world, () => new Date(base)), res.row.transitionId);
    expect(first).toBe('waiting'); // building at verify → re-poll, not a failed attempt
    const mid = await getTransition(db, res.row.transitionId);
    expect(mid?.status).toBe('building');
    expect(mid?.attempts ?? 0).toBe(0);
    expect(world.byIdCalls).toContain('tpl_verify'); // by-id verifier was exercised
    // The exact id finishes building → next drive activates, pinning THAT id.
    world.byIdState.set('tpl_verify', 'active');
    const second = await driveProviderTransition(
      makeDeps(world, () => new Date(base + 60_000)),
      res.row.transitionId,
    );
    expect(second).toBe('activated');
    expect(world.buildCount).toBe(0);
    const routing = await readActiveRouting(db, projectId);
    expect(routing?.activeProvider).toBe('platinum');
    expect(routing?.activeExternalTemplateId).toBe('tpl_verify');
  });

  test('an `absent` image still FAILS promptly (consumes an attempt — not treated as building)', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.state.set(id.snapshotName, 'missing'); // absent
    world.ensureBehavior = 'leave_building'; // build runs but image stays absent
    const res = await reserveSwitchTransition(db, {
      accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('building'); // recordFailure → retryable, NOT a wait
    const row = await getTransition(db, res.row.transitionId);
    expect(row?.attempts).toBe(1); // an absent image consumes an attempt (unlike building)
    expect(row?.errorClass).toBe('transient');
    expect(world.buildCount).toBe(1);
  });

  // ── FIX 3: activation verifies + pins the EXACT external template id ─────────

  test('activation verifies by EXACT external id and pins that id', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    world.state.set(id.snapshotName, 'active');
    world.externalIds.set(id.snapshotName, 'tpl_exact');
    world.byIdState = new Map([['tpl_exact', 'active']]);
    world.ensureBehavior = 'throw_permanent';
    const res = await reserveSwitchTransition(db, {
      accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('activated');
    expect(world.byIdCalls).toContain('tpl_exact'); // verified BY ID, not just by name
    const routing = await readActiveRouting(db, projectId);
    expect(routing?.activeProvider).toBe('platinum');
    expect(routing?.activeExternalTemplateId).toBe('tpl_exact'); // pinned the exact verified id
  });

  test('a by-id-ABSENT result forces a rebuild rather than a stale-name activation', async () => {
    const projectId = await freshProject();
    const id = identity(projectId, 'commit-a', 'kortix-default-r1');
    const world = makeWorld(id);
    // The NAME still lists active (truncated-listing lie), but the EXACT pinned id
    // was GC'd → by-id 'missing'. Activation must refuse + rebuild, never flip.
    world.state.set(id.snapshotName, 'active');
    world.externalIds.set(id.snapshotName, 'tpl_stale');
    world.byIdState = new Map([['tpl_stale', 'missing']]);
    world.ensureBehavior = 'throw_permanent';
    const res = await reserveSwitchTransition(db, {
      accountId, sourceProvider: 'daytona', identity: { projectId, targetProvider: 'platinum', ...id },
    });
    const outcome = await driveProviderTransition(makeDeps(world), res.row.transitionId);
    expect(outcome).toBe('rebuilt'); // by-id absent ⇒ rebuild, NOT activate
    expect(world.byIdCalls).toContain('tpl_stale'); // the decisive check ran by exact id
    // The KEY invariant: the stale/GC'd image was NEVER activated despite the name
    // still listing active. The row is routed to rebuild, not flipped live.
    expect((await getTransition(db, res.row.transitionId))?.status).not.toBe('activated');
    expect((await readActiveRouting(db, projectId))?.activeProvider).toBeNull();
  });
});
