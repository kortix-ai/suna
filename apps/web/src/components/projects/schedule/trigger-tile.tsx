'use client';

/** The leading tile of a trigger: the app's logo, a clock for a schedule, the webhook mark for a webhook. */

import { AppLogo } from '@/components/projects/onboarding/app-logo';
import type { ProjectTrigger } from '@kortix/sdk';
import { ClockIcon, WebhooksLogoIcon } from '@phosphor-icons/react';

export function TriggerTile({
  trigger,
  logo,
}: {
  trigger: Pick<ProjectTrigger, 'type'>;
  /** The app's logo from the event catalog; null when the catalog does not have it. */
  logo: string | null;
}) {
  if (trigger.type === 'event') return <AppLogo src={logo} />;
  const Icon = trigger.type === 'cron' ? ClockIcon : WebhooksLogoIcon;
  return (
    <span
      aria-hidden
      className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-sm"
    >
      <Icon className="size-3.5" />
    </span>
  );
}
