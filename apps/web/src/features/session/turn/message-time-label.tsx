'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

import {
  type MessageTimeOptions,
  formatMessageTime,
  formatMessageTimeFull,
} from './message-time';

/**
 * What the server is allowed to render.
 *
 * `toLocaleString` and friends format in the *runtime's* zone — the server's on
 * SSR, the viewer's in the browser — so the same instant produces two different
 * strings and hydration fails (React #418, the bug `components/ui/local-time`
 * exists to document). Pinning UTC and `en-US` makes the server's output depend
 * on nothing but the timestamp, so both passes agree; the effect below then
 * swaps in the viewer's real zone and locale.
 */
const SERVER_RENDER: MessageTimeOptions = { timeZone: 'UTC', locale: 'en-US' };

interface Rendered {
  /** The short reading on screen. */
  label: string;
  /** The unabbreviated reading, for the hover title. */
  title: string;
  /** Machine-readable value for `<time datetime>` — UTC, so it never differs
   *  between the two render passes. */
  iso: string;
}

function derive(timestamp: number | null | undefined, now: number | null): Rendered | null {
  const opts = now === null ? SERVER_RENDER : undefined;
  const label = formatMessageTime(timestamp, now, opts);
  if (!label) return null;
  return {
    label,
    title: formatMessageTimeFull(timestamp, opts),
    iso: new Date(timestamp as number).toISOString(),
  };
}

export interface MessageTimeLabelProps {
  /** Epoch milliseconds. `null` renders nothing at all. */
  timestamp: number | null | undefined;
  className?: string;
}

/**
 * When a message was sent.
 *
 * Deliberately does NOT tick. The label is an absolute clock reading, so the
 * only thing that can go stale is the word "Yesterday" rolling over at
 * midnight — and paying for that with one interval per message, in a transcript
 * that can hold hundreds, is a bad trade for a tab that has been open since
 * before midnight.
 *
 * Colour is inherited, not set: this renders inside `InlineMeta`, which already
 * owns the meta scale and tone. Overriding it here would put two opinions on
 * one line.
 */
export function MessageTimeLabel({ timestamp, className }: MessageTimeLabelProps) {
  // First paint (server AND the client's hydrating pass) uses the timezone-
  // stable form; `now` is null because no render that has to match the server
  // may consult a clock.
  const [rendered, setRendered] = useState(() => derive(timestamp, null));

  useEffect(() => {
    // Post-hydration: the viewer's own zone, locale, and today.
    setRendered(derive(timestamp, Date.now()));
  }, [timestamp]);

  if (!rendered) return null;

  // `tabular-nums` so a column of timestamps down the transcript lines up
  // instead of shimmering by a fraction of a character per row. `select-none`
  // keeps the stamp out of a copied transcript — the reader wanted the
  // conversation, not the chrome around it. Deliberately no `shrink-0`: the
  // parent `InlineMeta` truncates, and pinning the width here would make a long
  // stamp overflow rather than ellipse.
  return (
    <time
      dateTime={rendered.iso}
      title={rendered.title}
      suppressHydrationWarning
      className={cn('tabular-nums select-none', className)}
    >
      {rendered.label}
    </time>
  );
}
