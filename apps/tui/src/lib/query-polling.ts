/**
 * `refetchInterval`, for a process with no `window`.
 *
 * TanStack Query decides once, at import, that a process without `window` is a
 * server (`isServer`), and a server never schedules `refetchInterval`. The TUI
 * runs in Bun, so every poll the SDK hooks ask for was silently dead: an agent's
 * row never saw its agent finish, a workflow run never moved, held messages never
 * arrived. A `window` shim is not safe: SDK paths read `window.location.*`.
 *
 * Instead the TUI drives the polls itself: once a second, every active query
 * whose observers ask for an interval is fetched again when that interval has
 * passed since its last data or error. Same contract as TanStack's own timer:
 * enabled observers only, the shortest interval wins, no fetch while one runs.
 */

import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

const TICK_MS = 1_000;

/** Fetch every query whose `refetchInterval` passed at `now`. Exported for tests. */
export function pollDueQueries(client: QueryClient, now: number): void {
  for (const query of client.getQueryCache().getAll()) {
    if (query.state.fetchStatus === 'fetching') continue;
    let interval = Number.POSITIVE_INFINITY;
    for (const observer of query.observers) {
      const options = observer.options;
      const enabled =
        typeof options.enabled === 'function' ? options.enabled(query) : options.enabled;
      if (enabled === false) continue;
      const raw = options.refetchInterval;
      const value = typeof raw === 'function' ? raw(query) : raw;
      if (typeof value === 'number' && value > 0) interval = Math.min(interval, value);
    }
    if (!Number.isFinite(interval)) continue;
    const last = Math.max(query.state.dataUpdatedAt, query.state.errorUpdatedAt);
    if (now - last >= interval) void query.fetch().catch(() => {});
  }
}

/** Mount once, beside the `QueryClientProvider`. */
export function useQueryPolling(client: QueryClient): void {
  useEffect(() => {
    const timer = setInterval(() => pollDueQueries(client, Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [client]);
}

/** `useQueryPolling` as an element, for the root next to `<QueryClientProvider>`. */
export function QueryPolling({ client }: { client: QueryClient }): null {
  useQueryPolling(client);
  return null;
}
