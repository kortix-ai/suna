/**
 * Judgment logic for the turn-latency spec (PR #7840) §2's warm-turn budget.
 *
 * The API records one `TimelineMark` per stage of the send path
 * (`apps/api/src/platform/services/provision-timeline.ts`,
 * `ptl.mark(...)` in `apps/api/src/sandbox-proxy/routes/preview.ts`) and,
 * when the caller opts in with `X-Kortix-Debug-Timeline: 1`, serializes the
 * summary onto the response as `X-Kortix-Provision-Timeline` (JSON). This
 * module is pure: it takes that summary and returns a verdict, with the
 * SPECIFIC stage that blew a budget named, not just "too slow" — three
 * concurrent branches are actively changing these stage names (see
 * `PREFLIGHT_STAGES`/`DELIVERY_STAGES`), so an unrecognized stage is counted
 * toward the total and reported by name rather than silently dropped.
 *
 * No network, no clock reads — everything here is a function of the marks
 * array, so it is fully unit-testable (`tests/unit/latency-budget.test.ts`).
 */

export interface TimelineMark {
  label: string;
  /** ms since the timeline started. */
  atMs: number;
  /** ms since the previous mark — the cost of the step that just finished. */
  deltaMs: number;
}

export interface TimelineSummary {
  id?: string;
  kind?: string;
  totalMs: number;
  marks: TimelineMark[];
}

/**
 * The turn-path breakdown rides the API's existing `Server-Timing` header
 * (`apps/api/src/lib/server-timing.ts`'s `recordTurnStageMarks`, rendered by
 * `apps/api/src/middleware/upstream-timing.ts`) — the same mechanism
 * `total`/`auth`/`db`/`git`/`http`/`up`/`api` already use — not a second,
 * custom header. Each turn stage is namespaced with this prefix so a mark is
 * recognized by PREFIX alone, robust to a concurrent branch renaming or
 * adding a `ptl.mark(...)` call in `preview.ts` without this file changing.
 */
export const TURN_STAGE_PREFIX = 'turnstage-';

/**
 * §2: "Pre-flight (auth, load, authorize, fingerprint compare) — ≤60ms".
 * Every mark `preview.ts` emits before it resolves the box's ingress URL —
 * i.e. everything that is not the API -> box hop itself.
 */
export const PREFLIGHT_STAGES = [
  'load-sandbox',
  'agent-switch',
  'config-converge',
  'model-catalog-converge',
  'env-sync',
  'wire-id-read',
  'turn-begin',
] as const;

/** §2: "API -> box delivery hop — ≤60ms". Resolving ingress and the upstream fetch. */
export const DELIVERY_STAGES = ['ingress', 'upstream'] as const;

interface StageBudget {
  preflightMs: number;
  deliveryMs: number;
  totalMs: number;
}

/** The turn-latency spec (PR #7840) §2, the warm-session-unchanged-state row. This
 * is a COLOCATED bar: it assumes the API and its database share a region. */
export const WARM_TURN_BUDGET: StageBudget = {
  preflightMs: 60,
  deliveryMs: 60,
  totalMs: 150,
};

/**
 * A much looser sanity bound for a target whose API and database are in
 * DIFFERENT AWS regions (dev: API us-west-2, database us-east-2, per
 * deployment topology). Measured server-side via
 * `Server-Timing` on dev: the SAME `/accounts/me` query that costs 24ms
 * colocated in prod costs 2084ms split in dev — 45-85x, purely from ~7-11
 * cross-continent round trips at ~100-250ms each, none of it the code path.
 * §2's 150ms bar is meaningless against that geography, so a split target is
 * held to this instead — a hang/regression guard, NOT a validated
 * performance target. `resolveWarmTurnBudget` picks between the two and
 * reports which one and why; nothing here swaps budgets silently.
 */
export const SPLIT_REGION_SANITY_BUDGET: StageBudget = {
  preflightMs: 1200,
  deliveryMs: 1200,
  totalMs: 3000,
};

export interface RegionTopology {
  apiRegion: string | null;
  databaseRegion: string | null;
}

interface ResolvedBudget {
  /** true = same region, false = different regions, null = at least one is unknown. */
  colocated: boolean | null;
  budget: StageBudget;
}

/**
 * Choose the budget for this target's topology. Unknown topology (a region
 * could not be read — an older or self-hosted API, or a network hiccup on the
 * `/health` read) defaults to the STRICT budget, never the loose one: "do not
 * silently pass a split deployment" applies equally to an UNDETERMINED one —
 * an unproven colocated claim must fail loud, not quietly get the easy bar.
 */
export function resolveWarmTurnBudget(topology: RegionTopology): ResolvedBudget {
  if (!topology.apiRegion || !topology.databaseRegion) {
    return { colocated: null, budget: WARM_TURN_BUDGET };
  }
  const colocated = topology.apiRegion === topology.databaseRegion;
  return { colocated, budget: colocated ? WARM_TURN_BUDGET : SPLIT_REGION_SANITY_BUDGET };
}

type BudgetCategory = 'preflight' | 'delivery' | 'total';

interface BudgetViolation {
  category: BudgetCategory;
  /** The single stage responsible for the largest share of the overage. */
  stage: string;
  actualMs: number;
  budgetMs: number;
  overByMs: number;
}

interface BudgetVerdict {
  pass: boolean;
  preflightMs: number;
  deliveryMs: number;
  totalMs: number;
  /** Marks whose label is in neither PREFLIGHT_STAGES nor DELIVERY_STAGES. */
  unrecognizedStages: string[];
  violations: BudgetViolation[];
}

function sumOf(marks: TimelineMark[], labels: readonly string[]): number {
  const wanted = new Set<string>(labels);
  return marks.filter((m) => wanted.has(m.label)).reduce((sum, m) => sum + m.deltaMs, 0);
}

/** The mark with the largest delta among `labels`, or the largest overall if none match. */
function biggestContributor(marks: TimelineMark[], labels: readonly string[]): TimelineMark | undefined {
  const wanted = new Set<string>(labels);
  const candidates = marks.filter((m) => wanted.has(m.label));
  const pool = candidates.length > 0 ? candidates : marks;
  return pool.reduce<TimelineMark | undefined>(
    (biggest, m) => (!biggest || m.deltaMs > biggest.deltaMs ? m : biggest),
    undefined,
  );
}

/**
 * Evaluate one turn's ProvisionTimeline summary against the warm-turn budget.
 *
 * A category (preflight/delivery) failing is reported once, naming its single
 * biggest-delta stage. The grand total is checked independently — it can fail
 * even when both categories individually fit (e.g. `turn-accept` bookkeeping,
 * or a stage neither category recognizes, pushes the sum over 150ms) — and in
 * that case it names the single biggest-delta stage across ALL marks.
 */
export function evaluateWarmTurnBudget(
  summary: TimelineSummary,
  budget: StageBudget = WARM_TURN_BUDGET,
): BudgetVerdict {
  const marks = summary.marks;
  const known = new Set<string>([...PREFLIGHT_STAGES, ...DELIVERY_STAGES]);
  const unrecognizedStages = marks
    .map((m) => m.label)
    .filter((label) => !known.has(label) && label !== 'turn-accept');

  const preflightMs = sumOf(marks, PREFLIGHT_STAGES);
  const deliveryMs = sumOf(marks, DELIVERY_STAGES);
  const totalMs = summary.totalMs;

  const violations: BudgetViolation[] = [];

  /** One violation row: the category's worst single stage, named. */
  const pushViolation = (
    category: BudgetCategory,
    actualMs: number,
    budgetMs: number,
    worst: TimelineMark | undefined,
  ): void => {
    violations.push({
      category,
      stage: worst?.label ?? 'unknown',
      actualMs,
      budgetMs,
      overByMs: actualMs - budgetMs,
    });
  };

  if (preflightMs > budget.preflightMs) {
    pushViolation('preflight', preflightMs, budget.preflightMs, biggestContributor(marks, PREFLIGHT_STAGES));
  }

  if (deliveryMs > budget.deliveryMs) {
    pushViolation('delivery', deliveryMs, budget.deliveryMs, biggestContributor(marks, DELIVERY_STAGES));
  }

  if (totalMs > budget.totalMs) {
    // Name the single biggest-delta mark across the WHOLE timeline — this is
    // the stage most responsible for the grand total blowing its budget, even
    // when it belongs to neither named category (e.g. turn-accept bookkeeping,
    // or a stage a concurrent branch just added).
    pushViolation('total', totalMs, budget.totalMs, biggestContributor(marks, []));
  }

  return {
    pass: violations.length === 0,
    preflightMs,
    deliveryMs,
    totalMs,
    unrecognizedStages,
    violations,
  };
}

/**
 * A single `Server-Timing` entry: `name;dur=123` or `name;dur=123;desc="..."`.
 * Matches the exact grammar `apps/api/src/lib/server-timing.ts` emits.
 */
const SERVER_TIMING_ENTRY = /^\s*([\w-]+);dur=([\d.]+)/;

/**
 * Extract the turn-path breakdown from a `Server-Timing` response header,
 * reading only the `turnstage-*` entries and ignoring every other stage
 * (`total`, `auth`, `db`, `up`, `api`, ...) — those belong to the REST
 * request-timing contract, not the turn's own send-path breakdown. Returns
 * null (never throws) when the header is missing or carries no turn stage
 * marks at all — a self-hosted or older API that has not shipped the marks
 * yet must degrade to "pre-flight breakdown unavailable", not crash the
 * benchmark. `atMs` is reconstructed as the running cumulative sum, in the
 * order the entries appear — the same order `preview.ts` calls `ptl.mark()`.
 */
export function parseServerTimingTurnMarks(value: string | null | undefined): TimelineSummary | null {
  if (!value) return null;
  const marks: TimelineMark[] = [];
  let atMs = 0;
  for (const rawEntry of value.split(',')) {
    const label = rawEntry.trim();
    if (!label.startsWith(TURN_STAGE_PREFIX)) continue;
    const match = SERVER_TIMING_ENTRY.exec(label);
    if (!match) continue; // malformed entry (e.g. no `;dur=`) — skip, don't throw
    const deltaMs = Number(match[2]);
    if (!Number.isFinite(deltaMs)) continue;
    atMs += deltaMs;
    marks.push({ label: match[1]!.slice(TURN_STAGE_PREFIX.length), atMs, deltaMs });
  }
  if (marks.length === 0) return null;
  return { totalMs: atMs, marks };
}
