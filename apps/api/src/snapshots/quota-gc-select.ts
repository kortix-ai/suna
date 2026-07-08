/**
 * Pure selection logic for the snapshot quota GC.
 *
 * Split out from quota-gc.ts (which owns the DB + provider IO) so the rules that
 * decide what gets DELETED are unit-testable without a database, a Daytona org, or
 * a clock. Nothing here imports config, db, or a provider.
 *
 * ── Why the old pressure gate could never fire ──────────────────────────────
 * The Daytona quota (100) counts EVERY snapshot in the org: our templates, our
 * per-project warm images, and Daytona's own stock/bench images. The old gate
 * counted only `kortix-default-` / `kortix-tpl-` / `kortix-wproj-`. Measured live
 * (2026-07-08): 120 snapshots tripped the cap while that namespace held 98 — and
 * after a manual reclaim, 68 total against a GC-visible 15. With ~46 ppwarm + 22
 * stock images uncounted, the namespace would have to reach 60 before GC woke up,
 * i.e. an org total of ~128 — nearly 30 snapshots past the ceiling it defends.
 * The gate is therefore on the ORG TOTAL, which is what the quota actually meters.
 *
 * ── Why defaults can't use an idle gate ─────────────────────────────────────
 * The platform default is resolved dynamically from the runtime fingerprint; it is
 * NOT stored in `sandbox_templates.provider_snapshot_name` (only custom `kortix-tpl-`
 * rows and dev's default are). So "referenced" never protects it, and a *superseded*
 * default keeps a fresh `lastUsedAt` — it was the live default until minutes ago.
 * A 7-day idle rule makes zero defaults eligible while ~4.5/day accrue. Freshness
 * rank, not idle time, is the only signal that separates live from superseded:
 * every live environment boots its default constantly, so the live ones are always
 * in the freshest few. Reaping a still-live default is self-healing — the next boot
 * hits the snapshot-missing auto-heal and rebuilds (one slow boot, no data loss).
 *
 * ── Cross-environment safety ────────────────────────────────────────────────
 * dev / staging / prod / laptops share ONE Daytona org but have SEPARATE databases.
 * This process can only see its own DB. So "no project row for this proj8" does NOT
 * mean the project is gone — it may be another environment's. `lastUsedAt` is the
 * only cross-env liveness signal we have, and it is the sole basis on which a
 * ppwarm tip belonging to nobody-we-know is reclaimed.
 */

/** The Daytona org-wide snapshot cap. Counts every snapshot, ours or not. */
export const DAYTONA_ORG_SNAPSHOT_LIMIT = 100;

/** Start reclaiming once the ORG total reaches this. Leaves room to act before builds fail. */
export const QUOTA_GC_ORG_HIGH_WATER = 80;

/** Live env defaults are booted constantly, so they're always in the freshest set. */
export const QUOTA_GC_KEEP_FRESHEST_DEFAULTS = 12;

/** Unreferenced user templates / legacy warm bases must be idle this long. */
export const QUOTA_GC_MIN_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A ppwarm tip unused this long is reclaimed even though we can't see whose project
 * it is. Cross-env safe: any environment still booting from it keeps lastUsedAt fresh.
 */
export const QUOTA_GC_PPWARM_MAX_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/** Max deletions per sweep pass — keeps each pass cheap and observable. */
export const QUOTA_GC_MAX_PER_PASS = 15;

export const DEFAULT_PREFIX = 'kortix-default-';
export const PPWARM_PREFIX = 'kortix-ppwarm-';
/** Namespaces we own and may reap. Anything else (stock/bench images) is untouched. */
export const MANAGED_PREFIXES = [
  DEFAULT_PREFIX,
  'kortix-tpl-',
  'kortix-wproj-',
  PPWARM_PREFIX,
] as const;

/** States that mean a build is IN FLIGHT — deleting these would break a live boot. */
const IN_FLIGHT_STATES = new Set(['building', 'pulling']);
/** States that mean the snapshot is pure waste. */
const BROKEN_STATES = new Set(['error', 'build_failed']);

export interface SnapshotLike {
  id: string;
  name: string;
  state: string;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface ReapCandidate {
  snapshot: SnapshotLike;
  reason: string;
}

export interface SelectInput {
  /** EVERY snapshot in the org, including stock images. A partial list must never be passed. */
  all: SnapshotLike[];
  /** Names any local `sandbox_templates` row still points at. Never reaped. */
  referenced: ReadonlySet<string>;
  now: number;
}

export interface SelectResult {
  /** Org-wide total — the number the Daytona quota actually meters. */
  orgTotal: number;
  /** Snapshots in namespaces we own. */
  managedCount: number;
  /** True when orgTotal has reached the high-water mark and reclaiming is warranted. */
  underPressure: boolean;
  /** Everything reapable, most-reclaimable first, already capped at MAX_PER_PASS. */
  doomed: ReapCandidate[];
  /** Reapable but dropped by the per-pass cap — logged so truncation is never silent. */
  deferred: number;
}

export function isManaged(name: string): boolean {
  return MANAGED_PREFIXES.some((p) => name.startsWith(p));
}

/** proj8 scope key of a ppwarm name: `kortix-ppwarm-<proj8>-<hash12>`. */
export function ppwarmProj8(name: string): string | null {
  if (!name.startsWith(PPWARM_PREFIX)) return null;
  const rest = name.slice(PPWARM_PREFIX.length);
  const proj8 = rest.split('-')[0];
  return proj8 || null;
}

function lastTouch(s: SnapshotLike): number {
  const t = s.lastUsedAt || s.createdAt;
  return t ? new Date(t).getTime() : Number.NaN;
}

/** Freshest first; anything without a usable timestamp sorts last (and is kept). */
function byFreshestFirst(a: SnapshotLike, b: SnapshotLike): number {
  const ta = lastTouch(a);
  const tb = lastTouch(b);
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
  if (!Number.isFinite(ta)) return 1;
  if (!Number.isFinite(tb)) return -1;
  return tb - ta;
}

/**
 * Decide what to reap. Ordering of the returned list is deliberate: the cheapest,
 * least-recoverable-value deletions come first, so the per-pass cap always spends
 * itself on the safest wins before touching anything judgement-based.
 */
export function selectSnapshotsToReap(input: SelectInput): SelectResult {
  const { all, referenced, now } = input;

  const orgTotal = all.length;
  const managed = all.filter((s) => isManaged(s.name));
  const underPressure = orgTotal >= QUOTA_GC_ORG_HIGH_WATER;

  const result: SelectResult = {
    orgTotal,
    managedCount: managed.length,
    underPressure,
    doomed: [],
    deferred: 0,
  };
  if (!underPressure) return result;

  // Reapable universe: ours, not referenced by a local template row, not mid-build.
  const pool = managed.filter((s) => !referenced.has(s.name) && !IN_FLIGHT_STATES.has(s.state));

  const candidates: ReapCandidate[] = [];
  const claimed = new Set<string>();
  const claim = (s: SnapshotLike, reason: string) => {
    if (claimed.has(s.id)) return;
    claimed.add(s.id);
    candidates.push({ snapshot: s, reason });
  };

  // 1. Broken builds — pure waste, zero risk.
  for (const s of pool
    .filter((s) => BROKEN_STATES.has(s.state))
    .sort(byFreshestFirst)
    .reverse()) {
    claim(s, `state=${s.state}`);
  }

  // 2. Superseded ppwarm tips: exactly one tip per project is live. The on-bake
  //    reaper already does this, but it misses stragglers when a bake fails midway.
  const byProj = new Map<string, SnapshotLike[]>();
  for (const s of pool) {
    if (s.name.includes('__deleted')) continue; // soft-delete tombstone; not quota-counting
    const proj8 = ppwarmProj8(s.name);
    if (!proj8) continue;
    const group = byProj.get(proj8);
    if (group) group.push(s);
    else byProj.set(proj8, [s]);
  }
  for (const [proj8, group] of byProj) {
    if (group.length < 2) continue;
    const [, ...superseded] = [...group].sort(byFreshestFirst);
    for (const s of superseded) claim(s, `superseded ppwarm tip for project ${proj8}`);
  }

  // 3. ppwarm tips nobody has booted in a long time. We cannot see other envs' DBs,
  //    so idle time is the only safe liveness proof. Purely a cache — a wrongly
  //    reaped tip re-bakes on the project's next background sync.
  for (const s of pool) {
    const t = lastTouch(s);
    if (!ppwarmProj8(s.name)) continue;
    if (!Number.isFinite(t)) continue; // can't prove idle → keep
    if (now - t > QUOTA_GC_PPWARM_MAX_IDLE_MS) {
      claim(s, `ppwarm idle ${Math.floor((now - t) / 86_400_000)}d`);
    }
  }

  // 4. Superseded platform defaults — keep only the freshest N. Not idle-gated
  //    (see the header): a superseded default's lastUsedAt is fresh by construction.
  const defaults = pool.filter((s) => s.name.startsWith(DEFAULT_PREFIX)).sort(byFreshestFirst);
  for (const s of defaults.slice(QUOTA_GC_KEEP_FRESHEST_DEFAULTS)) {
    claim(s, 'superseded default (beyond freshest N)');
  }

  // 5. Everything else we own (user templates `kortix-tpl-`, legacy `kortix-wproj-`):
  //    conservative idle gate. These can encode real user intent, so they get the
  //    benefit of the doubt that a content-addressed default does not.
  for (const s of pool) {
    if (s.name.startsWith(DEFAULT_PREFIX) || ppwarmProj8(s.name)) continue;
    const t = lastTouch(s);
    if (!Number.isFinite(t)) continue;
    if (now - t > QUOTA_GC_MIN_IDLE_MS) {
      claim(s, `unreferenced + idle ${Math.floor((now - t) / 86_400_000)}d`);
    }
  }

  result.deferred = Math.max(0, candidates.length - QUOTA_GC_MAX_PER_PASS);
  result.doomed = candidates.slice(0, QUOTA_GC_MAX_PER_PASS);
  return result;
}
