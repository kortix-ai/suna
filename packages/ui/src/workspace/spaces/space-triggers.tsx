'use client';

import type { ProjectSpace, ProjectTrigger } from '@kortix/sdk';
import { qk, useProjectTriggers } from '@kortix/sdk/react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { describeWhen, triggerName, triggerSubtitle } from '../../customize/triggers/schedule/schedule-copy';
import { useTriggerControls } from '../../customize/triggers/schedule/trigger-controls';
import { TriggerComposer } from '../../customize/triggers/schedule/trigger-composer';
import { lastRunLabel } from '../../customize/triggers/schedule/trigger-list';
import { TriggerTile } from '../../customize/triggers/schedule/trigger-tile';
import { useLocale, useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Switch } from '../../primitives/switch';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink as Link } from '../../providers/ui-provider';

/**
 * A channel's or DM's Triggers tab: the project's triggers that post here
 * (`space_id`, filtered from the one trigger list every trigger surface
 * shares), each with its schedule, its last run and its on/off switch, and
 * "New trigger", which opens the trigger form posting here.
 */
export function SpaceTriggers({ projectId, space, place }: { projectId: string; space: ProjectSpace; place: string }) {
  const t = useTranslations('spaces.view');
  const queryClient = useQueryClient();
  const listing = useProjectTriggers(projectId);
  const controls = useTriggerControls(projectId);
  const [creating, setCreating] = useState(false);
  const triggers = listing.data?.triggers.filter((trigger) => trigger.space_id === space.space_id);

  const newButton = controls.canCreate ? (
    <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
      <PlusIcon aria-hidden />
      {t('empty.triggers.action')}
    </Button>
  ) : null;

  let body;
  if (listing.isError && !listing.data) {
    body = (
      <ErrorState
        size="sm"
        title={t('triggers.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => listing.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (!triggers) {
    body = null;
  } else if (triggers.length === 0) {
    body = (
      <EmptyState
        size="sm"
        title={t('empty.triggers.title')}
        description={t('empty.triggers.description', { place })}
        action={newButton}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {newButton ? <div className="flex justify-end">{newButton}</div> : null}
        <ul className="flex flex-col">
          {triggers.map((trigger) => (
            <TriggerRow
              key={trigger.slug}
              projectId={projectId}
              trigger={trigger}
              projectPaused={listing.data?.triggers_paused === true}
              canUpdate={controls.canUpdate}
              onToggle={(enabled) =>
                listing.update.mutateAsync({ slug: trigger.slug, input: { enabled } })
              }
            />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={triggers?.length ? 'px-5 py-4' : 'px-5 py-16'}>
      {body}
      <TriggerComposer
        projectId={projectId}
        open={creating}
        onOpenChange={setCreating}
        initialSpace={{ spaceId: space.space_id, kind: space.kind }}
        // A DM trigger runs the DM's agent (the API rejects any other).
        initialAgent={space.kind === 'dm' ? space.dm_agent_name : null}
        onCreated={() => {
          setCreating(false);
          void queryClient.invalidateQueries({ queryKey: qk.project.triggers(projectId) });
          void queryClient.invalidateQueries({ queryKey: qk.project.spaceSummaries(projectId) });
        }}
      />
    </div>
  );
}

/** One trigger: its clock, its name over its schedule, its last run, and its switch. The row opens the trigger. */
function TriggerRow({
  projectId,
  trigger,
  projectPaused,
  canUpdate,
  onToggle,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  projectPaused: boolean;
  canUpdate: boolean;
  onToggle: (enabled: boolean) => Promise<unknown>;
}) {
  const tTriggers = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const name = triggerName(trigger);
  const subtitle = triggerSubtitle(name, describeWhen(trigger), trigger.prompt_template);
  // An auto-paused trigger is off until resumed: turning it on sends `enabled: true`, which resumes it.
  const active = trigger.enabled && !trigger.auto_paused_at;
  const href = uiRoutes().customize(projectId, `triggers?id=${encodeURIComponent(trigger.slug)}`);

  const toggle = (enabled: boolean) => {
    setPending(true);
    onToggle(enabled)
      .then(() => successToast(enabled ? tTriggers.raw('texta97d32ddb6ba') : tTriggers.raw('texte159b06187d3')))
      .catch((err: unknown) =>
        errorToast(err instanceof Error ? err.message : tTriggers.raw('text43ec39943667')),
      )
      .finally(() => setPending(false));
  };

  return (
    <li className="group hover:bg-hover relative -mx-2 flex items-center gap-3 rounded-md px-2 py-2">
      <span className="flex size-5 shrink-0 items-center justify-center">
        <TriggerTile trigger={trigger} projectPaused={projectPaused} />
      </span>
      <div className="min-w-0 flex-1">
        {href ? (
          <Link
            href={href}
            className="focus-visible:ring-ring block truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-md focus-visible:ring-2"
          >
            {name}
          </Link>
        ) : (
          <p className="truncate text-sm font-medium">{name}</p>
        )}
        {subtitle ? <p className="text-muted-foreground truncate text-xs">{subtitle}</p> : null}
      </div>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{lastRunLabel(trigger, tTriggers, locale)}</span>
      <Switch
        checked={active}
        onCheckedChange={toggle}
        disabled={!canUpdate || pending}
        aria-label={name}
        // Above the row's stretched link.
        className="relative z-10"
      />
    </li>
  );
}
