'use client';

import { useTriggerMutations } from '../triggers/schedule/use-trigger-mutations';

import { useTranslations as useI18nTranslations } from '../../i18n';
/**
 * The Triggers section of the agent page — every project trigger that starts
 * THIS agent, and the way to add one.
 *
 * A trigger is a project resource that names an agent (`trigger.agent`, the
 * manifest key). The Triggers tab lists them all; this section is the same
 * list filtered to one agent, because "when does this agent run on its own?"
 * is a question about the agent, and the person configuring one should not
 * have to leave its page to answer it. Creating one here opens the same
 * wizard the Triggers tab opens, with the agent pre-selected.
 *
 * A row opens the same detail sheet the Triggers tab opens
 * (`schedule/schedule-detail-sheet.tsx`), in place — run, pause, edit and
 * delete without leaving the agent (Marko, 2026-09-03). The sheet owns
 * pause/resume itself; run and delete are the two mutations it asks its host
 * for, so this section carries the same two the Triggers tab does, against
 * the same query key, so a run started here shows up there.
 */

import {
  describeWhen,
  isTriggerKind,
  KIND_COPY,
  triggerName,
  type TriggerKind,
} from '../triggers/schedule/schedule-copy';
import { ScheduleDetailSheet } from '../triggers/schedule/schedule-detail-sheet';
import { TriggerComposer } from '../triggers/schedule/trigger-composer';
import { useTriggerControls } from '../triggers/schedule/trigger-controls';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { Skeleton } from '../../primitives/skeleton';
import { EmptyState } from '../../primitives/empty-state';
import { EditorList, EditorSection } from '../sections/view/agent-editor-primitives';
import { useProjectFeatureFlags } from '../../internal/lib/use-project-feature-flags';
import { cn } from '../../internal/lib/utils';
import { listProjectTriggers, type ProjectTrigger } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  AppWindowIcon,
  LightningIcon,
  PlusIcon,
  PulseIcon,
  TimerIcon,
  WebhooksLogoIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

const KIND_ICON: Record<ProjectTrigger['type'], Icon> = {
  cron: TimerIcon,
  webhook: WebhooksLogoIcon,
  monitor: PulseIcon,
  event: LightningIcon,
  app: AppWindowIcon,
};

/**
 * Whether `trigger` starts `agentName`. A trigger that names no agent is
 * stored as `default` (the manifest sentinel, `apps/api/src/projects/lib/
 * triggers.ts`), which means "the project's default agent" — so the default
 * agent's page owns those rows too, or a trigger created with the agent left
 * on its default would show up nowhere.
 */
export function triggerStartsAgent(
  trigger: Pick<ProjectTrigger, 'agent'>,
  agentName: string,
  defaultAgent: string | null | undefined,
): boolean {
  if (trigger.agent === agentName) return true;
  return trigger.agent === 'default' && !!defaultAgent && defaultAgent === agentName;
}

/** The triggers that start `agentName`, in the order the API lists them. */
export function triggersForAgent(
  triggers: readonly ProjectTrigger[],
  agentName: string,
  defaultAgent: string | null | undefined = null,
): ProjectTrigger[] {
  return triggers.filter((trigger) => triggerStartsAgent(trigger, agentName, defaultAgent));
}

export function AgentTriggersSection({
  projectId,
  agentName,
  defaultAgent,
}: {
  projectId: string;
  agentName: string;
  /** The project's default agent name — see `triggerStartsAgent`. */
  defaultAgent?: string | null;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  // One leaf per control, the same as on the Triggers page (KRTX-1720).
  const controls = useTriggerControls(projectId);
  const eventsOn = useProjectFeatureFlags(projectId).flags.event_triggers === true;
  const canCreate = controls.canCreate;
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTrigger | null>(null);
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.project.triggers(projectId) }),
    [queryClient, projectId],
  );

  // Same key and fetcher as the Triggers tab, so a trigger created there shows
  // here on the next focus without a second cache to reconcile.
  const triggersQuery = useQuery({
    queryKey: qk.project.triggers(projectId),
    queryFn: () => listProjectTriggers(projectId),
    ...contract('config'),
  });
  const mine = useMemo(
    () => triggersForAgent(triggersQuery.data?.triggers ?? [], agentName, defaultAgent),
    [triggersQuery.data, agentName, defaultAgent],
  );
  const selected = mine.find((t) => t.slug === selectedSlug) ?? null;

  // The same two mutations the Triggers tab owns, against the same key.
  const { run, remove } = useTriggerMutations({
    projectId,
    invalidate,
    runFailureKey: 'textfc56800b00af',
    deletedNoun: (trigger) =>
      isTriggerKind(trigger.type) ? KIND_COPY[trigger.type as TriggerKind].noun : 'trigger',
    onRemoved: () => {
      setDeleteTarget(null);
      setSelectedSlug(null);
    },
  });
  return (
    <EditorSection
      title={tI18nComplete.raw('texte62f2148a64d')}
      description={tI18nComplete.raw('text1a1e4d549e85')}
      trailing={
        canCreate ? (
          <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            {tI18nComplete.raw('text58fd308928dd')}
          </Button>
        ) : undefined
      }
      lead
      bare
    >
      <div>
        {triggersQuery.isLoading ? (
          <EditorList>
            {[0, 1].map((i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="size-8 rounded-sm" />
                <Skeleton className="h-4 w-40 rounded-sm" />
              </li>
            ))}
          </EditorList>
        ) : mine.length === 0 ? (
          <EmptyState size="sm" title={tI18nComplete.raw('textb254c6e02e1a')} />
        ) : (
          <EditorList>
            {mine.map((trigger) => {
              const KindIcon = KIND_ICON[trigger.type] ?? TimerIcon;
              return (
                <li key={trigger.slug}>
                  <button
                    type="button"
                    onClick={() => setSelectedSlug(trigger.slug)}
                    className={cn(
                      'hover:bg-hover flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-fast',
                      'focus-visible:bg-hover focus-visible:outline-none',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-sm',
                        trigger.enabled ? 'bg-kortix-green/15' : 'bg-muted',
                      )}
                    >
                      <KindIcon
                        weight="fill"
                        className={cn(
                          'size-4',
                          trigger.enabled ? 'text-kortix-green' : 'text-muted-foreground',
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {triggerName(trigger)}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {describeWhen(trigger)}
                      </span>
                    </span>
                    {!trigger.enabled ? (
                      <Badge variant="muted" size="xs">
                        {tI18nComplete.raw('texte159b06187d3')}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </EditorList>
        )}
      </div>

      {canCreate ? (
        <TriggerComposer
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialAgent={agentName}
          onCreated={(slug) => {
            setCreateOpen(false);
            void invalidate();
            // The composer toasts the creation; straight into the new entry, as the Triggers tab does.
            setSelectedSlug(slug);
          }}
        />
      ) : null}

      <ScheduleDetailSheet
        projectId={projectId}
        trigger={selected}
        controls={controls}
        open={!!selected}
        onOpenChange={(next) => {
          if (!next) setSelectedSlug(null);
        }}
        onRun={() => selected && run.mutate(selected)}
        running={run.isPending && run.variables?.slug === selected?.slug}
        onDelete={() => selected && setDeleteTarget(selected)}
        onMutated={invalidate}
        eventsEnabled={eventsOn}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title={tI18nComplete.raw('text08a462df4350')}
        description={
          deleteTarget ? (
            <>
              <span className="text-foreground font-medium">{triggerName(deleteTarget)}</span> (
              {describeWhen(deleteTarget).toLowerCase()}
              {tI18nComplete.raw('text3109205d1fc7')}
            </>
          ) : undefined
        }
        confirmLabel={tI18nComplete.raw('texte2d0a54968ea')}
        confirmVariant="destructive"
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </EditorSection>
  );
}
