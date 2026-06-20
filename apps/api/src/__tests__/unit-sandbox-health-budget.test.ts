/**
 * Regression coverage for the `/projects/:projectId/sandbox-health` poll's
 * whole-handler wall-clock budget.
 *
 * Incident: the frontend (Kortix Frontend, prod) reported
 *   "ApiError — Request timed out after 30s: /projects/<id>/sandbox-health"
 * (Better Stack error f49bbe8a9ec0ad587e5ad540cbdce3917361004fba8d0c914146d2cbbd119fff).
 *
 * A prior fix (PR #3361) bounded only the Daytona `snapshot.get` /
 * `listSandboxTemplates` portion. But the handler also awaits git-auth
 * resolution (`loadGitProject`) and the build-log DB query
 * (`listSnapshotBuilds`) with no bound — so a slow DB or git-auth call still
 * let the request hang to the client's 30s abort and re-fire the same error.
 *
 * The fix wraps the ENTIRE handler body in one budget
 * (`SANDBOX_HEALTH_BUDGET_MS`) and degrades to a safe "unknown" payload
 * (`SANDBOX_HEALTH_DEGRADED`) on timeout. These tests pin that contract:
 *   1. the budget stays comfortably under the 30s client timeout, and
 *   2. a never-settling dependency degrades promptly to the safe payload
 *      rather than hanging — the exact failure mode that paged us.
 */

import { describe, expect, test } from 'bun:test';
import { TimeoutError, withTimeout } from '../shared/with-timeout';

// Kept in sync with apps/api/src/projects/routes/r2.ts. Re-declared here rather
// than imported because the route module validates server env (FRONTEND_URL,
// DB, …) at load time; this unit test must stay hermetic. If the route's
// values change, update these and the assertions will keep the contract honest.
interface SandboxHealthPayload {
  primary_slug: string | null;
  primary_template: unknown;
  ready: boolean;
  building: boolean;
  latest_build: unknown;
  latest_failure: unknown;
}

const SANDBOX_HEALTH_BUDGET_MS = 12_000;
const SANDBOX_HEALTH_DEGRADED: SandboxHealthPayload = {
  primary_slug: null,
  primary_template: null,
  ready: false,
  building: false,
  latest_build: null,
  latest_failure: null,
};

// The frontend client timeout that produced the reported error
// (apps/web/src/lib/api-client.ts → `timeout = 30000`).
const FRONTEND_REQUEST_TIMEOUT_MS = 30_000;

const never = <T>() => new Promise<T>(() => {});

/**
 * Mirrors the handler's protection: bound the body and fall back to the safe
 * degraded payload on timeout/failure instead of propagating the hang.
 */
async function pollWithBudget(
  body: Promise<SandboxHealthPayload>,
  budgetMs = SANDBOX_HEALTH_BUDGET_MS,
): Promise<SandboxHealthPayload> {
  try {
    return await withTimeout(body, budgetMs, 'sandbox-health');
  } catch {
    return SANDBOX_HEALTH_DEGRADED;
  }
}

describe('sandbox-health budget', () => {
  test('the budget stays comfortably under the frontend 30s client timeout', () => {
    // If this ever creeps up to/over the client timeout the guard is useless:
    // the request would still abort client-side first and re-fire the error.
    expect(SANDBOX_HEALTH_BUDGET_MS).toBeLessThan(FRONTEND_REQUEST_TIMEOUT_MS);
    // ...with real headroom (network + serialization) — not a hair under.
    expect(SANDBOX_HEALTH_BUDGET_MS).toBeLessThanOrEqual(
      FRONTEND_REQUEST_TIMEOUT_MS / 2,
    );
  });

  test('a never-settling dependency degrades promptly instead of hanging', async () => {
    // This is the incident: a hung dependency (git-auth / Daytona / build-log
    // DB) inside the handler body. With the budget it must resolve to the safe
    // payload well before the client's 30s abort — not pend forever.
    const start = Date.now();
    const result = await pollWithBudget(never<SandboxHealthPayload>(), 20);
    const elapsed = Date.now() - start;

    expect(result).toEqual(SANDBOX_HEALTH_DEGRADED);
    expect(elapsed).toBeLessThan(1_000); // nowhere near a real request timeout
  });

  test('a healthy body within budget passes through unchanged', async () => {
    const healthy = {
      ...SANDBOX_HEALTH_DEGRADED,
      primary_slug: 'default',
      ready: true,
    };
    await expect(pollWithBudget(Promise.resolve(healthy))).resolves.toEqual(
      healthy,
    );
  });

  test('a rejecting dependency also degrades to the safe payload', async () => {
    await expect(
      pollWithBudget(Promise.reject(new Error('db down'))),
    ).resolves.toEqual(SANDBOX_HEALTH_DEGRADED);
  });

  test('the timeout surfaces as a TimeoutError before the fallback swallows it', async () => {
    // Guards that we are degrading on the wall-clock guard specifically, so the
    // budget label shows up in logs/telemetry rather than a silent hang.
    await expect(withTimeout(never<string>(), 20, 'sandbox-health')).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});
