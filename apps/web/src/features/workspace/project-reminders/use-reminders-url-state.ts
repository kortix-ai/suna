'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

export type RemindersView = 'list' | 'calendar';
export type RemindersRange = 'week' | 'month';
export type RemindersUrlPatch = Partial<
  Record<'view' | 'range' | 'session' | 'date', string | null>
>;

/** A param at its default value is left out of the URL. */
const DEFAULTS: Record<string, string> = { view: 'list', range: 'week' };

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

/**
 * The Reminders page's view state, kept in the URL so a link or a reload
 * lands on the same view: `?view=list|calendar`, `?range=week|month`,
 * `?session=<id>` (the session filter), `?date=<YYYY-MM-DD>` (calendar anchor).
 */
export function useRemindersUrlState() {
  const params = useSearchParams();
  const view: RemindersView = params.get('view') === 'calendar' ? 'calendar' : 'list';
  const range: RemindersRange = params.get('range') === 'month' ? 'month' : 'week';

  // `history.replaceState`, not `router.replace`: every param here is client
  // state, and `router.replace` refetched the route's server payload on each
  // filter click. Next syncs `useSearchParams` with the native History API.
  // Reads `location.search` so two calls in one tick do not drop a patch.
  const set = useCallback((patch: RemindersUrlPatch) => {
    const query = remindersQuery(window.location.search, patch);
    const path = window.location.pathname;
    window.history.replaceState(null, '', query ? `${path}?${query}` : path);
  }, []);

  return { view, range, session: params.get('session'), date: params.get('date'), set };
}
