'use client';

/**
 * Automations — schedules and webhooks, one flat list.
 *
 * Modelled on ux-references/chatgpt/04-scheduled.png, which has no cron UI at
 * all: a short description of the work, a cadence in plain language, and
 * suggestion rows you can add in one click. A raw cron expression never appears
 * in the default path; it lives under Advanced in the detail sheet, and only
 * auto-opens when an expression matches no preset.
 *
 * Replaces the schedules/webhooks table + two-step wizard. The detail sheet is
 * still the existing one — simplifying that is its own change.
 */

import { AlarmClockSolid, PlaySolid, TrashSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, Webhook } from 'lucide-react';
import { useMemo, useState } from 'react';

import { TriggerDetailSheet } from '@/components/projects/schedule-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  ProjectSectionPage,
  type ProjectSectionState,
} from '@/features/workspace/project-section/project-section-page';
import {
  ProjectSectionList,
  ProjectSectionRow,
} from '@/features/workspace/project-section/project-section-row';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type ProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggers,
  updateProjectTrigger,
} from '@kortix/sdk';

import { AutomationCreateModal } from './automation-create-modal';
import { describeCron, describeRunAt, getTriggerName, relativeTime } from './cron';

type Filter = 'all' | 'cron' | 'webhook';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'cron', label: 'Schedules' },
  { id: 'webhook', label: 'Webhooks' },
];

/** Plain-language cadence. Never a raw cron string. */
function cadenceOf(trigger: ProjectTrigger): string {
  if (trigger.type === 'webhook') return 'On webhook delivery';
  if (trigger.run_at) return describeRunAt(trigger.run_at);
  return trigger.cron ? describeCron(trigger.cron) : 'No schedule';
}

export function AutomationsView({
  projectId,
  initialFilter = 'all',
}: {
  projectId: string;
  initialFilter?: Filter;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE).allowed === true;
  const canRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_READ);

  const triggersQuery = useQuery({
    queryKey: ['project-triggers', projectId],
    queryFn: () => listProjectTriggers(projectId),
    enabled: !!projectId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['project-triggers', projectId] });

  const toggle = useMutation({
    mutationFn: ({ slug, enabled }: { slug: string; enabled: boolean }) =>
      updateProjectTrigger(projectId, slug, { enabled }),
    onSuccess: (_res, vars) => {
      successToast(vars.enabled ? 'Automation resumed' : 'Automation paused');
      invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to update'),
  });

  const fire = useMutation({
    mutationFn: (slug: string) => fireProjectTrigger(projectId, slug),
    onSuccess: () => {
      successToast('Automation run started');
      invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to run'),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => deleteProjectTrigger(projectId, slug),
    onSuccess: () => {
      successToast('Automation deleted');
      setSelectedSlug(null);
      invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to delete'),
  });

  const all = triggersQuery.data?.triggers ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((trigger) => {
      if (filter !== 'all' && trigger.type !== filter) return false;
      if (!q) return true;
      return (
        getTriggerName(trigger).toLowerCase().includes(q) ||
        cadenceOf(trigger).toLowerCase().includes(q)
      );
    });
  }, [all, filter, query]);

  const selected = all.find((trigger) => trigger.slug === selectedSlug) ?? null;

  const state: ProjectSectionState = (() => {
    if (canRead.allowed === false && !canRead.isLoading) return 'forbidden';
    if (triggersQuery.isLoading) return 'loading';
    if (triggersQuery.isError) return 'error';
    if (all.length === 0) return 'empty';
    if (filtered.length === 0) return 'no-results';
    return 'ready';
  })();

  return (
    <>
      <ProjectSectionPage
        title="Automations"
        description="Run work on a schedule, or when something happens elsewhere."
        search={{ value: query, onChange: setQuery, placeholder: 'Search automations' }}
        action={
          canWrite ? (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              New automation
            </Button>
          ) : null
        }
        filters={
          <div className="flex items-center gap-1">
            {FILTERS.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={filter === option.id ? 'secondary' : 'ghost'}
                onClick={() => setFilter(option.id)}
                className="rounded-full"
              >
                {option.label}
              </Button>
            ))}
          </div>
        }
        state={state}
        errorProps={{
          title: 'Could not load automations',
          description:
            triggersQuery.error instanceof Error
              ? triggersQuery.error.message
              : 'Could not load automations.',
        }}
        emptyProps={{
          icon: AlarmClockSolid,
          title: 'No automations yet',
          description: 'Have the agent do something on a schedule, or when an event arrives.',
          action: canWrite ? (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              New automation
            </Button>
          ) : undefined,
        }}
        noResultsMessage="No automations match that search."
      >
        <ProjectSectionList>
          {filtered.map((trigger) => {
            const isWebhook = trigger.type === 'webhook';
            const RowIcon = isWebhook ? Webhook : AlarmClockSolid;
            return (
              <ProjectSectionRow
                key={trigger.slug}
                dimmed={!trigger.enabled}
                onClick={() => setSelectedSlug(trigger.slug)}
                leading={
                  <RowIcon
                    className={cn(
                      'size-4',
                      // Green means running. The old table had this inverted:
                      // a paused trigger showed a green clock and an enabled
                      // one a red pause.
                      trigger.enabled ? 'text-kortix-green' : 'text-muted-foreground',
                    )}
                  />
                }
                title={getTriggerName(trigger)}
                badges={
                  trigger.enabled ? null : (
                    <Badge variant="outline" size="xs">
                      Paused
                    </Badge>
                  )
                }
                subtitle={
                  <>
                    {cadenceOf(trigger)}
                    {trigger.last_fired_at
                      ? ` · last run ${relativeTime(trigger.last_fired_at)}`
                      : ''}
                  </>
                }
                trailing={
                  <div className="flex items-center gap-1">
                    {canWrite ? (
                      <Switch
                        checked={trigger.enabled}
                        aria-label={trigger.enabled ? 'Pause automation' : 'Resume automation'}
                        onCheckedChange={(next) =>
                          toggle.mutate({ slug: trigger.slug, enabled: next })
                        }
                      />
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${getTriggerName(trigger)}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setSelectedSlug(trigger.slug)}>
                          Open
                        </DropdownMenuItem>
                        {canWrite ? (
                          <DropdownMenuItem onSelect={() => fire.mutate(trigger.slug)}>
                            <PlaySolid className="size-4" />
                            Run now
                          </DropdownMenuItem>
                        ) : null}
                        {canWrite ? (
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => remove.mutate(trigger.slug)}
                          >
                            <TrashSolid className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                }
              />
            );
          })}
        </ProjectSectionList>
      </ProjectSectionPage>

      <AutomationCreateModal
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(slug) => {
          setCreateOpen(false);
          setSelectedSlug(slug);
          invalidate();
        }}
      />

      <TriggerDetailSheet
        projectId={projectId}
        trigger={selected}
        canWrite={canWrite}
        open={!!selected}
        onOpenChange={(next) => {
          if (!next) setSelectedSlug(null);
        }}
        onDelete={() => {
          if (selected) remove.mutate(selected.slug);
        }}
        onMutated={invalidate}
      />
    </>
  );
}

export default AutomationsView;
