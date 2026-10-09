'use client';

import type { AdminConnector } from '@kortix/sdk';
import { useProjectTriggerEventApps, useProjectTriggers } from '@kortix/sdk/react';
import { LightningIcon, PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

import {
  appConnectors,
  describeEventSource,
  describeEventStatus,
  eventTriggersOn,
} from '@/components/projects/schedule/event-trigger-copy';
import { triggerName } from '@/components/projects/schedule/schedule-copy';
import { ScheduleCreateModal } from '@/components/projects/schedule/schedule-create-modal';
import { useTriggerControls } from '@/components/projects/schedule/trigger-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';

/** Whether the connector's app has events, and the project's event triggers on it. Shared by the tab and its count. */
export function useConnectorEventTriggers(projectId: string, connector: AdminConnector) {
  const apps = useProjectTriggerEventApps(projectId);
  const triggers = useProjectTriggers(projectId);
  const hasEvents = (apps.data?.apps ?? []).some((app) =>
    appConnectors(app).some((c) => c.slug === connector.slug),
  );
  return {
    hasEvents,
    rows: eventTriggersOn(triggers.data?.triggers ?? [], connector.slug),
    isLoading: triggers.isLoading,
    isError: triggers.isError,
  };
}

/**
 * App event triggers on this connector: the project's `type: event` triggers
 * whose connector is this one, each with its status and account, plus
 * "New app event" with this connector already picked. It is the body of the
 * connector modal's Triggers tab, which shows only for an app with events.
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
  const t = useTranslations('connectorPages');
  const { rows, isLoading, isError } = useConnectorEventTriggers(projectId, connector);
  const controls = useTriggerControls(projectId);
  const [creating, setCreating] = useState(false);
  if (isError) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{tI18nComplete.raw('textea56119b98e2')}</Label>
          <p className="text-muted-foreground text-xs text-pretty">
            {t('triggersHelp', { name: displayName })}
          </p>
        </div>
        {controls.canCreate ? (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="size-4 shrink-0" />
            {tI18nComplete.raw('text1ee2cf623464')}
          </Button>
        ) : null}
      </div>
      {isLoading ? (
        <Skeleton className="h-14 rounded-md" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-4 py-3 text-xs text-pretty">
          {tI18nComplete('text974e43358191', {
            name: displayName,
          })}
        </p>
      ) : (
        <ul className="bg-popover divide-border divide-y rounded-md border">
          {rows.map((trigger) => {
            const status = trigger.event
              ? trigger.enabled
                ? describeEventStatus(trigger.event, tI18nComplete)
                : null
              : null;
            return (
              <li key={trigger.slug} className="flex items-center gap-3 px-4 py-3">
                <span
                  aria-hidden
                  className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md"
                >
                  <LightningIcon className="size-4" weight="fill" />
                </span>
                <span className="min-w-0 flex-1">
                  <Link
                    href={`/projects/${projectId}/customize/triggers?t=${encodeURIComponent(trigger.slug)}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {triggerName(trigger)}
                  </Link>
                  {trigger.event ? (
                    <span className="text-muted-foreground block truncate text-xs">
                      {describeEventSource(trigger.event, tI18nComplete)}
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
