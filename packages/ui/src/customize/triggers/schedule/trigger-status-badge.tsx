'use client';

/**
 * The badge for a trigger state a person may need to act on: Needs
 * connection, Error, Setting up. Live and Paused draw no badge: the trigger's
 * icon carries them (`TriggerTile`), so the status is never shown twice.
 */

import { Badge } from '../../../primitives/badge';
import Hint from '../../../primitives/hint';
import { useTranslations } from '../../../i18n';
import type { ProjectTrigger } from '@kortix/sdk';

import { type TriggerBadgeState, triggerBadgeState } from './schedule-copy';

const VARIANT = {
  live: 'success',
  needs_connection: 'warning',
  error: 'destructive',
  pending: 'outline',
  paused: 'outline',
} as const;

export const LABEL_KEY = {
  live: 'textb64ac05f17e6',
  needs_connection: 'textd919fde889e9',
  error: 'text54a0e8c17ebb',
  pending: 'textdbdf27e5db8d',
  paused: 'texte159b06187d3',
} as const satisfies Record<TriggerBadgeState, string>;

export function TriggerStatusBadge({
  trigger,
  hint,
}: {
  trigger: ProjectTrigger;
  /** Why: the error text, shown on hover. It never takes a line of its own in a list. */
  hint?: string | null;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const state = triggerBadgeState(trigger);
  if (state === 'live' || state === 'paused') return null;
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
