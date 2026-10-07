'use client';

/**
 * The detail-sheet panel for an App event trigger: which app and event it
 * listens to, whether the subscription is live, and its event config.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { errorToast, successToast } from '@/components/ui/toast';
import { type ProjectTrigger, type ProjectTriggerEvent, updateProjectTrigger } from '@kortix/sdk';
import { useProjectTriggerEventTypes } from '@kortix/sdk/react';
import { LinkIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import {
  appLabel,
  configProblem,
  configToDraft,
  connectorHref,
  describeEventStatus,
  draftToConfig,
  humanizeEventType,
  schemaFields,
} from './event-trigger-copy';
import { EventConfigForm } from './event-trigger-fields';
import { describeLastRun } from './schedule-copy';
import { PanelSection, PropertyList, SaveButton } from './schedule-fields';

/** The status banner at the top of the sheet: the error, or the next step. */
export function EventStatusBanner({
  projectId,
  event,
}: {
  projectId: string;
  event: ProjectTriggerEvent;
}) {
  const status = describeEventStatus(event);
  if (event.status === 'active' || event.status === 'pending') return null;
  return (
    <InfoBanner
      tone={event.status === 'error' ? 'destructive' : 'warning'}
      title={status.label}
      className="text-xs"
    >
      <span className="block">{status.detail}</span>
      {event.status === 'needs_connection' ? (
        <Button asChild size="sm" variant="outline" className="mt-2 w-fit gap-1.5">
          <Link href={connectorHref(projectId, event.connector)}>
            <LinkIcon className="size-3.5 shrink-0" />
            Connect account
          </Link>
        </Button>
      ) : null}
    </InfoBanner>
  );
}

export function EventPanel({
  projectId,
  trigger,
  event,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  event: ProjectTriggerEvent;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const types = useProjectTriggerEventTypes(projectId, event.connector);
  const eventType = types.data?.event_types.find((e) => e.type === event.type);
  const fields = useMemo(() => schemaFields(eventType?.config_schema), [eventType]);
  const saved = useMemo(() => configToDraft(fields, event.config), [fields, event.config]);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  const problem = configProblem(fields, draft);
  const dirty = fields.some((f) => (draft[f.key] ?? '') !== (saved[f.key] ?? ''));

  const save = useMutation({
    mutationFn: () =>
      updateProjectTrigger(projectId, trigger.slug, {
        event_config: draftToConfig(fields, draft),
      }),
    onSuccess: () => {
      successToast('Event settings saved');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Could not save the event settings'),
  });

  const status = describeEventStatus(event);
  const editable = canWrite && fields.length > 0;

  return (
    <PanelSection
      title="App event"
      description="This trigger starts when the event below happens."
      action={
        editable ? (
          <SaveButton
            dirty={dirty && !problem}
            pending={save.isPending}
            onSave={() => save.mutate()}
          />
        ) : null
      }
    >
      <PropertyList
        rows={[
          { label: 'App', value: appLabel(event.app, event.connector) },
          {
            label: 'Event',
            value: eventType?.name || humanizeEventType(event.type),
          },
          {
            label: 'Status',
            value: (
              <Badge variant={status.variant} size="sm">
                {status.label}
              </Badge>
            ),
          },
          { label: 'Last event', value: describeLastRun(event.last_event_at) },
        ]}
      />
      {editable ? (
        <div className="space-y-2 pt-1">
          <EventConfigForm fields={fields} draft={draft} onChange={setDraft} />
          {problem && dirty ? <p className="text-destructive text-xs">{problem}</p> : null}
        </div>
      ) : null}
    </PanelSection>
  );
}
