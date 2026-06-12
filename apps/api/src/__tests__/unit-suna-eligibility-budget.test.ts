/**
 * Regression coverage for the `/projects/suna-migration/eligibility` GET's
 * whole-handler wall-clock budget.
 *
 * Incident: the frontend (Kortix Frontend, prod) reported
 *   "ApiError — Request timed out after 30s: /projects/suna-migration/eligibility"
 * (Better Stack error a60262aa384c136ac6fcca845cabe89756ed46b9c12c26ab1adfb6fc7217ef04).
 *
 * The frontend client (apps/web/src/lib/api-client.ts) explicitly distinguishes
 * a genuine timeout (its 30s timer fired) from an external abort, so this was a
 * real server-side hang — the handler took >30s to answer. The eligibility
 * handler awaits two UNBOUNDED DB ops: `latestSunaMigration` and, the likely
 * culprit, `countSunaProjects`, an un-LIMITed `count(*)` over the legacy
 * `public.projects` table (the OG Suna dataset, which can be large). It is polled
 * frequently by the Migrate button / suna-migration banner
 * (apps/web/src/hooks/legacy/use-suna-migration.ts: staleTime 15s, plus 2.5s
 * polling while a migration is in flight), so a slow/contended DB let the request
 * hang to the client's 30s abort and re-fire the same error.
 *
 * The fix wraps the ENTIRE handler body in one budget
 * (`SUNA_ELIGIBILITY_BUDGET_MS`) and degrades to a safe "not eligible" payload
 * (`SUNA_ELIGIBILITY_DEGRADED`) on timeout. These tests pin that contract:
 *   1. the budget stays comfortably under the 30s client timeout, and
 *   2. a never-settling DB degrades promptly to the safe payload rather than
 *      hanging — the exact failure mode that paged us.
 *
 * Mirrors unit-sandbox-health-budget.test.ts (the same fix shipped for
 * /projects/:id/sandbox-health). Re-declared hermetically rather than importing
 * the route module, which pulls in @hono/zod-openapi + validates server env at
 * load time. If the route's values change, update these and the assertions keep
 * the contract honest.
 */

import { describe, expect, test } from 'bun:test';
import { TimeoutError, withTimeout } from '../shared/with-timeout';

interface SunaEligibilityPayload {
  eligible: boolean;
  migration: unknown;
}

// Kept in sync with
// apps/api/src/projects/suna-migration/suna-migration-routes.ts.
const SUNA_ELIGIBILITY_BUDGET_MS = 12_000;
const SUNA_ELIGIBILITY_DEGRADED: SunaEligibilityPayload = {
  eligible: false,
  migration: null,
};

// The frontend client timeout that produced the reported error
// (apps/web/src/lib/api-client.ts → `timeout = 30000`).
const FRONTEND_REQUEST_TIMEOUT_MS = 30_000;

const never = <T>() => new Promise<T>(() => {});

/**
 * Mirrors the handler's protection: bound the body and fall back to the safe
 * degraded payload on timeout/failure instead of propagating the hang.
 */
async function eligibilityWithBudget(
  body: Promise<SunaEligibilityPayload>,
  budgetMs = SUNA_ELIGIBILITY_BUDGET_MS,
): Promise<SunaEligibilityPayload> {
  try {
    return await withTimeout(body, budgetMs, 'suna-migration eligibility');
  } catch {
    return SUNA_ELIGIBILITY_DEGRADED;
  }
}

describe('suna-migration eligibility budget', () => {
  test('the budget stays comfortably under the frontend 30s client timeout', () => {
    // If this ever creeps up to/over the client timeout the guard is useless:
    // the request would still abort client-side first and re-fire the error.
    expect(SUNA_ELIGIBILITY_BUDGET_MS).toBeLessThan(FRONTEND_REQUEST_TIMEOUT_MS);
    // ...with real headroom (network + serialization) — not a hair under.
    expect(SUNA_ELIGIBILITY_BUDGET_MS).toBeLessThanOrEqual(
      FRONTEND_REQUEST_TIMEOUT_MS / 2,
    );
  });

  test('a never-settling DB query degrades promptly instead of hanging', async () => {
    // This is the incident: a hung DB op inside the handler body (the
    // un-LIMITed count(*) over legacy public.projects, or latestSunaMigration).
    // With the budget it must resolve to the safe payload well before the
    // client's 30s abort — not pend forever.
    const start = Date.now();
    const result = await eligibilityWithBudget(never<SunaEligibilityPayload>(), 20);
    const elapsed = Date.now() - start;

    expect(result).toEqual(SUNA_ELIGIBILITY_DEGRADED);
    expect(elapsed).toBeLessThan(1_000); // nowhere near a real request timeout
  });

  test('a healthy body within budget passes through unchanged', async () => {
    const healthy: SunaEligibilityPayload = {
      eligible: true,
      migration: { migration_id: 'm1', status: 'failed' },
    };
    await expect(eligibilityWithBudget(Promise.resolve(healthy))).resolves.toEqual(
      healthy,
    );
  });

  test('a rejecting DB query also degrades to the safe payload', async () => {
    await expect(
      eligibilityWithBudget(Promise.reject(new Error('db down'))),
    ).resolves.toEqual(SUNA_ELIGIBILITY_DEGRADED);
  });

  test('the timeout surfaces as a TimeoutError before the fallback swallows it', async () => {
    // Guards that we degrade on the wall-clock guard specifically, so the budget
    // label shows up in logs/telemetry rather than a silent hang.
    await expect(
      withTimeout(never<string>(), 20, 'suna-migration eligibility'),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  test('the degraded payload hides the Migrate button (eligible=false, no migration)', () => {
    // The whole point of degrading rather than erroring: the button just doesn't
    // show and the next poll re-checks once the DB recovers.
    expect(SUNA_ELIGIBILITY_DEGRADED.eligible).toBe(false);
    expect(SUNA_ELIGIBILITY_DEGRADED.migration).toBeNull();
  });
});
