'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectTrigger } from '@kortix/sdk';

import { type EventAppIndex, describeEventTitle, eventAppName } from './event-trigger-copy';
import { PropertyList } from './schedule-fields';

/**
 * When, for a saved event trigger whose app the catalog does not list: events
 * are off for the project, or the app is not served any more. The form cannot
 * rebuild the event pickers, so the saved choice is shown as it is stored.
 */
export function WhenEventSummary({
  trigger,
  apps,
  eventNames,
  loading,
}: {
  trigger: ProjectTrigger;
  apps: EventAppIndex;
  eventNames: ReadonlyMap<string, string>;
  loading: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const event = trigger.event;
  if (loading) return <Skeleton className="h-28 rounded-md" />;
  if (!event) return null;
  return (
    <div className="bg-popover rounded-md border px-4 py-4">
      <PropertyList
        rows={[
          { label: t.raw('text0d04bfeb7d64'), value: eventAppName(event, apps) },
          { label: t.raw('text4e1f49a9c8ae'), value: describeEventTitle(event, eventNames) },
          { label: t.raw('text8f0d706fff25'), value: event.connector },
          {
            label: t.raw('text7e1b0d5641f2'),
            value: event.account ?? event.connected_as ?? t.raw('text21b111cbfe6e'),
          },
        ]}
      />
    </div>
  );
}
