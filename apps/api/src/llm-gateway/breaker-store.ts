import { gatewayBreakerState } from '@kortix/db';
import type { BreakerSignalStore } from '@kortix/llm-gateway';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../shared/db';

// ─── Fleet-wide breaker signal store (Postgres-backed, cached) ──────────────
//
// The gateway's in-memory circuit breaker is per-process: a failure burst seen on
// ONE API replica only opens that replica's breaker, so siblings keep hammering a
// down provider. This store surfaces the SHARED open verdict (maintained by the
// leader's breaker-reconciler in gateway_breaker_state) so every replica's breaker
// adopts it and a tripped provider fails over fleet-wide.
//
// isOpenFleetWide() is on the request hot path, so it reads an in-memory Set and
// kicks an async refresh when the cache goes stale — NEVER a per-request query.
// A refresh failure fails OPEN of the signal (behaves as "nothing fleet-open") so
// a DB hiccup can never block request admission; the local breaker still guards.

const REFRESH_TTL_MS = 5_000; // serve a snapshot at most ~5s old
// Ignore open rows the reconciler has stopped refreshing (leader died / wedged),
// so a stale verdict can't pin a provider open forever. The reconciler writes
// updated_at every tick (15s), well inside this bound.
const STALE_OPEN_MS = 120_000;

export function createBreakerSignalStore(): BreakerSignalStore {
  let openProviders = new Set<string>();
  let lastRefresh = 0;
  let refreshing: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    const cutoff = new Date(Date.now() - STALE_OPEN_MS);
    try {
      const rows = await db
        .select({ provider: gatewayBreakerState.provider })
        .from(gatewayBreakerState)
        .where(and(eq(gatewayBreakerState.state, 'open'), gt(gatewayBreakerState.updatedAt, cutoff)));
      openProviders = new Set(rows.map((r) => r.provider));
    } catch (err) {
      // Keep the last good snapshot; back off so a broken DB isn't hammered.
      console.warn(
        '[gateway-breaker-store] snapshot refresh failed (failing open):',
        err instanceof Error ? err.message : err,
      );
    } finally {
      lastRefresh = Date.now();
      refreshing = null;
    }
  };

  // Prime the cache once at startup (non-blocking).
  refreshing = refresh();

  return {
    isOpenFleetWide(provider: string): boolean {
      if (Date.now() - lastRefresh > REFRESH_TTL_MS && !refreshing) {
        // Fire-and-forget: return the CURRENT snapshot now, refresh for next time.
        refreshing = refresh();
      }
      return openProviders.has(provider);
    },
  };
}
