import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STAGES,
  PREFLIGHT_STAGES,
  SPLIT_REGION_SANITY_BUDGET,
  TURN_STAGE_PREFIX,
  WARM_TURN_BUDGET,
  evaluateWarmTurnBudget,
  parseServerTimingTurnMarks,
  resolveWarmTurnBudget,
  type TimelineSummary,
} from '../src/core/latency-budget';

/**
 * `docs/specs/turn-latency.md` §2's budget for a warm session whose state has
 * not changed: pre-flight (auth, load, authorize, fingerprint compare) ≤60ms,
 * the API→box delivery hop ≤60ms, ≤150ms total. The API emits its own stage
 * breakdown as `ProvisionTimeline.summary()` — one mark per
 * `apps/api/src/sandbox-proxy/routes/preview.ts` `ptl.mark(...)` call — and
 * this module is the harness's own judgment of that breakdown against the
 * budget. It must name the exact offending stage, not just say "too slow",
 * because three concurrent branches are changing this same send path and need
 * a verdict they can act on without re-deriving it.
 */

function summary(marks: Array<[string, number, number]>, totalMs?: number): TimelineSummary {
  return {
    kind: 'proxy',
    totalMs: totalMs ?? marks.reduce((sum, [, , deltaMs]) => sum + deltaMs, 0),
    marks: marks.map(([label, atMs, deltaMs]) => ({ label, atMs, deltaMs })),
  };
}

/** A representative warm turn comfortably inside every budget. */
const WARM_TURN = summary([
  ['load-sandbox', 4, 4],
  ['agent-switch', 6, 2],
  ['config-converge', 10, 4],
  ['model-catalog-converge', 12, 2],
  ['ingress', 30, 18],
  ['env-sync', 34, 4],
  ['wire-id-read', 36, 2],
  ['turn-begin', 37, 1],
  ['upstream', 62, 25],
  ['turn-accept', 63, 1],
]);

describe('PREFLIGHT_STAGES / DELIVERY_STAGES', () => {
  it('covers every mark preview.ts emits today, split by the budget’s own two categories', () => {
    // ingress + upstream are the "API -> box delivery hop"; everything else
    // that runs before the body reaches the box is "pre-flight".
    expect(DELIVERY_STAGES).toEqual(['ingress', 'upstream']);
    expect(PREFLIGHT_STAGES).toEqual([
      'load-sandbox',
      'agent-switch',
      'config-converge',
      'model-catalog-converge',
      'env-sync',
      'wire-id-read',
      'turn-begin',
    ]);
  });
});

describe('evaluateWarmTurnBudget', () => {
  it('passes a warm turn comfortably inside every budget', () => {
    const verdict = evaluateWarmTurnBudget(WARM_TURN);
    expect(verdict.pass).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.preflightMs).toBe(19); // 4+2+4+2+4+2+1
    expect(verdict.deliveryMs).toBe(43); // 18+25
    expect(verdict.totalMs).toBe(63);
  });

  it('fails and names the exact stage when one pre-flight stage blows its category budget', () => {
    const slow = summary([
      ['load-sandbox', 4, 4],
      ['agent-switch', 6, 2],
      ['config-converge', 818, 812], // re-resolved the manifest instead of comparing a fingerprint
      ['model-catalog-converge', 820, 2],
      ['ingress', 838, 18],
      ['env-sync', 842, 4],
      ['wire-id-read', 844, 2],
      ['turn-begin', 845, 1],
      ['upstream', 870, 25],
      ['turn-accept', 871, 1],
    ]);
    const verdict = evaluateWarmTurnBudget(slow);
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(2); // preflight category + total
    const preflightViolation = verdict.violations.find((v) => v.category === 'preflight');
    expect(preflightViolation).toBeDefined();
    expect(preflightViolation?.stage).toBe('config-converge');
    expect(preflightViolation?.actualMs).toBe(827); // sum of preflight stages: 4+2+812+2+4+2+1
    expect(preflightViolation?.budgetMs).toBe(WARM_TURN_BUDGET.preflightMs);
    expect(preflightViolation?.overByMs).toBe(827 - WARM_TURN_BUDGET.preflightMs);
    const totalViolation = verdict.violations.find((v) => v.category === 'total');
    expect(totalViolation?.stage).toBe('config-converge');
  });

  it('fails and names the delivery-hop stage independently of pre-flight', () => {
    const slow = summary([
      ['load-sandbox', 4, 4],
      ['agent-switch', 6, 2],
      ['config-converge', 10, 4],
      ['model-catalog-converge', 12, 2],
      ['ingress', 30, 18],
      ['env-sync', 34, 4],
      ['wire-id-read', 36, 2],
      ['turn-begin', 37, 1],
      ['upstream', 437, 400], // the box hop itself, not pre-flight
      ['turn-accept', 438, 1],
    ]);
    const verdict = evaluateWarmTurnBudget(slow);
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(2);
    const deliveryViolation = verdict.violations.find((v) => v.category === 'delivery');
    expect(deliveryViolation?.stage).toBe('upstream');
    expect(deliveryViolation?.actualMs).toBe(418);
    expect(deliveryViolation?.overByMs).toBe(418 - WARM_TURN_BUDGET.deliveryMs);
  });

  it('still counts an unrecognized stage toward the total and flags it by name instead of dropping it', () => {
    const withNewStage = summary([
      ['load-sandbox', 4, 4],
      ['agent-switch', 6, 2],
      ['config-converge', 10, 4],
      ['model-catalog-converge', 12, 2],
      ['a-new-stage-added-by-a-concurrent-branch', 212, 200],
      ['ingress', 230, 18],
      ['env-sync', 234, 4],
      ['wire-id-read', 236, 2],
      ['turn-begin', 237, 1],
      ['upstream', 262, 25],
      ['turn-accept', 263, 1],
    ]);
    const verdict = evaluateWarmTurnBudget(withNewStage);
    expect(verdict.unrecognizedStages).toEqual(['a-new-stage-added-by-a-concurrent-branch']);
    expect(verdict.totalMs).toBe(263);
    expect(verdict.pass).toBe(false);
    const totalViolation = verdict.violations.find((v) => v.category === 'total');
    expect(totalViolation?.stage).toBe('a-new-stage-added-by-a-concurrent-branch');
  });

  it('fails on total even when every category individually fits, if the sum still exceeds 150ms', () => {
    // Every named stage stays under its category budget individually, but
    // turn-accept bookkeeping (not in either category) pushes the grand total over.
    const grandTotalOnly = summary([
      ['load-sandbox', 10, 10],
      ['agent-switch', 15, 5],
      ['config-converge', 25, 10],
      ['model-catalog-converge', 30, 5],
      ['ingress', 60, 30],
      ['env-sync', 65, 5],
      ['wire-id-read', 70, 5],
      ['turn-begin', 72, 2],
      ['upstream', 102, 30],
      ['turn-accept', 160, 58], // itself over budget alone
    ]);
    const verdict = evaluateWarmTurnBudget(grandTotalOnly);
    expect(verdict.preflightMs).toBe(42); // <=60
    expect(verdict.deliveryMs).toBe(60); // <=60 (boundary, not over)
    expect(verdict.totalMs).toBe(160);
    expect(verdict.pass).toBe(false);
    const totalViolation = verdict.violations.find((v) => v.category === 'total');
    expect(totalViolation).toBeDefined();
    expect(totalViolation?.stage).toBe('turn-accept');
  });

  it('accepts a custom budget', () => {
    const strict = { preflightMs: 1, deliveryMs: 1, totalMs: 2 };
    expect(evaluateWarmTurnBudget(WARM_TURN, strict).pass).toBe(false);
  });
});

describe('parseServerTimingTurnMarks', () => {
  /**
   * The API rides its turn-path breakdown on the SAME `Server-Timing` header
   * every request already carries (`apps/api/src/lib/server-timing.ts`,
   * `apps/api/src/middleware/upstream-timing.ts`), not a second custom
   * header — see that module's doc. Each turn stage is namespaced
   * `turnstage-<label>` so this parser recognizes every mark BY PREFIX,
   * robust to a concurrent branch renaming or adding a `ptl.mark(...)` call
   * without this harness needing an edit to notice it.
   */
  it('extracts only the turnstage-* entries, strips the prefix, and reconstructs atMs', () => {
    const header =
      'total;dur=63, auth;dur=2;desc="n=1", db;dur=5;desc="n=3", api;dur=10, ' +
      'turnstage-load-sandbox;dur=4, turnstage-agent-switch;dur=2, turnstage-turn-accept;dur=1';
    expect(parseServerTimingTurnMarks(header)).toEqual({
      totalMs: 7,
      marks: [
        { label: 'load-sandbox', atMs: 4, deltaMs: 4 },
        { label: 'agent-switch', atMs: 6, deltaMs: 2 },
        { label: 'turn-accept', atMs: 7, deltaMs: 1 },
      ],
    });
  });

  it('returns null when the header carries no turn stage marks at all', () => {
    expect(parseServerTimingTurnMarks('total;dur=12, api;dur=12')).toBeNull();
  });

  it('returns null for a missing header instead of throwing', () => {
    expect(parseServerTimingTurnMarks(null)).toBeNull();
    expect(parseServerTimingTurnMarks(undefined)).toBeNull();
    expect(parseServerTimingTurnMarks('')).toBeNull();
  });

  it('ignores a malformed turnstage entry instead of throwing', () => {
    // 'turnstage-broken' with no `;dur=` is simply skipped, the rest still parse.
    expect(
      parseServerTimingTurnMarks('turnstage-broken, turnstage-ingress;dur=18'),
    ).toEqual({
      totalMs: 18,
      marks: [{ label: 'ingress', atMs: 18, deltaMs: 18 }],
    });
  });

  it('names the prefix the API and the harness both agree on', () => {
    expect(TURN_STAGE_PREFIX).toBe('turnstage-');
  });
});

/**
 * `docs/specs/turn-latency.md` §2's 150ms budget is a colocated bar (prod:
 * API and database in the same AWS region). Measured server-side via
 * `Server-Timing` on dev (API us-west-2, database us-east-2): the SAME
 * `/accounts/me` query costs 24ms colocated in prod vs 2084ms split in dev —
 * 45-85x, purely from ~7-11 cross-continent round trips at ~100-250ms each.
 * Applying the 150ms bar to a deliberately split deployment fails on
 * geography, not on the code path, so a split target gets a much looser
 * sanity bound instead — and the harness must say OUT LOUD which one it
 * applied and why, never silently swap budgets.
 */
describe('resolveWarmTurnBudget (region-aware)', () => {
  it('applies the strict colocated budget when the two regions match', () => {
    const resolved = resolveWarmTurnBudget({ apiRegion: 'eu-west-2', databaseRegion: 'eu-west-2' });
    expect(resolved.colocated).toBe(true);
    expect(resolved.budget).toBe(WARM_TURN_BUDGET);
  });

  it('applies the looser sanity bound when the two regions differ, and says so', () => {
    const resolved = resolveWarmTurnBudget({ apiRegion: 'us-west-2', databaseRegion: 'us-east-2' });
    expect(resolved.colocated).toBe(false);
    expect(resolved.budget).toBe(SPLIT_REGION_SANITY_BUDGET);
    expect(resolved.budget.totalMs).toBeGreaterThan(WARM_TURN_BUDGET.totalMs);
  });

  it('defaults to the strict budget — never the loose one — when a region is unknown', () => {
    const bothUnknown = resolveWarmTurnBudget({ apiRegion: null, databaseRegion: null });
    expect(bothUnknown.colocated).toBeNull();
    expect(bothUnknown.budget).toBe(WARM_TURN_BUDGET);

    const oneUnknown = resolveWarmTurnBudget({ apiRegion: 'us-west-2', databaseRegion: null });
    expect(oneUnknown.colocated).toBeNull();
    expect(oneUnknown.budget).toBe(WARM_TURN_BUDGET);
  });
});
