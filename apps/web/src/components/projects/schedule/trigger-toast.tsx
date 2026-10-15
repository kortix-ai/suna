import { softNavigate } from '@/lib/navigation/router-bridge';
import { projectSessionHref } from '@/lib/navigation/session-href';
import type { ProjectTrigger } from '@kortix/sdk';
import { ClockIcon, LightningIcon, PulseIcon, WebhooksLogoIcon } from '@phosphor-icons/react';

/**
 * The entity row a trigger toast carries: the kind's glyph and the trigger's
 * name ("Trigger created / ⏱ Weekly revenue digest · Mon 9:00 / View").
 * A schedule is a clock; the other kinds keep their list glyph.
 */
const TRIGGER_TOAST_ICON = {
  cron: ClockIcon,
  webhook: WebhooksLogoIcon,
  monitor: PulseIcon,
  event: LightningIcon,
} as const;

export function triggerToastEntity(
  trigger: Pick<ProjectTrigger, 'name' | 'type'>,
  detail?: string,
) {
  const Icon = TRIGGER_TOAST_ICON[trigger.type] ?? ClockIcon;
  return {
    icon: <Icon className="size-3.5" />,
    label: detail ? `${trigger.name} · ${detail}` : trigger.name,
  };
}

/** The "Open session" action a started run offers, when the run has a session. */
export function triggerRunActions(projectId: string, sessionId: string | null | undefined, label: string) {
  return sessionId
    ? [{ label, onClick: () => softNavigate(projectSessionHref(projectId, sessionId)) }]
    : undefined;
}
