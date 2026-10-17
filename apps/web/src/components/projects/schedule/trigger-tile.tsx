'use client';

/**
 * A trigger's clock (Paper C16): the trigger toast's entity icon with a
 * corner status dot. Every trigger type draws the clock in the list and the
 * sheet; the toast keeps its per-type glyphs.
 *
 * The glyph is drawn as `EntityTile` in `components/ui/toast.tsx` draws it:
 * muted, then again in the health colour under the toast's `REFLECTION_MASK`,
 * so the colour reaches in from the corner the dot sits on. The dot is a plain
 * 5 px dot on a disc in the row's own surface. Paused keeps its health's
 * reflection at half strength with a muted dot; never run and setting up draw
 * no reflection. `text-kortix-*` tokens carry both themes. The health is the
 * image's name.
 */

import { REFLECTION_MASK } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectTrigger } from '@kortix/sdk';
import { ClockIcon } from '@phosphor-icons/react';

import { triggerBadgeState } from './schedule-copy';
import { LABEL_KEY } from './trigger-status-badge';

export type ClockState = 'ok' | 'failed' | 'needs_connection' | 'pending' | 'paused' | 'never';

/** The health the clock shows: the badge state, with "live" split by whether it ever ran. */
export function clockState(trigger: ProjectTrigger): ClockState {
  const state = triggerBadgeState(trigger);
  if (state === 'error') return 'failed';
  if (state !== 'live') return state;
  return trigger.last_fired_at || trigger.event?.last_event_at ? 'ok' : 'never';
}

const REFLECTION = {
  ok: 'text-kortix-green',
  failed: 'text-kortix-red',
  needs_connection: 'text-kortix-orange',
  pending: null,
  paused: null,
  never: null,
} as const satisfies Record<ClockState, string | null>;

const DOT = {
  ok: 'bg-kortix-green',
  failed: 'bg-kortix-red',
  needs_connection: 'bg-kortix-orange',
  pending: 'bg-muted-foreground',
  paused: 'bg-muted-foreground',
  never: 'bg-muted-foreground',
} as const satisfies Record<ClockState, string>;

const LABEL = {
  ok: LABEL_KEY.live,
  failed: LABEL_KEY.error,
  needs_connection: LABEL_KEY.needs_connection,
  pending: LABEL_KEY.pending,
  paused: LABEL_KEY.paused,
  never: 'text3d40a69d3160',
} as const satisfies Record<ClockState, string>;

export function TriggerTile({
  trigger,
  surface = 'bg-background',
}: {
  trigger: ProjectTrigger;
  /** The disc behind the dot paints the row's own surface, so the dot reads as cut out. */
  surface?: 'bg-background' | 'bg-card' | 'bg-muted' | 'bg-surface' | 'bg-popover' | 'bg-sidebar';
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const state = clockState(trigger);
  const label = t.raw(LABEL[state]);
  // Paused keeps the gradient of the health it would have, at half strength.
  const tone =
    state === 'paused'
      ? trigger.last_status === 'failed'
        ? REFLECTION.failed
        : trigger.last_fired_at || trigger.event?.last_event_at
          ? REFLECTION.ok
          : null
      : REFLECTION[state];
  return (
    <span role="img" aria-label={label} title={label} className="relative size-5 shrink-0">
      <span className="text-muted-foreground absolute inset-0 flex items-center justify-center [&_svg]:size-5">
        <ClockIcon />
      </span>
      {tone ? (
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 flex items-center justify-center [&_svg]:size-5',
            tone,
            state === 'paused' && 'opacity-50',
          )}
          style={{ maskImage: REFLECTION_MASK, WebkitMaskImage: REFLECTION_MASK }}
        >
          <ClockIcon />
        </span>
      ) : null}
      {/* The toast's badge disc (`size-3`, −0.75 offset) holding Paper's plain dot. */}
      <span
        aria-hidden
        className={cn(
          'absolute -right-0.75 -bottom-0.75 flex size-3 items-center justify-center rounded-full',
          surface,
        )}
      >
        <span className={cn('size-1.5 rounded-full', DOT[state])} />
      </span>
    </span>
  );
}
