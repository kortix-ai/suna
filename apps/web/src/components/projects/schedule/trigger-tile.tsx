'use client';

/**
 * The leading mark of a trigger: the app's logo for an app event, a clock for
 * a schedule, the webhook mark for a webhook. It also carries the trigger's
 * state, so the list and the sheet need no Live or Paused badge.
 *
 * The glyph is drawn the way the trigger toast draws its entity icon
 * (`EntityTile` in `components/ui/toast.tsx`): bare and muted, then again in
 * the state's colour under the same radial mask, so the colour reaches in
 * from the corner. Paused draws the muted glyph alone; a paused app logo is
 * desaturated. The state is the image's accessible name.
 */

import { AppLogo } from '@/components/projects/onboarding/app-logo';
import { REFLECTION_MASK } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectTrigger } from '@kortix/sdk';
import { ClockIcon, WebhooksLogoIcon } from '@phosphor-icons/react';

import { type TriggerBadgeState, triggerBadgeState } from './schedule-copy';
import { LABEL_KEY } from './trigger-status-badge';

/** The toast's reflection tones, by trigger state. Paused has none. */
const TONE = {
  live: 'text-kortix-green',
  error: 'text-kortix-red',
  needs_connection: 'text-kortix-orange',
  pending: 'text-foreground',
  paused: null,
} as const satisfies Record<TriggerBadgeState, string | null>;

export function TriggerTile({
  trigger,
  logo,
  size = 'md',
}: {
  trigger: ProjectTrigger;
  /** The app's logo from the event catalog; null when the catalog does not have it. */
  logo: string | null;
  /** `md` (the toast's 20 px) beside a two-line row; `sm` in the sheet header. */
  size?: 'sm' | 'md';
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const state = triggerBadgeState(trigger);
  const label = t.raw(LABEL_KEY[state]);

  if (trigger.type === 'event') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn('inline-flex shrink-0', state === 'paused' && 'opacity-50 grayscale')}
      >
        <AppLogo src={logo} />
      </span>
    );
  }

  const Icon = trigger.type === 'cron' ? ClockIcon : WebhooksLogoIcon;
  const tone = TONE[state];
  const box = size === 'sm' ? 'size-4 [&_svg]:size-4' : 'size-5 [&_svg]:size-5';
  return (
    <span role="img" aria-label={label} title={label} className={cn('relative shrink-0', box)}>
      <span className="text-muted-foreground absolute inset-0 flex items-center justify-center">
        <Icon />
      </span>
      {tone ? (
        <span
          aria-hidden
          className={cn('absolute inset-0 flex items-center justify-center', tone)}
          style={{ maskImage: REFLECTION_MASK, WebkitMaskImage: REFLECTION_MASK }}
        >
          <Icon />
        </span>
      ) : null}
    </span>
  );
}
