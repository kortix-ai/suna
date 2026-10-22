'use client';

import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

export type RemindersView = 'list' | 'calendar';
export type RemindersRange = 'day' | 'week' | 'month';
export type RemindersUrlPatch = Partial<
  Record<'view' | 'range' | 'session' | 'date', string | null>
>;

/** A param at its default value is left out of the URL. */
const DEFAULTS: Record<string, string> = { view: 'calendar', range: 'week' };

/** The query string after `patch`: null or a default removes the param. Pure. */
export function remindersQuery(current: string, patch: RemindersUrlPatch): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === DEFAULTS[key]) next.delete(key);
    else next.set(key, value);
  }
  return next.toString();
}

/** Next's router learns the URL once changes have stopped for this long, at idle. */
const ROUTER_SYNC_MS = 800;
let routerSync: ReturnType<typeof setTimeout> | undefined;

/**
 * Writes the address bar at once, and tells Next's router later.
 *
 * Next patches `history.replaceState` so `useSearchParams` follows it, and
 * that update re-renders the app: measured 190–420 ms of main-thread work in
 * dev for one changed param, on every view, range and filter click and after
 * every calendar scroll. Next skips the patch for a state that carries its own
 * `__NA` marker, so passing its current entry state through changes only the
 * URL, with no render.
 *
 * Next must still learn the URL: when it rewrites the address bar from its
 * own state (a refresh, a hot reload), it would put back the params it last
 * knew. So once changes stop, at browser idle, the same URL goes through the
 * patched path once.
 */
function writeUrl(query: string) {
  const { pathname } = window.location;
  const url = query ? `${pathname}?${query}` : pathname;
  window.history.replaceState(window.history.state, '', url);
  clearTimeout(routerSync);
  routerSync = setTimeout(() => {
    const sync = () => {
      if (`${window.location.pathname}${window.location.search}` !== url) return;
      window.history.replaceState(null, '', url);
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(sync, { timeout: 2000 });
    else sync();
  }, ROUTER_SYNC_MS);
}

/**
 * The Reminders page's view state: `?view=list|calendar` (Calendar by default),
 * `?range=day|week|month`, `?session=<id>` (the session filter) and
 * `?date=<YYYY-MM-DD>` (calendar anchor). Held here, read from the URL when
 * the page opens and written back on every change, so a link or a reload
 * lands on the same view.
 */
export function createRemindersUrlStore(initial: string) {
  let query = initial;
  const listeners = new Set<() => void>();
  // Queries this store wrote. Next reports each one back after its idle sync,
  // possibly after a newer change: reading one back would undo that change.
  const written = new Set<string>([initial]);
  const apply = (next: string) => {
    if (next === query) return false;
    query = next;
    listeners.forEach((listener) => listener());
    return true;
  };
  return {
    query: () => query,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Change params: the page renders at once, then the URL follows. */
    set(patch: RemindersUrlPatch) {
      if (!apply(remindersQuery(query, patch))) return;
      written.add(query);
      writeUrl(query);
    },
    /** Take a URL Next navigated to (a link to this page with other params), never our own echo. */
    sync(next: string) {
      if (written.has(next)) return;
      written.add(next);
      apply(next);
    },
  };
}

export type RemindersUrlStore = ReturnType<typeof createRemindersUrlStore>;

export const RemindersUrlContext = createContext<RemindersUrlStore | null>(null);

export function useRemindersUrlState() {
  const store = useContext(RemindersUrlContext);
  if (!store) throw new Error('useRemindersUrlState needs a RemindersUrlContext provider');
  const query = useSyncExternalStore(store.subscribe, store.query, store.query);
  return useMemo(() => {
    const params = new URLSearchParams(query);
    const range = params.get('range');
    return {
      view: (params.get('view') === 'list' ? 'list' : 'calendar') as RemindersView,
      range: (range === 'day' || range === 'month' ? range : 'week') as RemindersRange,
      session: params.get('session'),
      date: params.get('date'),
      set: store.set,
    };
  }, [query, store]);
}
