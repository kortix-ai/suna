'use client';

import { type ProjectTrigger, listProjectTriggerEventTypes } from '@kortix/sdk';

import { contract, projectTriggerEventTypesKey } from '@kortix/sdk/react';
import { useQueries } from '@tanstack/react-query';
import { type EventApp, appConnectors } from './event-trigger-copy';

/**
 * Event id -> the adapter's event name (`New Gmail Message`) for every connector
 * the listed event triggers run on. It reads the same cache entries as the
 * detail sheet and the composer, so each connector costs one request. While
 * the catalog loads, or when `enabled` is false, the map is empty and the list
 * falls back to the event id (`describeEventTitle`). Only connectors the event
 * catalog lists are asked for: an unknown connector would answer 404 and toast.
 */
export function useEventTitles(
  projectId: string,
  triggers: readonly ProjectTrigger[],
  enabled: boolean,
  catalog: readonly EventApp[] | undefined,
): ReadonlyMap<string, string> {
  const listed = new Set((catalog ?? []).flatMap((a) => appConnectors(a).map((c) => c.slug)));
  const connectors = [
    ...new Set(
      triggers.flatMap((t) =>
        t.event && listed.has(t.event.connector) ? [t.event.connector] : [],
      ),
    ),
  ];
  return useQueries({
    queries: connectors.map((connector) => ({
      queryKey: projectTriggerEventTypesKey(projectId, connector),
      queryFn: () => listProjectTriggerEventTypes(projectId, { connector }),
      enabled,
      ...contract('config'),
    })),
    combine: (results) =>
      new Map(
        results.flatMap((r) => (r.data?.event_types ?? []).map((e) => [e.type, e.name] as const)),
      ),
  });
}
