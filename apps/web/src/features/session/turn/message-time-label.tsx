'use client';

import { useSyncExternalStore } from 'react';

import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';

import { type MessageTimeOptions, formatMessageDay, formatMessageExact } from './message-time';

/**
 * What the server is allowed to render.
 *
 * `toLocaleString` and friends format in the *runtime's* zone — the server's on
 * SSR, the viewer's in the browser — so the same instant produces two different
 * strings and hydration fails (React #418, the bug `components/ui/local-time`
 * exists to document). Pinning UTC and `en-US` makes the server's output depend
 * on nothing but the timestamp, so both passes agree; the client then re-derives
 * in the viewer's real zone and locale.
 */
const SERVER_RENDER: MessageTimeOptions = { timeZone: 'UTC', locale: 'en-US' };

// ============================================================================
// One clock for the whole transcript
// ============================================================================

/**
 * A relative label goes stale, so something has to re-render it — but a
 * transcript can hold hundreds of messages, and hundreds of `setInterval`s to
 * move one word is the kind of cost that never shows up in review and always
 * shows up in a profile.
 *
 * So there is exactly ONE interval, shared by every label on the page, started
 * when the first label mounts and cleared when the last unmounts. Thirty
 * seconds keeps the minute boundary tight enough that "just now" never lingers
 * visibly, and background tabs throttle it for free.
 *
 * `useSyncExternalStore` rather than an effect: its third argument is a
 * *server* snapshot, which is precisely the "no clock exists here" case. That
 * makes the hydration-safe split a property of the API instead of something an
 * effect has to paper over after the fact.
 */
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let currentNow = 0;

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (!timer) {
    timer = setInterval(() => {
      currentNow = Date.now();
      for (const listener of listeners) listener();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Stable between ticks — React calls this repeatedly within one render and
 *  warns if the value moves, so the clock is read on the tick, not here. */
function getSnapshot(): number {
  if (currentNow === 0) currentNow = Date.now();
  return currentNow;
}

/** No clock on the server. `null` is the signal, not a sentinel date. */
function getServerSnapshot(): null {
  return null;
}

// ============================================================================

interface Rendered {
  /** How long ago — the label on screen. */
  label: string;
  /** The exact instant — the hover label. */
  exact: string;
  /** Machine-readable value for `<time datetime>` — UTC, so it never differs
   *  between the two render passes. */
  iso: string;
}

function derive(timestamp: number | null | undefined, now: number | null): Rendered | null {
  const opts = now === null ? SERVER_RENDER : undefined;
  const label = formatMessageDay(timestamp, now, opts);
  if (!label) return null;
  return {
    label,
    exact: formatMessageExact(timestamp, opts),
    iso: new Date(timestamp as number).toISOString(),
  };
}

export interface MessageTimeLabelProps {
  /** Epoch milliseconds. `null` renders nothing at all. */
  timestamp: number | null | undefined;
  className?: string;
}

/**
 * When a message was sent: how long ago on screen, the exact instant on hover.
 *
 * Colour is inherited, not set: this renders inside `InlineMeta`, which already
 * owns the meta scale and tone. Overriding it here would put two opinions on
 * one line.
 */
export function MessageTimeLabel({ timestamp, className }: MessageTimeLabelProps) {
  // `null` on the server and through hydration, a real clock after.
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const rendered = derive(timestamp, now);

  if (!rendered) return null;

  // `tabular-nums` so the digits in "5 days ago" hold their width as the count
  // climbs, instead of the label shuffling on every tick. `select-none` keeps
  // the stamp out of a copied transcript — the reader wanted the conversation,
  // not the chrome around it. Deliberately no `shrink-0`: the parent
  // `InlineMeta` truncates, and pinning the width here would overflow rather
  // than ellipse.
  //
  // `Hint` wraps the `<time>` element directly rather than this component, so
  // Radix's `asChild` trigger clones a real DOM node and has a ref to attach.
  return (
    <Hint label={rendered.exact} side="top" align="center">
      <time
        dateTime={rendered.iso}
        suppressHydrationWarning
        className={cn('tabular-nums select-none', className)}
      >
        {rendered.label}
      </time>
    </Hint>
  );
}
