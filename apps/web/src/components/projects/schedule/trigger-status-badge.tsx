'use client';

/**
 * The one status badge of a trigger: Live, Needs connection, Error, Setting up
 * or Paused, in sentence case, from one mapping (`triggerBadgeState`). The
 * list, the detail sheet and the connector tab all render this and nothing
 * else for a trigger's status.
 */

import { Badge } from '@/components/ui/badge';
import Hint from '@/components/ui/hint';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectTrigger } from '@kortix/sdk';

import { type TriggerBadgeState, triggerBadgeState } from './schedule-copy';

const VARIANT = {
  live: 'success',
  needs_connection: 'warning',
  error: 'destructive',
  pending: 'outline',
  paused: 'outline',
} as const;

const LABEL_KEY = {
  live: 'textb64ac05f17e6',
  needs_connection: 'textd919fde889e9',
  error: 'text54a0e8c17ebb',
  pending: 'textdbdf27e5db8d',
  paused: 'texte159b06187d3',
} as const satisfies Record<TriggerBadgeState, string>;

export function TriggerStatusBadge({
  trigger,
  hideLive = false,
  hint,
}: {
  trigger: ProjectTrigger;
  /** A calm list shows nothing for a healthy trigger. */
  hideLive?: boolean;
  /** Why: the error text, shown on hover. It never takes a line of its own in a list. */
  hint?: string | null;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const state = triggerBadgeState(trigger);
  if (state === 'live' && hideLive) return null;
  // `font-sans normal-case`: the badge base is mono uppercase, which reads as code, not status.
  const badge = (
    <Badge variant={VARIANT[state]} size="sm" className="font-sans normal-case">
      {t.raw(LABEL_KEY[state])}
    </Badge>
  );
  return hint ? (
    <Hint label={hint} side="top" className="max-w-72 text-pretty">
      {badge}
    </Hint>
  ) : (
    badge
  );
}
