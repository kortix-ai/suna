/**
 * Namespaces of the RETIRED per-project warm image system. The baker, its
 * routing and its session-side read path are gone; nothing can boot one of these
 * images any more (a session only boots an image whose name equals the template
 * identity it resolved). They are pure quota debt, so the selector reclaims them
 * on sight — but the prefixes must stay in `MANAGED_PREFIXES`, or the historical
 * tips would leak against the provider's snapshot cap forever.
 */
export const PPWARM_PREFIX = 'kortix-ppwarm-';
export const SCOPED_PPWARM_PREFIX = 'kpp2-';

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
 * dev / staging / prod / laptops can share ONE provider org but have SEPARATE
 * databases, and a snapshot name carries no owner. `lastUsedAt` is therefore
 * the only cross-environment liveness signal for the namespaces that are still
 * live (`kortix-default-`, `kortix-tpl-`, `kortix-wproj-`).
 *
 * ── Why the retired warm namespaces are reclaimed unconditionally ────────────
 * `kortix-ppwarm-` / `kpp2-` images were minted one-per-(project, tip) by the
 * per-project warm baker. Their floor was "every project that ever started a
 * session" — measured 2026-07-08, 69 tips against a 100-snapshot org cap, with
 * every liveness rule reclaiming nothing. That system is gone: no code path can
 * mint one and no session can boot one, in ANY environment sharing the org. So
 * the cross-environment caution above does not apply to them — a foreign
 * environment's ppwarm image is as unbootable as ours. Rule 2 takes them all.
 */

/** The Daytona org-wide snapshot cap. Counts every snapshot, ours or not. */
export const DAYTONA_ORG_SNAPSHOT_LIMIT = 100;

/** Start reclaiming once the ORG total reaches this. Leaves room to act before builds fail. */
export const QUOTA_GC_ORG_HIGH_WATER = 80;

/** Once reclaiming, free down to here — a buffer, not just back under the high-water mark. */
export const QUOTA_GC_ORG_TARGET = 85;

/** Live env defaults are booted constantly, so they're always in the freshest set. */
export const QUOTA_GC_KEEP_FRESHEST_DEFAULTS = 12;

/** Unreferenced user templates / legacy warm bases must be idle this long. */
export const QUOTA_GC_MIN_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** Max deletions per sweep pass — keeps each pass cheap and observable. */
export const QUOTA_GC_MAX_PER_PASS = 15;

export const DEFAULT_PREFIX = 'kortix-default-';
/** Namespaces we own and may reap. Anything else (stock/bench images) is untouched. */
export const MANAGED_PREFIXES = [
  DEFAULT_PREFIX,
  'kortix-tpl-',
  'kortix-wproj-',
  PPWARM_PREFIX,
  SCOPED_PPWARM_PREFIX,
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
  /**
   * FIX-K-lite: image identifiers (ppwarm NAME or provider external id) that are
   * the ACTIVE routing pin of SOME project. Never reaped — a proj8 prefix
   * collision must not let one project's superseded-tip selection delete another
   * project's LIVE pinned image. Injected by the IO layer (it reads the projects
   * table); defaults to empty so pure-unit callers keep the prior behavior.
   */
  pinnedImages?: ReadonlySet<string>;
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
  /**
   * True when, even after claiming every reapable snapshot, the org still can't
   * reach QUOTA_GC_ORG_TARGET. What remains is live template/default state, so
   * GC cannot fix this — only more capacity can. Callers MUST surface this
   * rather than log a quiet no-op.
   */
  budgetUnresolved: boolean;
}

export function isManaged(name: string): boolean {
  return MANAGED_PREFIXES.some((p) => name.startsWith(p));
}

/** An image from the retired per-project warm namespaces. */
function isPpwarmNamespaceName(name: string): boolean {
  return name.startsWith(PPWARM_PREFIX) || name.startsWith(SCOPED_PPWARM_PREFIX);
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
  const pinned = input.pinnedImages ?? new Set<string>();

  const orgTotal = all.length;
  const managed = all.filter((s) => isManaged(s.name));
  const underPressure = orgTotal >= QUOTA_GC_ORG_HIGH_WATER;

  const result: SelectResult = {
    orgTotal,
    managedCount: managed.length,
    underPressure,
    doomed: [],
    deferred: 0,
    budgetUnresolved: false,
  };
  if (!underPressure) return result;

  // Reapable universe: ours, not referenced by a local template row, not mid-build,
  // and NEVER a live pinned image of any project (FIX-K-lite: guards a proj8
  // collision from deleting another project's active cache; matched by name OR id).
  const pool = managed.filter(
    (s) =>
      !referenced.has(s.name) &&
      !IN_FLIGHT_STATES.has(s.state) &&
      !pinned.has(s.name) &&
      !pinned.has(s.id),
  );

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

  // 2. Retired per-project warm images — reclaim on sight. The baker and the
  //    session-side read path are gone, so none of these can ever be booted
  //    again; they are pure quota debt. Left in `MANAGED_PREFIXES` precisely so
  //    this rule can still see (and free) the historical tips. Tombstones are
  //    skipped: a soft-deleted name no longer counts against the quota.
  for (const s of pool) {
    if (s.name.includes('__deleted')) continue;
    if (!isPpwarmNamespaceName(s.name)) continue;
    claim(s, 'retired per-project warm image');
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
    if (s.name.startsWith(DEFAULT_PREFIX) || isPpwarmNamespaceName(s.name)) continue;
    const t = lastTouch(s);
    if (!Number.isFinite(t)) continue;
    if (now - t > QUOTA_GC_MIN_IDLE_MS) {
      claim(s, `unreferenced + idle ${Math.floor((now - t) / 86_400_000)}d`);
    }
  }

  // 6. BUDGET. Everything above is "provably unneeded". Rule 2 already reclaims
  //    every retired warm image, which used to be the only evictable cache here,
  //    so there is nothing left to trade for headroom: what remains is a live
  //    template or default image that some project boots from. Report the
  //    shortfall instead of evicting something a session needs.
  result.budgetUnresolved = orgTotal - candidates.length - QUOTA_GC_ORG_TARGET > 0;

  result.deferred = Math.max(0, candidates.length - QUOTA_GC_MAX_PER_PASS);
  result.doomed = candidates.slice(0, QUOTA_GC_MAX_PER_PASS);
  return result;
}
