'use client';

/**
 * A trigger's clock (Paper C16): the trigger toast's entity icon with a
 * corner status dot. Every trigger type draws the clock in the list and the
 * sheet; the toast keeps its per-type glyphs.
 *
 * The glyph is drawn as `EntityTile` in `components/ui/toast.tsx` draws it:
 * muted, then again in the health colour under the toast's `REFLECTION_MASK`,
 * so the colour reaches in from the corner the dot sits on. The dot is a plain
 * 5 px dot on a disc in the row's own surface. One tone per state colours
 * both (`CLOCK_TONE`). The health is the image's name.
 */

import { REFLECTION_MASK } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectTrigger } from '@kortix/sdk';
import { ClockIcon } from '@phosphor-icons/react';

import { triggerBadgeState } from './schedule-copy';
import { LABEL_KEY } from './trigger-status-badge';

export type ClockState = 'ok' | 'failed' | 'needs_connection' | 'pending' | 'paused' | 'never';

/**
 * The health the clock shows: the badge state, with "live" split by whether
 * it ever ran. `projectPaused` (the project-wide switch) pauses every clock.
 */
export function clockState(
  trigger: ProjectTrigger,
  projectPaused = false,
  running = false,
): ClockState {
  // A run starting right now is live, even under the project switch (Run now still fires).
  if (running) return 'ok';
  if (projectPaused) return 'paused';
  const state = triggerBadgeState(trigger);
  if (state === 'error') return 'failed';
  if (state !== 'live') return state;
  return trigger.last_fired_at || trigger.event?.last_event_at ? 'ok' : 'never';
}

const GREEN = { reflection: 'text-kortix-green', dot: 'bg-kortix-green' } as const;
const RED = { reflection: 'text-kortix-red', dot: 'bg-kortix-red' } as const;
const YELLOW = { reflection: 'text-kortix-yellow', dot: 'bg-kortix-yellow' } as const;

/**
 * ONE tone per state drives both the reflection and the dot, so they cannot
 * disagree. Three colours, always full strength: green = live (running, ran,
 * or not run yet), red = failed, yellow = paused or waiting on setup.
 */
export const CLOCK_TONE = {
  ok: GREEN,
  never: GREEN,
  failed: RED,
  needs_connection: YELLOW,
  pending: YELLOW,
  paused: YELLOW,
} as const satisfies Record<ClockState, { reflection: string; dot: string }>;

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
  projectPaused = false,
  running = false,
  surface = 'bg-background',
}: {
  trigger: ProjectTrigger;
  /** The project-wide pause switch is on. */
  projectPaused?: boolean;
  /** A run of this trigger is starting now: green, whatever the switch says. */
  running?: boolean;
  /**
   * The disc behind the dot paints the row's own surface, so the dot reads as
   * cut out (C16). `row` reads `--row-surface`, which a list row sets for its
   * rest, hover and selected states.
   */
  surface?: 'row' | 'bg-background' | 'bg-muted' | 'bg-surface' | 'bg-popover' | 'bg-sidebar';
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const state = clockState(trigger, projectPaused, running);
  const label = t.raw(LABEL[state]);
  const tone = CLOCK_TONE[state];
  return (
    <span role="img" aria-label={label} title={label} className="relative size-5 shrink-0">
      <span className="text-muted-foreground absolute inset-0 flex items-center justify-center [&_svg]:size-5">
        <ClockIcon />
      </span>
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 flex items-center justify-center [&_svg]:size-5',
          tone.reflection,
        )}
        style={{ maskImage: REFLECTION_MASK, WebkitMaskImage: REFLECTION_MASK }}
      >
        <ClockIcon />
      </span>
      {/* The toast's badge disc (`size-3`, −0.75 offset) holding Paper's plain dot. */}
      <span
        aria-hidden
        className={cn(
          'absolute -right-0.75 -bottom-0.75 flex size-3 items-center justify-center rounded-full',
          surface === 'row' ? 'bg-(--row-surface)' : surface,
        )}
      >
        <span className={cn('size-1.5 rounded-full', tone.dot)} />
      </span>
    </span>
  );
}
