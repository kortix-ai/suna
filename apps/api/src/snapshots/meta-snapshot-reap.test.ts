/**
 * The meta-image reap, and the property that makes it safe to run at all.
 *
 * Incident it comes from: `ensureMetaSandboxImage` deleted a snapshot only when
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
import { metaSnapshotName, reapSupersededMetaSnapshots } from './builder';

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
    const name = metaSnapshotName(HASH_A);
    expect(name).toBe(`kortix-meta-${config.INTERNAL_KORTIX_ENV}-${'a'.repeat(16)}`);
  });

  test('two different fingerprints get different names', () => {
    expect(metaSnapshotName(HASH_A)).not.toBe(metaSnapshotName(HASH_B));
  });
});

describe('meta snapshot reap', () => {
  test("never touches another environment's images", async () => {
    // The whole reason for the namespace. If this regresses, a dev deploy can
    // delete the image production is booting from.
    const env = config.INTERNAL_KORTIX_ENV;
    const others = ['dev', 'staging', 'prod', 'preview'].filter((e) => e !== env);
    const foreign = others.map((e) => `kortix-meta-${e}-${'f'.repeat(16)}`);
    const provider = fakeProvider([metaSnapshotName(HASH_A), ...foreign]);

    await reapSupersededMetaSnapshots(provider, metaSnapshotName(HASH_B), NOTHING_RECENT);

    // Only our own superseded image goes.
    expect(provider.deleted).toEqual([metaSnapshotName(HASH_A)]);
    for (const name of foreign) expect(provider.deleted).not.toContain(name);
  });

  test('keeps the image just built', async () => {
    const keep = metaSnapshotName(HASH_B);
    const provider = fakeProvider([keep, metaSnapshotName(HASH_A)]);

    await reapSupersededMetaSnapshots(provider, keep, NOTHING_RECENT);

    expect(provider.deleted).not.toContain(keep);
    expect(provider.deleted).toContain(metaSnapshotName(HASH_A));
  });

  test('leaves un-namespaced legacy names alone', async () => {
    // `kortix-meta-<hash>` with no environment segment predates this scheme.
    // They cannot be attributed to an environment, so the reap must not guess —
    // they need one deliberate cleanup instead.
    const legacy = `kortix-meta-${'c'.repeat(16)}`;
    const provider = fakeProvider([legacy, metaSnapshotName(HASH_A)]);

    await reapSupersededMetaSnapshots(provider, metaSnapshotName(HASH_B), NOTHING_RECENT);

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
      reapSupersededMetaSnapshots(provider, metaSnapshotName(HASH_B), NOTHING_RECENT),
    ).resolves.toBeUndefined();
  });

  test('nothing to reap is not an error', async () => {
    const keep = metaSnapshotName(HASH_B);
    const provider = fakeProvider([keep]);
    await reapSupersededMetaSnapshots(provider, keep, NOTHING_RECENT);
    expect(provider.deleted).toEqual([]);
  });
});

describe('meta snapshot reap — fail-closed protection', () => {
  test('a failing protection lookup skips the reap entirely', async () => {
    // The shared `recentlyBuiltSnapshotNames` returns an empty set when its DB
    // query fails, which a reaper reads as "nothing is protected — delete it
    // all". Mid-rollout that deletes the image the not-yet-restarted replicas
    // are booting. This reap must do the opposite and delete nothing.
    const provider = fakeProvider([metaSnapshotName(HASH_A), metaSnapshotName(HASH_B)]);
    await reapSupersededMetaSnapshots(provider, metaSnapshotName(HASH_B), async () => {
      throw new Error('database unreachable');
    });
    expect(provider.deleted).toEqual([]);
  });

  test('a protected name survives while its siblings are reaped', async () => {
    const keep = metaSnapshotName(HASH_B);
    const protectedName = metaSnapshotName(HASH_A);
    const stale = metaSnapshotName('d'.repeat(64));
    const provider = fakeProvider([keep, protectedName, stale]);

    await reapSupersededMetaSnapshots(provider, keep, async () => new Set([protectedName]));

    expect(provider.deleted).toEqual([stale]);
  });
});
