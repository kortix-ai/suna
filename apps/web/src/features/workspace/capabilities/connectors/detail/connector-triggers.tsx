'use client';

import type { AdminConnector } from '@kortix/sdk';
import { useProjectTriggerEventApps, useProjectTriggers } from '@kortix/sdk/react';
import { PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

import {
  appConnectors,
  describeEventSource,
  eventTriggersOn,
  indexEventApps,
} from '@/components/projects/schedule/event-trigger-copy';
import { describeWhen, triggerName } from '@/components/projects/schedule/schedule-copy';
import { TriggerComposer } from '@/components/projects/schedule/trigger-composer';
import { useTriggerControls } from '@/components/projects/schedule/trigger-controls';
import { TriggerStatusBadge } from '@/components/projects/schedule/trigger-status-badge';
import { TriggerTile } from '@/components/projects/schedule/trigger-tile';
import { useEventTitles } from '@/components/projects/schedule/use-event-titles';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { useProjectFeatureFlags } from '@/lib/use-project-feature-flags';

/**
 * Whether the connector's app has events, and the project's event triggers on it.
 * Shared by the tab and its count. With the project flag `event_triggers` off,
 * the connector has no events: the tab is absent and no event data is requested.
 */
export function useConnectorEventTriggers(projectId: string, connector: AdminConnector) {
  const eventsOn = useProjectFeatureFlags(projectId).flags.event_triggers === true;
  const apps = useProjectTriggerEventApps(eventsOn ? projectId : null);
  const triggers = useProjectTriggers(projectId);
  const hasEvents =
    eventsOn &&
    (apps.data?.apps ?? []).some((app) =>
      appConnectors(app).some((c) => c.slug === connector.slug),
    );
  return {
    hasEvents,
    apps: apps.data?.apps,
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
  const { rows, apps, isLoading, isError } = useConnectorEventTriggers(projectId, connector);
  const appIndex = indexEventApps(apps);
  const eventNames = useEventTitles(projectId, rows, true, apps);
  const controls = useTriggerControls(projectId);
  const [creating, setCreating] = useState(false);
  if (isError) return null;

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
      {isLoading ? (
        <Skeleton className="h-14 rounded-md" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs text-pretty">
          {tI18nComplete('text974e43358191', {
            name: displayName,
          })}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((trigger) => (
            <li
              key={trigger.slug}
              className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2"
            >
              <TriggerTile
                trigger={trigger}
                logo={appIndex.get(trigger.event?.app ?? connector.slug)?.logo ?? null}
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <Link
                    href={`/projects/${projectId}/customize/triggers?t=${encodeURIComponent(trigger.slug)}`}
                    className="min-w-0 truncate text-sm font-medium hover:underline"
                  >
                    {triggerName(trigger)}
                  </Link>
                  <TriggerStatusBadge trigger={trigger} hideLive />
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {describeWhen(trigger, eventNames)}
                </span>
                {trigger.event ? (
                  <span className="text-muted-foreground block truncate text-xs">
                    {describeEventSource(trigger.event, tI18nComplete, appIndex)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <TriggerComposer
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
