'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export type RemindersView = 'list' | 'calendar';
export type RemindersRange = 'week' | 'month';
export type RemindersUrlPatch = Partial<Record<'view' | 'range' | 'session' | 'date', string | null>>;

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
  const router = useRouter();
  const pathname = usePathname();
  const view: RemindersView = params.get('view') === 'calendar' ? 'calendar' : 'list';
  const range: RemindersRange = params.get('range') === 'month' ? 'month' : 'week';

  const set = (patch: RemindersUrlPatch) => {
    const query = remindersQuery(params.toString(), patch);
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return { view, range, session: params.get('session'), date: params.get('date'), set };
}
