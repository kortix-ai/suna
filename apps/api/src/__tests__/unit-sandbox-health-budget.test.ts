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
import { ttlMemo } from '../shared/ttl-memo';

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

/**
 * Poll caching (perf, 2026-08-26).
 *
 * `buildSandboxHealth` is not a database read: `listSandboxTemplates` calls
 * `provider.getSnapshotState()` — a LIVE round trip to Daytona / E2B /
 * Platinum — once per template, plus a git read to hash the template
 * directory. On the Essentia corpus that made this "cheap polling endpoint"
 * the slowest non-proxy read on the box: 559 ms mean server-side over 169
 * calls, 1 488 ms median as the browser saw it.
 *
 * The route now serves it through `ttlMemo` keyed by project. These tests pin
 * the contract that makes that safe, using the SAME memo primitive the route
 * uses (with `enableInTests` so the test actually exercises caching — `ttlMemo`
 * is bypassed under `bun test` by design).
 */
describe('sandbox-health poll caching', () => {
  const SANDBOX_HEALTH_TTL_MS = 10_000;

  const memo = (ttlMs: number, loader: (projectId: string) => Promise<number>) =>
    ttlMemo({
      ttlMs,
      keyFn: (projectId: string) => projectId,
      loader,
      enableInTests: true,
    });

  test('the TTL is short enough that a finished build shows up on the next poll', () => {
    // The sidebar re-polls; an answer this old is indistinguishable to a user.
    // Anything near the request budget would make the alert feel stuck.
    expect(SANDBOX_HEALTH_TTL_MS).toBeLessThan(SANDBOX_HEALTH_BUDGET_MS);
  });

  test('repeat polls for one project share a single provider round trip', async () => {
    let calls = 0;
    const cached = memo(SANDBOX_HEALTH_TTL_MS, async () => ++calls);

    expect(await cached('p1')).toBe(1);
    expect(await cached('p1')).toBe(1);
    expect(await cached('p1')).toBe(1);
    expect(calls).toBe(1);
  });

  test('concurrent polls collapse to one round trip, not one each', async () => {
    // Six list/health fetches per session open in the corpus. Without in-flight
    // de-duplication the cache would not help the very burst it exists for.
    let calls = 0;
    const cached = memo(SANDBOX_HEALTH_TTL_MS, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return calls;
    });

    const answers = await Promise.all([cached('p1'), cached('p1'), cached('p1')]);

    expect(calls).toBe(1);
    expect(answers).toEqual([1, 1, 1]);
  });

  test('two projects never share an answer', async () => {
    // The template set, its content hash and the provider pin are all
    // per-project — a shared entry would show one project another's alert.
    let calls = 0;
    const cached = memo(SANDBOX_HEALTH_TTL_MS, async () => ++calls);

    expect(await cached('p1')).toBe(1);
    expect(await cached('p2')).toBe(2);
    expect(await cached('p1')).toBe(1);
  });

  test('invalidating a project re-reads it on the very next poll', async () => {
    // What POST /snapshots/rebuild does, so a deliberate rebuild is not hidden
    // behind the TTL.
    let calls = 0;
    const cached = memo(SANDBOX_HEALTH_TTL_MS, async () => ++calls);

    expect(await cached('p1')).toBe(1);
    cached.invalidate('p1');
    expect(await cached('p1')).toBe(2);
  });

  test('a failed provider call is never cached — the next poll retries', async () => {
    let calls = 0;
    const cached = memo(SANDBOX_HEALTH_TTL_MS, async () => {
      calls += 1;
      if (calls === 1) throw new Error('provider down');
      return calls;
    });

    await expect(cached('p1')).rejects.toThrow('provider down');
    expect(await cached('p1')).toBe(2);
  });
});
