import { sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { SANDBOX_SERVICE_PORT } from './sandbox-env-transport';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { db } from '../../shared/db';
import { KORTIX_SERVICE_CALL_HEADER } from '../../shared/kortix-user-context';

/**
 * Poke a live sandbox's daemon so it re-converges on this deploy's runtime
 * assets (the `kortix` CLI and the managed-skill overlay — see
 * apps/kortix-sandbox-agent-server/src/services/runtime-assets/runtime-assets.ts).
 *
 * WHY IT IS NEEDED HERE. The daemon reconciles at its own boot, but restart and
 * resume bring a session back on the SAME VM without re-running that boot, so
 * nothing in those two paths would ever refresh a stale binary. `POST
 * /kortix/refresh` already exists, is already called on warm reuse and on
 * session reload, and now carries the reconcile — so the fix for both paths is
 * one call to a route that is already part of the contract.
 *
 * WHAT IT SENDS. Ordinary refreshes use `?restart=0`. A provider resume also
 * sends `repo=0&on_boot=1` with the direct-service header. The resume call
 * leaves the checkout unchanged and reruns the project's boot hook. It never
 * sends `base=1`, which force-resets the session branch and discards commits.
 *
 * WHY IT RETRIES. A provider reports `running` before the guest's daemon has
 * bound its port, so the first attempt after a wake routinely lands on a closed
 * socket. The schedule is bounded and entirely detached.
 *
 * NEVER blocks a caller and never throws: every call site is already past the
 * point where the session was reported ready to the user.
 */

/** 0s, 5s, 15s, 30s, 60s — bounded at ~110s total, then give up silently. */
const RETRY_DELAYS_MS = [0, 5_000, 10_000, 15_000, 30_000] as const;
const REQUEST_TIMEOUT_MS = 30_000;

export interface SandboxRuntimeRefreshDeps {
  loadActiveSandbox: (
    sessionId: string,
  ) => Promise<{ externalId: string; serviceKey: string } | null>;
  resolveIngress: (
    externalId: string,
  ) => Promise<{ url: string; headers: Record<string, string> }>;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}

/** Exported for `model-catalog-turn-start.ts`'s single-attempt daemon call —
 *  same active-sandbox lookup, no reason to duplicate the query. */
export async function loadActiveSandbox(
  sessionId: string,
): Promise<{ externalId: string; serviceKey: string } | null> {
  const [row] = await db
    .select({ externalId: sessionSandboxes.externalId, config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(
      and(eq(sessionSandboxes.sessionId, sessionId), eq(sessionSandboxes.status, 'active')),
    )
    .orderBy(desc(sessionSandboxes.updatedAt))
    .limit(1);
  const serviceKey = (row?.config as Record<string, unknown> | null)?.serviceKey;
  if (!row?.externalId || typeof serviceKey !== 'string' || !serviceKey) return null;
  return { externalId: row.externalId, serviceKey };
}

const defaultDeps: SandboxRuntimeRefreshDeps = {
  loadActiveSandbox,
  resolveIngress: (externalId) =>
    resolveSandboxIngress(externalId, { port: SANDBOX_SERVICE_PORT, transport: 'http' }),
  fetch: globalThis.fetch,
  sleep: Bun.sleep,
};

export type SandboxRuntimeRefreshOutcome = 'refreshed' | 'unreachable' | 'no_sandbox';

/**
 * Awaitable core — exported so tests can assert the retry and give-up behaviour
 * without a timer. Production call sites use `scheduleSandboxRuntimeRefresh`.
 */
export async function refreshSandboxRuntimeAssets(
  sessionId: string,
  deps: SandboxRuntimeRefreshDeps = defaultDeps,
  runOnBoot = false,
): Promise<SandboxRuntimeRefreshOutcome> {
  let sandbox: { externalId: string; serviceKey: string } | null = null;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await deps.sleep(delay);
    try {
      sandbox ??= await deps.loadActiveSandbox(sessionId);
      // The row is flipped to `active` by the same code path that calls us, but
      // a lagging read just means "try again on the next tick".
      if (!sandbox) continue;
      const ingress = await deps.resolveIngress(sandbox.externalId);
      const query = runOnBoot ? '?restart=0&repo=0&on_boot=1' : '?restart=0';
      const response = await deps.fetch(
        `${ingress.url.replace(/\/+$/, '')}/kortix/refresh${query}`,
        {
          method: 'POST',
          headers: {
            ...ingress.headers,
            Authorization: `Bearer ${sandbox.serviceKey}`,
            ...(runOnBoot ? { [KORTIX_SERVICE_CALL_HEADER]: '1' } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      // 409 = a refresh is already running in there, which serves the same
      // purpose. Anything else 2xx-or-409 counts as delivered.
      if (response.ok || (!runOnBoot && response.status === 409)) return 'refreshed';
    } catch {
      // Closed socket while the guest is still coming up. Retry.
    }
  }
  return sandbox ? 'unreachable' : 'no_sandbox';
}

export function refreshResumedSandboxRuntimeAssets(
  sessionId: string,
  deps: SandboxRuntimeRefreshDeps = defaultDeps,
): Promise<SandboxRuntimeRefreshOutcome> {
  return refreshSandboxRuntimeAssets(sessionId, deps, true);
}

/**
 * Fire-and-forget form for the restart/resume call sites. Returns immediately.
 */
export function scheduleSandboxRuntimeRefresh(sessionId: string, context: string): void {
  const refresh = context === 'resume'
    ? refreshResumedSandboxRuntimeAssets(sessionId)
    : refreshSandboxRuntimeAssets(sessionId);
  void refresh
    .then((outcome) => {
      if (outcome === 'refreshed') return;
      logger.info('[projects] sandbox runtime-asset refresh not delivered', {
        session_id: sessionId,
        context,
        outcome,
      });
    })
    .catch((error) =>
      logger.warn('[projects] sandbox runtime-asset refresh threw', {
        session_id: sessionId,
        context,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
}
