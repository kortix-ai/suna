'use client';

/**
 * What needs a person's action, above the sheet's form. A healthy trigger
 * shows nothing here: the callout appears only for a failed run, an event
 * trigger that needs a connection, an event trigger in error, or events being
 * off for the project.
 */

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { projectSettingsSectionHref } from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectTrigger } from '@kortix/sdk';
import { LinkIcon, PencilSimpleIcon, WarningCircleIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { type EventAppIndex, describeEventStatus, eventAppName } from './event-trigger-copy';
import { useEventAppConnect } from './use-event-app-connect';

export function TriggerCallouts({
  projectId,
  trigger,
  canEditEvent,
  eventsEnabled,
  apps,
  onEditEvent,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  /** The viewer may change the event, and the When block can show its pickers. */
  canEditEvent: boolean;
  eventsEnabled: boolean;
  apps: EventAppIndex;
  /** Jumps to the When block, where the event, connector and account are fixed. */
  onEditEvent: () => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tTriggers = useTranslations('triggers');
  const { connect, connecting, canConnect } = useEventAppConnect(projectId);
  const event = trigger.type === 'event' ? trigger.event : null;
  const app = event ? eventAppName(event, apps) : '';
  const status = event ? describeEventStatus(event, t, apps) : null;

  return (
    <>
      {trigger.last_status === 'failed' ? (
        <InfoBanner
          tone="destructive"
          icon={WarningCircleIcon}
          title={tTriggers('runFailed.label')}
          className="text-xs"
        >
          {trigger.last_error ? `${trigger.last_error} ` : ''}
          {tTriggers('runFailed.nextRun')}
        </InfoBanner>
      ) : null}

      {event && status && trigger.enabled && !eventsEnabled && event.status === 'error' ? (
        // A designed refusal, not a failure: a person can turn the feature on.
        <InfoBanner
          tone="warning"
          title={t.raw('text52f2077702ec')}
          className="text-xs"
        >
          <span className="block">{status.detail}</span>
          <Button asChild size="sm" variant="outline" className="mt-2 w-fit">
            <Link href={projectSettingsSectionHref(projectId, 'feature-flags')}>
              {t.raw('text20a2e59ba129')}
            </Link>
          </Button>
        </InfoBanner>
      ) : event && status && trigger.enabled && event.status === 'needs_connection' ? (
        <InfoBanner tone="warning" title={status.label} className="text-xs">
          <span className="block">{status.detail}</span>
          {canConnect ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 w-fit gap-1.5"
              disabled={Boolean(connecting)}
              onClick={() =>
                connect({
                  app: event.app ?? event.connector,
                  name: app,
                  connector: event.connector,
                })
              }
            >
              {connecting ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <LinkIcon className="size-3.5 shrink-0" />
              )}
              {connecting ? t.raw('textd403c686f6a1') : t('text4c012b6f97ca', { app })}
            </Button>
          ) : (
            <span className="mt-1 block">{t('textf665dfe82646', { app })}</span>
          )}
        </InfoBanner>
      ) : event && status && trigger.enabled && event.status === 'error' ? (
        <InfoBanner tone="destructive" title={status.label} className="text-xs">
          <span className="block wrap-anywhere">{status.detail}</span>
          {canEditEvent ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 w-fit gap-1.5"
              onClick={onEditEvent}
            >
              <PencilSimpleIcon className="size-3.5 shrink-0" />
              {t.raw('text84e071180ac2')}
            </Button>
          ) : null}
        </InfoBanner>
      ) : null}
    </>
  );
}
