import { describe, expect, it } from 'bun:test';
import {
  DAYTONA_ORG_SNAPSHOT_LIMIT,
  QUOTA_GC_KEEP_FRESHEST_DEFAULTS,
  QUOTA_GC_MAX_PER_PASS,
  QUOTA_GC_ORG_HIGH_WATER,
  QUOTA_GC_ORG_TARGET,
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

  // The bug: the old gate counted only our template namespace, so ppwarm + stock
  // images could carry the org past 100 while the gate slept at 15/60.
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
        snap('kortix-ppwarm-aaaaaaaa-tip', { lastUsedAt: ago(1) }),
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

  // These two isolate the LIVENESS rules, so the org sits under QUOTA_GC_ORG_TARGET
  // (still over the high-water mark). Above target the budget stage legitimately
  // evicts idle ppwarm tips these cases expect to survive — covered separately below.
  const UNDER_TARGET = QUOTA_GC_ORG_TARGET - 1;

  it('keeps the freshest ppwarm tip per project and reaps its stragglers', () => {
    const all = padToOrgSize(
      [
        snap('kortix-ppwarm-0945686d-new', { lastUsedAt: ago(1) }),
        snap('kortix-ppwarm-0945686d-old', { lastUsedAt: ago(2) }),
        snap('kortix-ppwarm-0945686d-older', { lastUsedAt: ago(3) }),
        snap('kortix-ppwarm-ffffffff-solo', { lastUsedAt: ago(5) }),
      ],
      UNDER_TARGET,
    );
    const reaped = names(run(all));
    expect(reaped).not.toContain('kortix-ppwarm-0945686d-new');
    expect(reaped).toContain('kortix-ppwarm-0945686d-old');
    expect(reaped).toContain('kortix-ppwarm-0945686d-older');
    // A project's only tip is live until proven idle.
    expect(reaped).not.toContain('kortix-ppwarm-ffffffff-solo');
  });

  // One Daytona org, many databases: a ppwarm tip we can't attribute may belong to
  // another environment. Idle time is the ONLY cross-env-safe liveness signal.
  it('reaps a long-idle ppwarm tip but spares a recently used one', () => {
    const all = padToOrgSize(
      [
        snap('kortix-ppwarm-aaaaaaaa-stale', { lastUsedAt: ago(20) }),
        snap('kortix-ppwarm-bbbbbbbb-fresh', { lastUsedAt: ago(2) }),
      ],
      UNDER_TARGET,
    );
    const reaped = names(run(all));
    expect(reaped).toContain('kortix-ppwarm-aaaaaaaa-stale');
    expect(reaped).not.toContain('kortix-ppwarm-bbbbbbbb-fresh');
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
 * The live shape on 2026-07-08: 69 ppwarm tips for 69 distinct, non-archived
 * projects + 22 stock images + 13 defaults + 3 templates = 107, over the 100 cap.
 * Every liveness rule reclaims nothing (each tip is a live project's only tip), so
 * a purely liveness-based GC sat at 100% pressure doing nothing. ppwarm is a pure
 * cache, so it must absorb budget pressure — or say it cannot.
 */
describe('selectSnapshotsToReap — ppwarm LRU budget', () => {
  const liveOrg = (ppwarmCount: number, idleHours: number) =>
    padToOrgSize(
      [
        ...Array.from({ length: ppwarmCount }, (_, i) =>
          // distinct proj8 per tip → no "superseded tip" rule can fire
          snap(`kortix-ppwarm-${i.toString(16).padStart(8, '0')}-tip`, {
            lastUsedAt: new Date(NOW - idleHours * 3_600_000).toISOString(),
          }),
        ),
        ...Array.from({ length: 12 }, (_, i) =>
          snap(`kortix-default-${i}`, { lastUsedAt: ago(0) }),
        ),
      ],
      107,
    );

  it('evicts LRU ppwarm to reach target when no liveness rule can free anything', () => {
    const res = run(liveOrg(69, 30));
    expect(res.orgTotal).toBe(107);
    expect(res.underPressure).toBe(true);
    expect(res.doomed.length).toBeGreaterThan(0);
    expect(res.doomed.every((d) => d.snapshot.name.startsWith('kortix-ppwarm-'))).toBe(true);
    expect(res.doomed.some((d) => d.reason.includes('LRU eviction'))).toBe(true);
    expect(res.budgetUnresolved).toBe(false);
  });

  it('evicts oldest-first', () => {
    const all = padToOrgSize(
      [
        snap('kortix-ppwarm-aaaaaaaa-tip', {
          lastUsedAt: new Date(NOW - 50 * 3_600_000).toISOString(),
        }),
        snap('kortix-ppwarm-bbbbbbbb-tip', {
          lastUsedAt: new Date(NOW - 10 * 3_600_000).toISOString(),
        }),
      ],
      QUOTA_GC_ORG_TARGET + 1,
    );
    const reaped = names(run(all));
    expect(reaped).toContain('kortix-ppwarm-aaaaaaaa-tip');
    expect(reaped).not.toContain('kortix-ppwarm-bbbbbbbb-tip');
  });

  // Evicting a hot project's tip frees a slot it reclaims on its next session:
  // churn, not reclamation.
  it('never evicts a recently-used ppwarm tip, even under pressure', () => {
    const res = run(liveOrg(69, 1)); // every tip used an hour ago
    expect(res.underPressure).toBe(true);
    expect(res.doomed.every((d) => !d.reason.includes('LRU eviction'))).toBe(true);
  });

  // The alarm that would have caught the original outage: GC out of road.
  it('flags budgetUnresolved when the cache floor exceeds the quota', () => {
    const res = run(liveOrg(69, 1)); // nothing evictable, still 107 > target
    expect(res.budgetUnresolved).toBe(true);
  });

  it('does not flag budgetUnresolved once target is reachable', () => {
    const res = run(liveOrg(69, 30));
    expect(res.budgetUnresolved).toBe(false);
  });
});
