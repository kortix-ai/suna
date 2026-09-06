'use client';

import { cn } from '@/lib/utils';

/**
 * A session row's name. One line, truncated, nothing else.
 *
 * This used to be a hover marquee (a `requestAnimationFrame` scroll loop plus a
 * 600ms hover timer) wrapped around a type-on animation that replayed whenever
 * the server wrote a title. Both were removed on purpose:
 *
 *  - The sidebar polls the session list every 3s while any title is still
 *    pending (`projectSessionsRefetchInterval`), so the type-on fired across
 *    the list as names landed, and every row carried a scroll effect keyed on
 *    `title`. That is per-row main-thread work in the one surface that must
 *    stay instant while you are switching sessions.
 *  - Whether a session is live is the status dot's job. A title that animates
 *    says "something is happening here" a second time, in a place that cannot
 *    say WHAT — so the two indicators competed and neither read cleanly.
 *
 * No `title` attribute either. The native tooltip it produced fought the Radix
 * tooltips the row already uses: different delay, different placement, different
 * paint, and it fired over the whole row instead of over one control.
 */
export function SessionTitle({ title, className }: { title: string; className?: string }) {
  return <span title={title} className={cn('block truncate text-foreground text-sm leading-5', className)}>{title}</span>;
}
