'use client';

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

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ScheduleCreateModal } from '@/components/projects/schedule/schedule-create-modal';
import {
  KIND_COPY,
  type TriggerKind,
  describeWhen,
  isTriggerKind,
  triggerName,
} from '@/components/projects/schedule/schedule-copy';
import { ScheduleDetailSheet } from '@/components/projects/schedule/schedule-detail-sheet';
import { EditorSection } from '@/features/workspace/customize/sections/view/agent-editor-primitives';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggers,
  type ProjectTrigger,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { PlusIcon, PulseIcon, TimerIcon, WebhooksLogoIcon, type Icon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

const KIND_ICON: Record<ProjectTrigger['type'], Icon> = {
  cron: TimerIcon,
  webhook: WebhooksLogoIcon,
  monitor: PulseIcon,
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
  const queryClient = useQueryClient();
  const canCreate =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE).allowed === true;
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE).allowed === true;
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
  const run = useMutation({
    mutationFn: (trigger: ProjectTrigger) => fireProjectTrigger(projectId, trigger.slug),
    onSuccess: (res) => {
      if (res.status === 'fired') {
        successToast('Started', {
          description: res.session_id
            ? `Session ${res.session_id.slice(0, 8)}…`
            : 'Getting a session ready',
        });
      } else if (res.status === 'queued') {
        successToast('Queued', { description: res.reason ?? 'Busy right now — it will retry' });
      } else {
        errorToast('It could not start', { description: res.error });
      }
      void invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'It could not start'),
  });
  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) => deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: (_data, trigger) => {
      const noun = isTriggerKind(trigger.type) ? KIND_COPY[trigger.type as TriggerKind].noun : 'trigger';
      successToast(`${noun[0].toUpperCase()}${noun.slice(1)} deleted`);
      setDeleteTarget(null);
      setSelectedSlug(null);
      void invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Could not delete it'),
  });

  return (
    <EditorSection title="Triggers" description="When this agent starts on its own.">
      <div className="space-y-3 py-3.5">
        {triggersQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
          </div>
        ) : mine.length === 0 ? (
          <p className="text-muted-foreground text-xs text-pretty">
            Nothing starts this agent automatically yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {mine.map((trigger) => {
              const KindIcon = KIND_ICON[trigger.type] ?? TimerIcon;
              return (
                <li key={trigger.slug}>
                  <button
                    type="button"
                    onClick={() => setSelectedSlug(trigger.slug)}
                    className={cn(
                      'group bg-popover flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left',
                      'hover:border-border transition-[background-color,border-color] hover:bg-accent',
                      'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
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
                        Paused
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {canCreate ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon className="size-3.5 shrink-0" />
            Add trigger
          </Button>
        ) : null}
      </div>

      {canCreate ? (
        <ScheduleCreateModal
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialAgent={agentName}
          onCreated={(slug) => {
            setCreateOpen(false);
            void invalidate();
            successToast('Trigger created');
            // Straight into the new entry, as the Triggers tab does.
            setSelectedSlug(slug);
          }}
        />
      ) : null}

      <ScheduleDetailSheet
        projectId={projectId}
        trigger={selected}
        canWrite={canWrite}
        open={!!selected}
        onOpenChange={(next) => {
          if (!next) setSelectedSlug(null);
        }}
        onRun={() => selected && run.mutate(selected)}
        running={run.isPending && run.variables?.slug === selected?.slug}
        onDelete={() => selected && setDeleteTarget(selected)}
        onMutated={invalidate}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title="Delete this trigger?"
        description={
          deleteTarget ? (
            <>
              <span className="text-foreground font-medium">{triggerName(deleteTarget)}</span> (
              {describeWhen(deleteTarget).toLowerCase()}) stops running and is removed.
            </>
          ) : undefined
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </EditorSection>
  );
}
