'use client';

/**
 * The detail-sheet panel for an App event trigger: which app and event it
 * listens to, whether the subscription is live, and its event config.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type ProjectTrigger,
  type ProjectTriggerEvent,
  type ProjectTriggerEventType,
  updateProjectTrigger,
} from '@kortix/sdk';
import { useProjectTriggerEventTypes } from '@kortix/sdk/react';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { LinkIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  appLabel,
  configProblem,
  configToDraft,
  defaultConfigDraft,
  describeEventStatus,
  draftToConfig,
  humanizeEventType,
  parseConfigErrors,
  schemaFields,
} from './event-trigger-copy';
import { EventConfigForm, EventTypePicker } from './event-trigger-fields';
import { describeLastRun } from './schedule-copy';
import { PanelSection, PropertyList, SaveButton } from './schedule-fields';
import { useEventAppConnect } from './use-event-app-connect';

/** The settings section's id: the banner's "Edit settings" jumps to it. */
const EVENT_PANEL_ID = 'event-panel';

function focusEventSettings() {
  const panel = document.getElementById(EVENT_PANEL_ID);
  panel?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  panel?.querySelector<HTMLElement>('input, textarea, button[role="combobox"]')?.focus();
}

/** The status banner at the top of the sheet: the error, or the next step with a way to take it. */
export function EventStatusBanner({
  projectId,
  event,
  canWrite,
}: {
  projectId: string;
  event: ProjectTriggerEvent;
  canWrite: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const { connect, connecting, canConnect } = useEventAppConnect(projectId);
  const status = describeEventStatus(event, tI18nComplete);
  if (event.status === 'active' || event.status === 'pending') return null;
  const app = appLabel(event.app, event.connector);
  return (
    <InfoBanner
      tone={event.status === 'error' ? 'destructive' : 'warning'}
      title={status.label}
      className="text-xs"
    >
      <span className="block">{status.detail}</span>
      {event.status === 'needs_connection' ? (
        canConnect ? (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 w-fit gap-1.5"
            disabled={Boolean(connecting)}
            onClick={() =>
              connect({ app: event.app ?? event.connector, name: app, connector: event.connector })
            }
          >
            {connecting ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <LinkIcon className="size-3.5 shrink-0" />
            )}
            {connecting ? tI18nComplete.raw('textd403c686f6a1') : tI18nComplete('text4c012b6f97ca', { app })}
          </Button>
        ) : (
          <span className="mt-1 block">
            {tI18nComplete('textf665dfe82646', { app })}
          </span>
        )
      ) : canWrite ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-fit gap-1.5"
          onClick={focusEventSettings}
        >
          <PencilSimpleIcon className="size-3.5 shrink-0" />
          {tI18nComplete.raw('text84e071180ac2')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const types = useProjectTriggerEventTypes(projectId, event.connector);
  // A different event picked in this sheet, not saved yet.
  const [picked, setPicked] = useState<ProjectTriggerEventType | null>(null);
  const [changing, setChanging] = useState(false);
  const eventType =
    picked ?? types.data?.event_types.find((e) => e.type === event.type) ?? null;
  const fields = useMemo(() => schemaFields(eventType?.config_schema), [eventType]);
  const saved = useMemo(
    () => (picked ? defaultConfigDraft(fields) : configToDraft(fields, event.config)),
    [fields, event.config, picked],
  );
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setDraft(saved), [saved]);

  const problem = configProblem(fields, draft);
  const dirty = picked !== null || fields.some((f) => (draft[f.key] ?? '') !== (saved[f.key] ?? ''));

  const save = useMutation({
    mutationFn: () =>
      updateProjectTrigger(projectId, trigger.slug, {
        ...(picked ? { event: picked.type } : {}),
        event_config: draftToConfig(fields, draft),
      }),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text3eb5eb8d3b9f'));
      setErrors({});
      onMutated();
    },
    onError: (e: Error) => {
      const { byField, general } = parseConfigErrors(e.message, fields);
      setErrors(byField);
      if (Object.keys(byField).length === 0 || general) {
        errorToast(general ?? (e.message || tI18nComplete.raw('text7059c821b301')));
      }
    },
  });

  const status = describeEventStatus(event, tI18nComplete);
  const editable = canWrite && (fields.length > 0 || Boolean(picked));

  return (
    <PanelSection
      id={EVENT_PANEL_ID}
      title={tI18nComplete.raw('text5441e7146193')}
      description={tI18nComplete.raw('text1e8912d0e0fa')}
      action={
        canWrite ? (
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
          { label: tI18nComplete.raw('text0d04bfeb7d64'), value: appLabel(event.app, event.connector) },
          {
            label: tI18nComplete.raw('text4e1f49a9c8ae'),
            value: eventType?.name || humanizeEventType(picked?.type ?? event.type),
          },
          {
            label: tI18nComplete.raw('text920e413c7d41'),
            value: (
              <Badge variant={status.variant} size="sm">
                {status.label}
              </Badge>
            ),
          },
          { label: tI18nComplete.raw('texta76d8716b0ff'), value: describeLastRun(event.last_event_at) },
        ]}
      />
      {canWrite ? (
        changing ? (
          <div className="space-y-2 pt-1">
            <EventTypePicker
              projectId={projectId}
              connector={event.connector}
              value={picked?.type ?? event.type}
              onChange={(next) => {
                setPicked(next.type === event.type ? null : next);
                setChanging(false);
                setErrors({});
              }}
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => setChanging(false)}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => setChanging(true)}
          >
            {tI18nComplete.raw('text066087493b4e')}
          </Button>
        )
      ) : null}
      {editable ? (
        <div className="space-y-2 pt-1">
          <EventConfigForm
            fields={fields}
            draft={draft}
            errors={errors}
            onChange={(next) => {
              setDraft(next);
              setErrors({});
            }}
          />
          {problem && dirty ? <p className="text-destructive text-xs">{problem}</p> : null}
        </div>
      ) : null}
    </PanelSection>
  );
}
