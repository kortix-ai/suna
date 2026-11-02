'use client';

import { useTranslations } from '@/i18n/use-translations';

import type { UseSessionResult } from '@kortix/sdk/react';
import Loading from '@kortix/ui/loading';
import { cn } from '@kortix/ui';
import { useEffect, useState } from 'react';

/**
 * What a starting session waits on while its sandbox image is not ready yet:
 * `useSession().bootImage`, from `/start`'s `boot.image`. A first image build
 * takes minutes. Without this the wait reads as unexplained latency, so the
 * screen names the step and counts the time since it began.
 *
 * Two placements, one body:
 * - `SessionImageStatus`: the card inside the boot surface (`SavedSessionSkeleton`'s
 *   `status` slot), where nothing else speaks.
 * - `SessionImageBanner`: the same body pinned above a surface that has its own
 *   content (the new-session shell, a readable conversation).
 */
export type SessionImageStep = NonNullable<UseSessionResult['bootImage']>;

/** `m:ss` from `since` to `now`. A `since` ahead of this clock reads `0:00`. */
export function formatImageElapsed(since: string, now: number): string {
  const start = Date.parse(since);
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1_000)) : 0;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A 1 s tick for the elapsed timer. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function SessionImageStepBody({ step }: { step: SessionImageStep }) {
  const t = useTranslations('sessionPage.image');
  const now = useNow();
  return (
    <div className="flex w-full max-w-xs items-start gap-3" data-image-state={step.state}>
      <Loading
        variant="spokes"
        className="text-muted-foreground mt-0.5 size-4 shrink-0 motion-reduce:animate-none"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          {/* The live region carries the words only: a timer inside it would
              be read out every second. */}
          <p role="status" aria-live="polite" className="text-foreground text-sm font-medium">
            {t('title')}
            <span className="sr-only">. {t(`states.${step.state}`)}</span>
          </p>
          <span
            aria-hidden
            className="text-muted-foreground shrink-0 text-xs tabular-nums"
            data-testid="session-image-elapsed"
          >
            {formatImageElapsed(step.since, now)}
          </span>
        </div>
        <p aria-hidden className="text-muted-foreground mt-1 text-xs text-pretty">
          {t(`states.${step.state}`)}
        </p>
        {step.image ? (
          <p className="text-muted-foreground mt-2 truncate font-mono text-xs" title={step.image}>
            {step.image}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The image step as the boot surface's centered card body. */
export function SessionImageStatus({ step }: { step: SessionImageStep }) {
  return (
    <div className="flex w-full items-center justify-center px-4 sm:px-8">
      <SessionImageStepBody step={step} />
    </div>
  );
}

/**
 * The image step pinned at the top of a surface that keeps its own content:
 * the new-session shell (the composer stays usable) or a readable
 * conversation. Only the card takes space; the rest lets input through.
 */
export function SessionImageBanner({
  step,
  className,
}: {
  step: SessionImageStep;
  className?: string;
}) {
  return (
    <div
      data-session-image-banner=""
      className={cn(
        'pointer-events-none absolute inset-x-0 top-12 z-30 flex justify-center px-3',
        className,
      )}
    >
      <div className="bg-background border-border pointer-events-auto rounded-xl border px-4 py-3 shadow-xs">
        <SessionImageStepBody step={step} />
      </div>
    </div>
  );
}
