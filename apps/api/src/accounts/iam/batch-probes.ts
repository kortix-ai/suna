// Effective-permission batch resolution — isolated into a leaf module so the
// per-probe resilience path is unit-testable WITHOUT a database or the full
// Hono/Drizzle route stack (the route handler in members.ts wires this up with
// the real `authorize` + structured logger).
//
// Why this exists: the `effective:batch` handler used `Promise.all` over the
// per-probe `authorize` calls, so a SINGLE transient `authorize` rejection
// (a momentary DB connection-pool blip under saturation — authorizeV2 issues
// several unguarded `await db` queries per probe) rejected the WHOLE batch,
// escalating to the global onError's opaque 500 "Internal server error". The
// accounts detail page (which fires this batch on every load — 8 capability
// probes) surfaced that as `ApiError: Internal server error` (Better Stack
// pattern c0e40278…, one-off / 0 users — the classic transient-saturation
// signature).
//
// Permission probes are best-effort UI gating: a transient miss should degrade
// to fail-closed (allowed:false) PER PROBE, not nuke the entire page as a 500.
// `Promise.allSettled` isolates per-probe failures; `onProbeError` keeps the
// signal visible to ops (structured log + metric) without paging Sentry as an
// error pattern — mirroring the request-deadline 503 de-noise (PR #4524 /
// #4531). A persistent `authorize` bug still surfaces (every probe returns
// probe_error), just as a structured log rather than a Sentry error.

import { resourceTypeForAction } from '../../iam/actions';
import type { AuthorizeResult, AuthorizeTarget } from '../../iam/engine';

/** `authorize` as a structural type — importing the real `typeof authorize`
 *  would drag the engine/db chain into this leaf module (and its unit test).
 *  `AuthorizeResult` / `AuthorizeTarget` come from `../../iam/engine`, a pure
 *  type leaf, so the shapes stay identical to the real `authorize` without a
 *  runtime dependency on the engine. */
export type AuthorizeFn = (
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
) => Promise<AuthorizeResult>;

export type BatchProbe = {
  action: string;
  target: AuthorizeTarget;
};

export type BatchProbeResult = {
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  allowed: boolean;
  reason: string | null;
};

/** Context handed to `onProbeError` when a single probe's `authorize` rejects.
 *  Lets the route handler ship a structured log without this module depending
 *  on the logger (which would pull the @logtail transport into the unit test). */
export interface BatchProbeErrorContext {
  accountId: string;
  action: string;
  resourceType: string | undefined;
  resourceId: string | null;
  error: string;
  errorName: string;
}

/**
 * Resolve a batch of effective-permission probes, isolating per-probe failures.
 *
 * Dedupes duplicate (action, target) pairs via an in-flight cache (preserving
 * output positions). A rejected probe degrades to
 * `{ allowed: false, reason: 'probe_error' }` instead of rejecting the whole
 * batch — see the module-level note.
 *
 * `authorizeFn` and `onProbeError` are parameters so the resilience path is
 * unit-testable without a database or logger transport.
 */
export async function resolveBatchProbes(
  probes: BatchProbe[],
  authorizeFn: AuthorizeFn,
  targetUserId: string,
  accountId: string,
  onProbeError?: (ctx: BatchProbeErrorContext) => void,
): Promise<BatchProbeResult[]> {
  const cache = new Map<string, Promise<AuthorizeResult>>();
  const keyFor = (p: BatchProbe) =>
    p.target?.type === 'account'
      ? `${p.action}|account|*`
      : `${p.action}|${p.target?.type}|${p.target && 'id' in p.target ? p.target.id : '*'}`;

  const settled = await Promise.allSettled(
    probes.map(async (p) => {
      const key = keyFor(p);
      let inflight = cache.get(key);
      if (!inflight) {
        inflight = authorizeFn(targetUserId, accountId, p.action, p.target);
        cache.set(key, inflight);
      }
      const r = await inflight;
      return {
        action: p.action,
        resource_type: resourceTypeForAction(p.action),
        resource_id: p.target && 'id' in p.target ? p.target.id : null,
        allowed: r.allowed,
        reason: r.reason ?? null,
      } satisfies BatchProbeResult;
    }),
  );

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const p = probes[i];
    const reason = s.reason as Error | undefined;
    onProbeError?.({
      accountId,
      action: p.action,
      resourceType: p.target?.type,
      resourceId: p.target && 'id' in p.target ? p.target.id : null,
      error: reason?.message ?? String(s.reason),
      errorName: reason?.name ?? 'Error',
    });
    return {
      action: p.action,
      resource_type: resourceTypeForAction(p.action),
      resource_id: p.target && 'id' in p.target ? p.target.id : null,
      allowed: false,
      reason: 'probe_error',
    } satisfies BatchProbeResult;
  });
}
