/**
 * The meta-image reap, and the property that makes it safe to run at all.
 *
 * Incident it comes from: `ensureMyKortixSandboxImage` deleted a snapshot only when
 * its OWN build had failed, never when a newer one superseded it. The meta
 * fingerprint hashes the agent/CLI/SDK/shared/starter source trees, so it moves
 * on roughly every deploy. Measured 2026-08-12 on the live organisation: 118
 * `kortix-meta-*` snapshots, all under 14 days old, ~8/day, against a
 * 200-snapshot quota already at 226. Over quota, `POST /snapshots` returns 400,
 * which fails every CI run and every new-project build — those cannot fall back
 * to a last-known-good image the way an existing project's session can.
 *
 * The dangerous part is that dev, staging and prod share ONE Daytona
 * organisation (verified: identical API key across all four env profiles). A
 * reap that is not namespaced would let a dev deploy delete the image prod
 * boots meta sandboxes from. That is the first test below.
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import { myKortixSnapshotName, reapSupersededMyKortixSnapshots } from './builder';
import { myKortixReapProtection } from './runtime-images';

/**
 * No-op protection lookup: "nothing was built recently".
 *
 * Injected in every test that asserts WHICH names are deleted. Without it the
 * reap uses the real DB-backed query, and the result then depends on whether a
 * database is reachable — these tests passed locally and failed in CI for
 * exactly that reason. The DB-backed path has its own test below.
 */
const NOTHING_RECENT = async () => new Set<string>();

function fakeProvider(names: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    listSnapshots: async () => names.map((name) => ({ name })),
    deleteSnapshot: async (name: string) => {
      deleted.push(name);
    },
  };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('meta snapshot naming', () => {
  test('is namespaced by environment', () => {
    const name = myKortixSnapshotName(HASH_A);
    expect(name).toBe(`kortix-mykortix-${config.INTERNAL_KORTIX_ENV}-${'a'.repeat(16)}`);
  });

  test('two different fingerprints get different names', () => {
    expect(myKortixSnapshotName(HASH_A)).not.toBe(myKortixSnapshotName(HASH_B));
  });
});

describe('meta snapshot reap', () => {
  test("never touches another environment's images", async () => {
    // The whole reason for the namespace. If this regresses, a dev deploy can
    // delete the image production is booting from.
    const env = config.INTERNAL_KORTIX_ENV;
    const others = ['dev', 'staging', 'prod', 'preview'].filter((e) => e !== env);
    const foreign = others.flatMap((e) => [`kortix-mykortix-${e}-${'f'.repeat(16)}`, `kortix-meta-${e}-${'f'.repeat(16)}`]);
    const provider = fakeProvider([myKortixSnapshotName(HASH_A), ...foreign]);

    await reapSupersededMyKortixSnapshots(provider, myKortixSnapshotName(HASH_B), NOTHING_RECENT);

    // Only our own superseded image goes.
    expect(provider.deleted).toEqual([myKortixSnapshotName(HASH_A)]);
    for (const name of foreign) expect(provider.deleted).not.toContain(name);
  });

  test('keeps the image just built', async () => {
    const keep = myKortixSnapshotName(HASH_B);
    const provider = fakeProvider([keep, myKortixSnapshotName(HASH_A)]);

    await reapSupersededMyKortixSnapshots(provider, keep, NOTHING_RECENT);

    expect(provider.deleted).not.toContain(keep);
    expect(provider.deleted).toContain(myKortixSnapshotName(HASH_A));
  });

  test('also tidies this environment\'s images from before the rename (`kortix-meta-<env>-*`)', async () => {
    const env = config.INTERNAL_KORTIX_ENV;
    const renamed = `kortix-meta-${env}-${'d'.repeat(16)}`;
    const provider = fakeProvider([renamed, myKortixSnapshotName(HASH_A)]);

    await reapSupersededMyKortixSnapshots(provider, myKortixSnapshotName(HASH_B), NOTHING_RECENT);

    expect(provider.deleted).toEqual([myKortixSnapshotName(HASH_A), renamed]);
  });

  test('leaves un-namespaced legacy names alone', async () => {
    // `kortix-meta-<hash>` with no environment segment predates this scheme.
    // They cannot be attributed to an environment, so the reap must not guess —
    // they need one deliberate cleanup instead.
    const legacy = `kortix-meta-${'c'.repeat(16)}`;
    const provider = fakeProvider([legacy, myKortixSnapshotName(HASH_A)]);

    await reapSupersededMyKortixSnapshots(provider, myKortixSnapshotName(HASH_B), NOTHING_RECENT);

    expect(provider.deleted).not.toContain(legacy);
  });

  test('a listing failure never propagates into the build', async () => {
    // The image is already active by the time the reap runs. Tidying must not
    // be able to fail the thing that produced it.
    const provider = {
      listSnapshots: async () => {
        throw new Error('provider unreachable');
      },
      deleteSnapshot: async () => {},
    };
    await expect(
      reapSupersededMyKortixSnapshots(provider, myKortixSnapshotName(HASH_B), NOTHING_RECENT),
    ).resolves.toBeUndefined();
  });

  test('nothing to reap is not an error', async () => {
    const keep = myKortixSnapshotName(HASH_B);
    const provider = fakeProvider([keep]);
    await reapSupersededMyKortixSnapshots(provider, keep, NOTHING_RECENT);
    expect(provider.deleted).toEqual([]);
  });
});

describe('meta snapshot reap — fail-closed protection', () => {
  test('a failing protection lookup skips the reap entirely', async () => {
    // The shared `recentlyBuiltSnapshotNames` returns an empty set when its DB
    // query fails, which a reaper reads as "nothing is protected — delete it
    // all". Mid-rollout that deletes the image the not-yet-restarted replicas
    // are booting. This reap must do the opposite and delete nothing.
    const provider = fakeProvider([myKortixSnapshotName(HASH_A), myKortixSnapshotName(HASH_B)]);
    await reapSupersededMyKortixSnapshots(provider, myKortixSnapshotName(HASH_B), async () => {
      throw new Error('database unreachable');
    });
    expect(provider.deleted).toEqual([]);
  });

  test('a protected name survives while its siblings are reaped', async () => {
    const keep = myKortixSnapshotName(HASH_B);
    const protectedName = myKortixSnapshotName(HASH_A);
    const stale = myKortixSnapshotName('d'.repeat(64));
    const provider = fakeProvider([keep, protectedName, stale]);

    await reapSupersededMyKortixSnapshots(provider, keep, async () => new Set([protectedName]));

    expect(provider.deleted).toEqual([stale]);
  });
});

describe('meta snapshot reap — served images across the rename', () => {
  test('the first deploy after the rename keeps the legacy images sessions still boot, and reaps the other legacy ones', async () => {
    // Old replicas still boot `kortix-meta-<env>-*` and every session start
    // falls back to it while the first `kortix-mykortix-*` image builds. The
    // served list holds both prefixes, so the reap that follows that build
    // must leave the served legacy image alone.
    const env = config.INTERNAL_KORTIX_ENV;
    const servedLegacy = `kortix-meta-${env}-${'1'.repeat(16)}`;
    const servedLegacyOlder = `kortix-meta-${env}-${'2'.repeat(16)}`;
    const staleLegacy = `kortix-meta-${env}-${'3'.repeat(16)}`;
    const keep = myKortixSnapshotName(HASH_B);
    const provider = fakeProvider([keep, servedLegacy, servedLegacyOlder, staleLegacy]);

    await reapSupersededMyKortixSnapshots(provider, keep, (names, withinMs) =>
      myKortixReapProtection(names, withinMs, {
        recentlyBuilt: async () => new Set(),
        readServed: async () => [{ snapshotName: servedLegacy, contentHash: null }, { snapshotName: servedLegacyOlder, contentHash: null }],
      }),
    );

    expect(provider.deleted).toEqual([staleLegacy]);
  });

  test('served images of both prefixes are protected together, with the recent builds', async () => {
    const env = config.INTERNAL_KORTIX_ENV;
    const servedNew = myKortixSnapshotName(HASH_A);
    const servedLegacy = `kortix-meta-${env}-${'1'.repeat(16)}`;
    const recent = myKortixSnapshotName('9'.repeat(64));
    const protectedSet = await myKortixReapProtection([recent, servedNew, servedLegacy], 60_000, {
      recentlyBuilt: async () => new Set([recent]),
      readServed: async () => [{ snapshotName: servedNew, contentHash: null }, { snapshotName: servedLegacy, contentHash: null }],
    });
    expect([...protectedSet].sort()).toEqual([recent, servedNew, servedLegacy].sort());
  });
});

describe('meta snapshot reap — local stacks', () => {
  test("a local stack deletes no image: it shares dev's namespace and cannot see dev's builds", async () => {
    // KRTX-2546. A local stack runs as INTERNAL_KORTIX_ENV=dev on dev's
    // provider organisation, and its protection lookup reads its OWN database,
    // which has never heard of the image deployed dev boots meta sandboxes
    // from. 2026-10-20: one worktree's stack logged 30+ "reaped superseded
    // kortix-meta-dev-*" deletes. Deployed dev's own reap still tidies the
    // images local stacks leave behind.
    const flags = config as { KORTIX_LOCAL_DEV: boolean };
    const before = flags.KORTIX_LOCAL_DEV;
    flags.KORTIX_LOCAL_DEV = true;
    try {
      const provider = fakeProvider([myKortixSnapshotName(HASH_A), myKortixSnapshotName('d'.repeat(64))]);
      await reapSupersededMyKortixSnapshots(provider, myKortixSnapshotName(HASH_B), NOTHING_RECENT);
      expect(provider.deleted).toEqual([]);
    } finally {
      flags.KORTIX_LOCAL_DEV = before;
    }
  });
});
