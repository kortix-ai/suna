import { errorToast, successToast } from '@/components/ui/toast';
import type { UiTranslator } from '@/i18n/translator';
import { softNavigate } from '@/lib/navigation/router-bridge';
import { projectSessionHref } from '@/lib/navigation/session-href';
import type { FireProjectTriggerResponse, ProjectTrigger } from '@kortix/sdk';
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
export function triggerRunActions(
  projectId: string,
  sessionId: string | null | undefined,
  label: string,
) {
  return sessionId
    ? [{ label, onClick: () => softNavigate(projectSessionHref(projectId, sessionId)) }]
    : undefined;
}

/** The toast a manual fire or a replay ends with, the same one Run now shows. */
export function fireResultToast(
  res: FireProjectTriggerResponse,
  trigger: Pick<ProjectTrigger, 'name' | 'type'>,
  projectId: string,
  t: UiTranslator,
) {
  const entity = triggerToastEntity(trigger);
  if (res.status === 'fired' || res.status === 'deduped') {
    successToast(t.raw('textecbc89cd37a0'), {
      entity,
      ...(res.session_id
        ? { actions: triggerRunActions(projectId, res.session_id, t.raw('textb205bb47f81a')) }
        : { description: t.raw('text747e9e0e8e92') }),
    });
  } else if (res.status === 'queued') {
    successToast(t.raw('text661ff40a07e0'), {
      entity,
      description: res.reason ?? t.raw('text17cf41bd6a6f'),
    });
  } else {
    errorToast(t.raw('text9c18cb990345'), { entity, description: res.error });
  }
}
