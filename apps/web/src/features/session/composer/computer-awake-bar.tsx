'use client';

import { TimerIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import {
  COMPUTER_AWAKE_TICK_MS,
  computerAwakeLine,
  computerAwakeText,
  type ComputerAwakeLine,
} from './computer-awake';

/**
 * `computerAwakeLine` against a clock that runs only while there is a window
 * to show: a viewer, an absent tab and a running turn cost no timer. The line
 * keeps its identity until its text changes, so the memo-wrapped composer
 * re-renders once a minute at most, not on every tick.
 */
export function useComputerAwakeLine(
  awake: { until: Date; capAt: Date } | null,
  turnRunning: boolean,
): ComputerAwakeLine | null {
  const ticking = awake !== null && !turnRunning;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, COMPUTER_AWAKE_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  const line = computerAwakeLine({ awake, turnRunning, now });
  const kind = line?.kind;
  const minutes = line?.minutes;
  return useMemo(
    () => (kind !== undefined && minutes !== undefined ? { kind, minutes } : null),
    [kind, minutes],
  );
}

/**
 * A strip above the composer card: the session's computer stays on while the
 * person is here, and for how long (KRTX-1729). `computerAwakeLine` decides
 * whether it shows and what it says.
 *
 * The same chrome as the "still waking" notice in `ComposerAboveCard`. Under
 * the queue strip or on top it rounds its top; a docked question hides it.
 * The served-model strip under it stays square. The line wraps rather than
 * truncates: the duration ends the sentence.
 *
 * The countdown is not a live region: `role="status"` is atomic, so a screen
 * reader re-read the whole sentence every minute. One sr-only region, mounted
 * with the strip, says one fixed sentence when presence stops extending.
 */
export function ComputerAwakeBar({ line }: { line: ComputerAwakeLine }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const stops = line.kind === 'stops';
  return (
    <div
      data-testid="computer-awake-bar"
      className="bg-sidebar border-border flex w-full items-center gap-2 rounded-t-xl border border-b-0 px-3 py-1.5"
    >
      <TimerIcon
        className={cn('size-3.5 shrink-0', stops ? 'text-kortix-orange' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <span className="text-muted-foreground min-w-0 flex-1 text-xs">
        {computerAwakeText(line, tI18nComplete)}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {stops ? tI18nComplete('computerAwakeStopsSoon') : ''}
      </span>
    </div>
  );
}
