'use client';

import { useEffect, useState } from 'react';

/**
 * Formats an instant in an explicit, fixed timezone so the output is
 * deterministic regardless of the runtime's default timezone. Used for the
 * server-rendered fallback (we always render in UTC on the server).
 *
 * Exported for tests: this is the invariant that prevents React hydration
 * mismatch #418 — the server-rendered text must not depend on `process.env.TZ`.
 */
export function formatInTimeZone(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(date);
}

export interface LocalTimeProps {
  /** The instant to render — an ISO string, epoch ms, or Date. */
  value: string | number | Date;
  /** Intl formatting options (weekday/month/day/hour/minute/…). */
  options?: Intl.DateTimeFormatOptions;
  /** Rendered (verbatim) when `value` can't be parsed into a valid date. */
  fallback?: string;
  className?: string;
}

/**
 * Renders a date/time that is safe to server-render.
 *
 * `toLocaleString`/`toLocaleDateString` format using the runtime's *default*
 * timezone. During SSR that's the server (UTC); in the browser it's the user's
 * timezone — so the two produce different text for the same instant and React
 * throws a hydration mismatch (minified error #418, e.g. for a release dated
 * near midnight UTC, or any time-of-day on the maintenance page).
 *
 * This component sidesteps that the same way `SessionTimeLabel` does: it renders
 * a **timezone-stable UTC string on the server**, and only switches to the
 * viewer's local timezone *after mount* (in `useEffect`, which never runs on the
 * server). `suppressHydrationWarning` covers the one intentional, post-hydration
 * text swap on this single element.
 */
export function LocalTime({ value, options, fallback, className }: LocalTimeProps) {
  const date = value instanceof Date ? value : new Date(value);
  const isValid = !Number.isNaN(date.getTime());

  const fmtOptions: Intl.DateTimeFormatOptions = options ?? {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };

  // Server + first client render: a stable UTC string (identical in both).
  const serverText = isValid ? formatInTimeZone(date, fmtOptions, 'UTC') : '';
  const [text, setText] = useState(serverText);

  useEffect(() => {
    if (!isValid) return;
    // After hydration, re-render in the viewer's own timezone/locale.
    setText(new Intl.DateTimeFormat('en-US', fmtOptions).format(date));
    // date / options are derived from props; stringify options for a stable dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getTime(), JSON.stringify(fmtOptions), isValid]);

  if (!isValid) {
    return fallback !== undefined ? <span className={className}>{fallback}</span> : null;
  }

  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
