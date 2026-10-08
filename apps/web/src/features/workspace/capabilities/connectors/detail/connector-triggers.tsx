'use client';

import type { AdminConnector } from '@kortix/sdk';
import { useProjectTriggerEventApps, useProjectTriggers } from '@kortix/sdk/react';
import { LightningIcon, PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  appConnectors,
  describeEventSource,
  describeEventStatus,
  eventTriggersOn,
} from '@/components/projects/schedule/event-trigger-copy';
import { ScheduleCreateModal } from '@/components/projects/schedule/schedule-create-modal';
import { triggerName } from '@/components/projects/schedule/schedule-copy';
import { useTriggerControls } from '@/components/projects/schedule/trigger-controls';
import { useTranslations } from '@/i18n/use-translations';

/**
 * App event triggers on this connector: the project's `type: event` triggers
 * whose connector is this one, each with its status and account, plus
 * "New app event" with this connector already picked. Renders nothing for a
 * connector whose app has no events.
 */
export function ConnectorTriggers({
  projectId,
  connector,
  displayName,
}: {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const apps = useProjectTriggerEventApps(projectId);
  const triggers = useProjectTriggers(projectId);
  const controls = useTriggerControls(projectId);
  const [creating, setCreating] = useState(false);

  const hasEvents = (apps.data?.apps ?? []).some((app) =>
    appConnectors(app).some((c) => c.slug === connector.slug),
  );
  if (!hasEvents || triggers.isError) return null;

  const rows = eventTriggersOn(triggers.data?.triggers ?? [], connector.slug);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{tI18nComplete.raw('textea56119b98e2')}</Label>
        {controls.canCreate ? (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1.5"
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="size-4 shrink-0" />
            {tI18nComplete.raw('text1ee2cf623464')}
          </Button>
        ) : null}
      </div>
      {triggers.isLoading ? (
        <Skeleton className="h-14 rounded-md" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs text-pretty">
          {tI18nComplete('text974e43358191', {
            name: displayName,
          })}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((trigger) => {
            const status = trigger.event
              ? trigger.enabled
                ? describeEventStatus(trigger.event, tI18nComplete)
                : null
              : null;
            return (
              <li
                key={trigger.slug}
                className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2"
              >
                <LightningIcon className="text-muted-foreground size-4 shrink-0" weight="fill" />
                <span className="min-w-0 flex-1">
                  <Link
                    href={`/projects/${projectId}/customize/triggers?t=${encodeURIComponent(trigger.slug)}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {triggerName(trigger)}
                  </Link>
                  {trigger.event ? (
                    <span className="text-muted-foreground block truncate text-xs">
                      {describeEventSource(trigger.event)}
                    </span>
                  ) : null}
                </span>
                <Badge variant={status ? status.variant : 'muted'} size="sm">
                  {status ? status.label : tI18nComplete.raw('texte159b06187d3')}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
      <ScheduleCreateModal
        projectId={projectId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => setCreating(false)}
        initialKind="event"
        initialConnector={{ slug: connector.slug, name: displayName }}
      />
    </section>
  );
}
