import { describe, expect, it } from 'bun:test';
import {
  DAYTONA_ORG_SNAPSHOT_LIMIT,
  PPWARM_PREFIX,
  QUOTA_GC_KEEP_FRESHEST_DEFAULTS,
  QUOTA_GC_MAX_PER_PASS,
  QUOTA_GC_ORG_HIGH_WATER,
  QUOTA_GC_ORG_TARGET,
  SCOPED_PPWARM_PREFIX,
  type SnapshotLike,
  selectSnapshotsToReap,
} from '../snapshots/quota-gc-select';

const NOW = Date.parse('2026-07-08T00:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function snap(name: string, opts: Partial<SnapshotLike> = {}): SnapshotLike {
  return {
    id: opts.id ?? `id-${name}`,
    name,
    state: opts.state ?? 'active',
    createdAt: opts.createdAt ?? ago(1),
    lastUsedAt: opts.lastUsedAt ?? ago(1),
  };
}

/** Pad the org up to `n` snapshots with untouchable stock images. */
function padToOrgSize(items: SnapshotLike[], n: number): SnapshotLike[] {
  const pad: SnapshotLike[] = [];
  for (let i = items.length; i < n; i++) pad.push(snap(`daytonaio/sandbox:${i}`));
  return [...items, ...pad];
}

const run = (all: SnapshotLike[], referenced: string[] = []) =>
  selectSnapshotsToReap({ all, referenced: new Set(referenced), now: NOW });

const names = (r: ReturnType<typeof run>) => r.doomed.map((d) => d.snapshot.name);

describe('selectSnapshotsToReap — pressure gate', () => {
  it('does nothing while the ORG total is under the high-water mark', () => {
    const defaults = Array.from({ length: 40 }, (_, i) =>
      snap(`kortix-default-${i}`, { lastUsedAt: ago(i + 1) }),
    );
    const res = run(padToOrgSize(defaults, QUOTA_GC_ORG_HIGH_WATER - 1));
    expect(res.underPressure).toBe(false);
    expect(res.doomed).toEqual([]);
  });

  // The bug: the old gate counted only our template namespace, so retired warm
  // images + stock images could carry the org past 100 while the gate slept at 15/60.
  it('fires on org total even when OUR namespace is tiny', () => {
    const managed = [
      ...Array.from({ length: 13 }, (_, i) => snap(`kortix-default-${i}`, { lastUsedAt: ago(i) })),
      snap('kortix-tpl-a'),
    ];
    const stock = Array.from({ length: 70 }, (_, i) => snap(`daytonaio/sandbox:${i}`));
    const res = run([...managed, ...stock]);

    expect(res.orgTotal).toBe(84);
    expect(res.managedCount).toBe(14);
    expect(res.orgTotal).toBeGreaterThanOrEqual(QUOTA_GC_ORG_HIGH_WATER);
    expect(res.underPressure).toBe(true);
    expect(res.doomed.length).toBeGreaterThan(0);
  });

  it('high-water leaves headroom below the hard org limit', () => {
    expect(QUOTA_GC_ORG_HIGH_WATER).toBeLessThan(DAYTONA_ORG_SNAPSHOT_LIMIT);
  });
});

describe('selectSnapshotsToReap — defaults ranked by freshness, not idle', () => {
  // A superseded default keeps a FRESH lastUsedAt (it was live minutes ago), so the
  // old 7-day idle gate made zero defaults eligible while ~4.5/day accrued.
  it('reaps superseded defaults that are not idle at all', () => {
    const defaults = Array.from({ length: 20 }, (_, i) =>
      snap(`kortix-default-${i}`, { lastUsedAt: new Date(NOW - i * 60_000).toISOString() }),
    );
    const res = run(padToOrgSize(defaults, 90));

    expect(res.underPressure).toBe(true);
    const reaped = names(res);
    // Freshest N survive.
    for (let i = 0; i < QUOTA_GC_KEEP_FRESHEST_DEFAULTS; i++) {
      expect(reaped).not.toContain(`kortix-default-${i}`);
    }
    expect(reaped).toContain(`kortix-default-${QUOTA_GC_KEEP_FRESHEST_DEFAULTS}`);
    expect(reaped).toContain('kortix-default-19');
  });

  it('never reaps a default a local template row still references', () => {
    const defaults = Array.from({ length: 20 }, (_, i) =>
      snap(`kortix-default-${i}`, { lastUsedAt: ago(i) }),
    );
    const res = run(padToOrgSize(defaults, 90), ['kortix-default-19']);
    expect(names(res)).not.toContain('kortix-default-19');
  });
});

describe('selectSnapshotsToReap — safety invariants', () => {
  const base = () =>
    padToOrgSize(
      [
        snap('kortix-tpl-user', { lastUsedAt: ago(30) }),
        snap('kortix-ppwarm-aaaaaaaa-111111111111', { lastUsedAt: ago(1) }),
        snap('daytona-small', { lastUsedAt: ago(400) }),
        snap('bench-container-ubuntu2204', { lastUsedAt: ago(400) }),
      ],
      90,
    );

  it('never touches non-kortix stock/bench images, however stale', () => {
    const reaped = names(run(base()));
    expect(reaped).not.toContain('daytona-small');
    expect(reaped).not.toContain('bench-container-ubuntu2204');
  });

  it('never deletes an in-flight build', () => {
    const all = padToOrgSize(
      [
        snap('kortix-default-live', { lastUsedAt: ago(0), state: 'building' }),
        ...Array.from({ length: 20 }, (_, i) =>
          snap(`kortix-default-${i}`, { lastUsedAt: ago(i + 1) }),
        ),
      ],
      90,
    );
    expect(names(run(all))).not.toContain('kortix-default-live');
  });

  it('reaps broken-state snapshots in our namespace', () => {
    const all = padToOrgSize([snap('kortix-default-bad', { state: 'error' })], 90);
    expect(names(run(all))).toContain('kortix-default-bad');
  });

  it('keeps anything with no usable timestamp — cannot prove it is idle', () => {
    const all = padToOrgSize(
      [snap('kortix-tpl-notime', { lastUsedAt: null, createdAt: null })],
      90,
    );
    expect(names(run(all))).not.toContain('kortix-tpl-notime');
  });

  it('caps deletions per pass and reports the remainder instead of truncating silently', () => {
    const defaults = Array.from({ length: 60 }, (_, i) =>
      snap(`kortix-default-${i}`, { lastUsedAt: ago(i + 1) }),
    );
    const res = run(padToOrgSize(defaults, 90));
    expect(res.doomed.length).toBe(QUOTA_GC_MAX_PER_PASS);
    // 60 defaults, freshest 12 kept → 48 reapable, 15 this pass, 33 deferred.
    expect(res.deferred).toBe(48 - QUOTA_GC_MAX_PER_PASS);
  });
});

/**
 * The per-project warm image system is RETIRED. Its baker, its routing and its
 * session-side read path are gone, so nothing can boot one of these images any
 * more — they are pure quota debt in a provider org whose cap counts them. Both
 * historical namespaces stay in MANAGED_PREFIXES for exactly one purpose: so this
 * rule can still see them and free them.
 */
describe('selectSnapshotsToReap — retired per-project warm namespaces', () => {
  const LEGACY = `${PPWARM_PREFIX}0945686d-111111111111`;
  const UNSCOPED = `${PPWARM_PREFIX}0945686d-22222222-333333333333`;
  const SCOPED = `${SCOPED_PPWARM_PREFIX}111111111111-222222222222-3333333333333333-4444444444444444`;

  it('names the two historical namespaces exactly as the retired baker minted them', () => {
    expect(PPWARM_PREFIX).toBe('kortix-ppwarm-');
    expect(SCOPED_PPWARM_PREFIX).toBe('kpp2-');
  });

  it('reclaims every retired warm image on sight, regardless of freshness or idle time', () => {
    const all = padToOrgSize(
      [
        snap(LEGACY, { lastUsedAt: ago(0) }),
        snap(UNSCOPED, { lastUsedAt: ago(0) }),
        snap(SCOPED, { lastUsedAt: ago(0) }),
      ],
      QUOTA_GC_ORG_HIGH_WATER,
    );
    const res = run(all);
    const reaped = names(res);
    expect(reaped).toContain(LEGACY);
    expect(reaped).toContain(UNSCOPED);
    expect(reaped).toContain(SCOPED);
    for (const candidate of res.doomed) {
      if (candidate.snapshot.name.startsWith('kortix-default-')) continue;
      expect(candidate.reason).toBe('retired per-project warm image');
    }
  });

  it('reclaims a malformed name inside a retired namespace — the format no longer matters', () => {
    const malformed = `${SCOPED_PPWARM_PREFIX}111111111111-nothex`;
    const all = padToOrgSize([snap(malformed)], QUOTA_GC_ORG_HIGH_WATER);
    expect(names(run(all))).toContain(malformed);
  });

  it('skips tombstoned names — a soft-deleted image no longer costs a quota slot', () => {
    const tombstone = `${LEGACY}__deleted-1`;
    const all = padToOrgSize([snap(tombstone)], QUOTA_GC_ORG_HIGH_WATER);
    expect(names(run(all))).not.toContain(tombstone);
  });

  it('still honours the referenced-template guard over a retired warm name', () => {
    const all = padToOrgSize([snap(LEGACY)], QUOTA_GC_ORG_HIGH_WATER);
    expect(names(run(all, [LEGACY]))).not.toContain(LEGACY);
  });

  it('still refuses to delete an in-flight retired warm build', () => {
    const all = padToOrgSize([snap(LEGACY, { state: 'building' })], QUOTA_GC_ORG_HIGH_WATER);
    expect(names(run(all))).not.toContain(LEGACY);
  });
});

describe('selectSnapshotsToReap — budget shortfall reporting', () => {
  /**
   * The alarm that would have caught the original outage: GC out of road. Rule 2
   * already reclaims every retired warm image, so once those are gone the only
   * thing left over target is live template/default state. Report, never evict.
   */
  it('flags budgetUnresolved when nothing reapable can bring the org to target', () => {
    const live = Array.from({ length: 25 }, (_, i) =>
      // Recently used custom templates: not idle, not defaults, nothing to reap.
      snap(`kortix-tpl-live-${i}`, { lastUsedAt: ago(0) }),
    );
    const res = run(padToOrgSize(live, 107));
    expect(res.orgTotal).toBe(107);
    expect(res.underPressure).toBe(true);
    expect(res.doomed).toEqual([]);
    expect(res.budgetUnresolved).toBe(true);
  });

  it('does not flag budgetUnresolved once the retired warm images cover the shortfall', () => {
    const warm = Array.from({ length: 25 }, (_, i) =>
      snap(`${PPWARM_PREFIX}${i.toString(16).padStart(8, '0')}-${(i + 1).toString(16).padStart(12, '0')}`, {
        lastUsedAt: ago(0),
      }),
    );
    const res = run(padToOrgSize(warm, 107));
    expect(res.orgTotal).toBe(107);
    expect(res.underPressure).toBe(true);
    expect(res.budgetUnresolved).toBe(false);
  });
});

describe('selectSnapshotsToReap — pinned-image guard', () => {
  const ppw = (proj: string, hash: string, days: number, extra: Partial<SnapshotLike> = {}) =>
    snap(`kortix-ppwarm-${proj}-${hash}`, { lastUsedAt: ago(days), createdAt: ago(days), ...extra });

  it('excludes a pinned image from the reap pool entirely, by name', () => {
    const pinned = ppw('c0111abe', 'cccccccccccc', 3);
    const sibling = ppw('c0111abe', 'bbbbbbbbbbbb', 3);
    const all = padToOrgSize([pinned, sibling], 84);

    const unguarded = selectSnapshotsToReap({ all, referenced: new Set(), now: NOW });
    expect(unguarded.doomed.map((d) => d.snapshot.name)).toContain(pinned.name);

    const guarded = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      pinnedImages: new Set([pinned.name]),
      now: NOW,
    });
    const doomed = guarded.doomed.map((d) => d.snapshot.name);
    expect(doomed).not.toContain(pinned.name);
    expect(doomed).toContain(sibling.name);
  });

  it('protects a pinned image matched by external id (snapshot id), not just name', () => {
    const pinnedById = ppw('c0222abe', 'dddddddddddd', 3, { id: 'ext-tpl-123' });
    const sibling = ppw('c0222abe', 'eeeeeeeeeeee', 1);
    const all = padToOrgSize([pinnedById, sibling], 84);
    const guarded = selectSnapshotsToReap({
      all,
      referenced: new Set(),
      pinnedImages: new Set(['ext-tpl-123']),
      now: NOW,
    });
    expect(guarded.doomed.map((d) => d.snapshot.name)).not.toContain(pinnedById.name);
  });
});
