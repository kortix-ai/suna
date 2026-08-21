import {
  PPWARM_PREFIX,
  SCOPED_PPWARM_PREFIX,
  parseExactPpwarmImageName as parsePpwarmName,
  type ParsedPpwarmName,
} from './ppwarm-names';

export { PPWARM_PREFIX, SCOPED_PPWARM_PREFIX };

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
 * databases. Scoped ppwarm names carry the owning database's 12-hex key, so this
 * selector can reject foreign scoped names before every deletion rule. Legacy
 * and unscoped names have no ownership key. For those names, `lastUsedAt` remains
 * the only cross-environment liveness signal.
 *
 * ── Why ppwarm needs an LRU budget, not just a liveness rule ────────────────
 * `kortix-ppwarm-<proj8>-<hash>` is minted unconditionally on session-start of the
 * shared default (builder.ts), one live tip per project. So the cache's floor is the
 * number of projects that have ever started a session. Measured 2026-07-08: 69 tips
 * for 69 distinct, non-archived projects — 69 of the org's 100 slots, before a single
 * default or user template. Liveness rules reclaim NOTHING there (every tip is a live
 * project's only tip), so a purely liveness-based GC sits at 100% pressure doing
 * nothing, which is exactly the outage we hit.
 *
 * ppwarm is a pure CACHE — evicting a tip costs one cold boot plus a re-bake, never
 * data — so it is the namespace that absorbs budget pressure. Evict LRU until the org
 * is back at target, skipping recently-used tips (they'd re-bake at once: churn, not
 * reclamation). When even that can't reach target, `budgetUnresolved` is set so the
 * caller can alarm — a GC that silently can't keep up is how this failed the first
 * time. The real remedy at that point is capacity (raise the org snapshot quota) or
 * gating the warm bake; GC can only buy time.
 *
 * ── Template scoping (ppwarm-names.ts FORMAT MIGRATION) ─────────────────────
 * `kortix-ppwarm-` supports legacy `(project8, hash12)` and unscoped
 * `(project8, template8, hash12)` names. `kpp2-` supports scoped
 * `(database12, project12, template16, hash16)` names. Rule 2 groups by the
 * complete ownership tuple for that format. A scoped template can therefore
 * never supersede a different template or a different database's image. Legacy
 * and unscoped names keep their previous grouping, idle, and LRU behavior.
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

/**
 * A ppwarm tip unused this long is reclaimed even though we can't see whose project
 * it is. Cross-env safe: any environment still booting from it keeps lastUsedAt fresh.
 */
export const QUOTA_GC_PPWARM_MAX_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Under budget pressure, ppwarm tips are evicted LRU — but never one used this
 * recently. An actively-used project would simply re-bake on its next session, so
 * evicting it is churn (a slot freed and immediately reclaimed), not reclamation.
 */
export const QUOTA_GC_PPWARM_EVICT_PROTECT_MS = 6 * 60 * 60 * 1000;

/**
 * A "superseded" ppwarm tip created/used this recently is likely another live
 * runtime's CURRENT tip (mixed code versions → mixed base identities). Mirrors
 * PPWARM_REAP_PROTECT_MS in ppwarm-names.ts. This selector keeps the threshold
 * as an explicit policy constant.
 */
export const QUOTA_GC_PPWARM_FRESH_PROTECT_MS = 45 * 60 * 1000;

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
  /**
   * False when the IO layer could not load the complete active-pin set. Every
   * ppwarm image is then excluded from this pass. Non-ppwarm namespaces retain
   * their independent reference and freshness protections.
   */
  ppwarmPinProtectionAvailable?: boolean;
  /**
   * Exact 12-hex data-plane scope this database owns. Scoped ppwarm images from
   * every other scope are excluded from all deletion rules. When absent, every
   * scoped ppwarm image is excluded.
   */
  ownedPpwarmDataPlaneScope?: string;
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
   * True when, even after evicting every eligible ppwarm tip, the org still can't
   * reach QUOTA_GC_ORG_TARGET. The cache floor (one tip per active project) has
   * outgrown the quota: GC cannot fix this, only capacity or a warm-bake gate can.
   * Callers MUST surface this rather than log a quiet no-op.
   */
  budgetUnresolved: boolean;
}

export function isManaged(name: string): boolean {
  return MANAGED_PREFIXES.some((p) => name.startsWith(p));
}

/** Project scope key: 8 hex for legacy/unscoped names, 12 hex for scoped names. */
export function ppwarmProj8(name: string): string | null {
  return parsePpwarmName(name)?.projectKey ?? null;
}

/**
 * Template scope key: null for legacy names, 8 hex for unscoped names, and
 * 16 hex for data-plane-scoped names.
 */
export function ppwarmTpl8(name: string): string | null {
  return parsePpwarmName(name)?.templateKey ?? null;
}

function ppwarmGroupKey(parsed: ParsedPpwarmName): string {
  if (parsed.format === 'scoped') {
    return `scoped|${parsed.dataPlaneScope}|${parsed.projectKey}|${parsed.templateKey}`;
  }
  if (parsed.format === 'unscoped') {
    return `unscoped|${parsed.projectKey}|${parsed.templateKey}`;
  }
  return `legacy|${parsed.projectKey}`;
}

function isPpwarmNamespaceName(name: string): boolean {
  return name.startsWith(PPWARM_PREFIX) || name.startsWith(SCOPED_PPWARM_PREFIX);
}

function isOwnedPpwarm(name: string, ownedDataPlaneScope: string | undefined): boolean {
  if (!isPpwarmNamespaceName(name)) return true;
  const parsed = parsePpwarmName(name);
  if (!parsed) return false;
  return parsed.format !== 'scoped' || parsed.dataPlaneScope === ownedDataPlaneScope;
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
  const ppwarmPinProtectionAvailable = input.ppwarmPinProtectionAvailable ?? true;

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
      !pinned.has(s.id) &&
      (ppwarmPinProtectionAvailable || !isPpwarmNamespaceName(s.name)) &&
      isOwnedPpwarm(s.name, input.ownedPpwarmDataPlaneScope),
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

  // 2. Superseded ppwarm tips: exactly one tip per ownership tuple is live.
  //    Legacy names group by project8. Unscoped names group by
  //    (project8, template8). Scoped names group by
  //    (database12, project12, template16).
  const byScope = new Map<string, SnapshotLike[]>();
  for (const s of pool) {
    if (s.name.includes('__deleted')) continue; // soft-delete tombstone; not quota-counting
    const parsed = parsePpwarmName(s.name);
    if (!parsed) continue;
    const scopeKey = ppwarmGroupKey(parsed);
    const group = byScope.get(scopeKey);
    if (group) group.push(s);
    else byScope.set(scopeKey, [s]);
  }
  for (const group of byScope.values()) {
    if (group.length < 2) continue;
    const [, ...superseded] = [...group].sort(byFreshestFirst);
    for (const s of superseded) {
      // A "superseded" tip that was created/used minutes ago is very likely
      // another live runtime's CURRENT tip (two code versions → two base
      // identities → two live warm names for the same project). Deleting it
      // triggers an immediate full re-bake — churn, not reclamation. See
      // PPWARM_REAP_PROTECT_MS (ppwarm-names.ts) for the incident writeup.
      const t = lastTouch(s);
      if (Number.isFinite(t) && now - t < QUOTA_GC_PPWARM_FRESH_PROTECT_MS) continue;
      const parsed = parsePpwarmName(s.name)!;
      claim(
        s,
        `superseded ppwarm tip for project ${parsed.projectKey}` +
          (parsed.templateKey ? ` (template ${parsed.templateKey})` : ''),
      );
    }
  }

  // 3. ppwarm tips nobody has booted in a long time. We cannot see other envs' DBs,
  //    so idle time is the only safe liveness proof. Purely a cache — a wrongly
  //    reaped tip re-bakes on the project's next background sync.
  for (const s of pool) {
    const t = lastTouch(s);
    if (!parsePpwarmName(s.name)) continue;
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
    if (s.name.startsWith(DEFAULT_PREFIX) || parsePpwarmName(s.name)) continue;
    const t = lastTouch(s);
    if (!Number.isFinite(t)) continue;
    if (now - t > QUOTA_GC_MIN_IDLE_MS) {
      claim(s, `unreferenced + idle ${Math.floor((now - t) / 86_400_000)}d`);
    }
  }

  // 6. BUDGET. Everything above is "provably unneeded". If the org is still over
  //    target after all of it, the shortfall is live cache: one ppwarm tip per active
  //    project, which no liveness rule can touch (see the header). ppwarm is a pure
  //    cache, so it is what gives. Evict LRU until we reach target, skipping tips used
  //    recently enough that they'd just re-bake.
  const stillOver = () => orgTotal - candidates.length - QUOTA_GC_ORG_TARGET;
  if (stillOver() > 0) {
    const evictable = pool
      .filter((s) => parsePpwarmName(s.name) && !claimed.has(s.id))
      .filter((s) => {
        const t = lastTouch(s);
        return Number.isFinite(t) && now - t > QUOTA_GC_PPWARM_EVICT_PROTECT_MS;
      })
      .sort((a, b) => lastTouch(a) - lastTouch(b)); // least-recently-used first

    for (const s of evictable) {
      if (stillOver() <= 0) break;
      claim(
        s,
        `ppwarm LRU eviction (idle ${Math.floor((now - lastTouch(s)) / 3_600_000)}h, over budget)`,
      );
    }
    // Exhausted every evictable tip and still over: the cache floor beats the quota.
    result.budgetUnresolved = stillOver() > 0;
  }

  result.deferred = Math.max(0, candidates.length - QUOTA_GC_MAX_PER_PASS);
  result.doomed = candidates.slice(0, QUOTA_GC_MAX_PER_PASS);
  return result;
}
