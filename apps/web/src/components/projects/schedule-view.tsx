'use client';

/**
 * Schedules and Webhooks — the two screens behind `settings-panel.tsx`.
 *
 * One component serves both: `type="cron"` renders Schedules, `type="webhook"`
 * renders Webhooks. They share a list, a detail panel, and a create flow, so
 * the wording for each lives in `schedule/schedule-copy.ts` rather than being
 * branched inline in the markup.
 *
 * The list, panel, and create flow live in `./schedule/*`; this file owns the
 * data, the permissions, and the mutations the row actions and the panel both
 * fire, so a pause started from a row and a pause started from the panel are
 * the same code path.
 */

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  type ProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  getProject,
  listProjectTriggers,
  setProjectTriggersActivation,
  updateProjectTrigger,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  LockKeyIcon,
  PlusIcon,
  MagnifyingGlassIcon as SearchIcon,
  TimerIcon,
  WarningIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import {
  KIND_COPY,
  type TriggerKind,
  describeWhen,
  matchesQuery,
  triggerName,
} from './schedule/schedule-copy';
import { ScheduleCreateModal } from './schedule/schedule-create-modal';
import { ScheduleDetailSheet } from './schedule/schedule-detail-sheet';
import { ScheduleTable } from './schedule/schedule-table';

/**
 * Pure — no hooks, no data fetching. Renders the pause switch for a MANAGER
 * only; returns `null` for anyone else. Split out from
 * {@link TriggersActivationCard} (its data-fetching container, below) purely
 * so this gate is testable under `renderToStaticMarkup` — apps/web has no DOM
 * testing library (no jsdom, no `@testing-library/react`), so a pure component
 * taking `canManage` as a prop is the only way `schedule-view.test.tsx` can pin
 * "an editor doesn't see this" without a live QueryClient. See
 * {@link TriggersActivationCard}'s header comment for why `canManage` here is
 * deliberately NOT `ScheduleView`'s own `canWrite`.
 */
export function TriggerPauseSwitch({
  canManage,
  paused,
  isPending,
  onToggle,
}: {
  canManage: boolean;
  paused: boolean;
  isPending: boolean;
  onToggle: (next: boolean) => void;
}) {
  if (!canManage) return null;

  return (
    <Field orientation="horizontal" className="bg-popover rounded-md border px-4 py-3">
      <FieldContent>
        <FieldTitle>
          Pause all schedules and webhooks
          {paused && <span className="text-muted-foreground font-normal"> · paused</span>}
        </FieldTitle>
        <FieldDescription>
          Stops this project running any schedule or webhook on its own. You can still start one by
          hand. Useful when another environment is meant to be doing the work.
        </FieldDescription>
      </FieldContent>
      <Switch
        checked={paused}
        disabled={isPending}
        onCheckedChange={onToggle}
        aria-label="Pause every schedule and webhook in this project"
      />
    </Field>
  );
}

/**
 * Project-wide "pause everything" switch — rendered on Schedules only (see
 * {@link ScheduleView}'s call site), since it needs exactly one home.
 *
 * **Access gate — deliberately NOT `canWrite`, on purpose, do not merge
 * them.** `ScheduleView` below computes a `canWrite` from
 * `PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE` for its own create button — reusing
 * that here would be a real access-control WIDENING, not a refactor:
 * `PROJECT_TRIGGER_CREATE` sits in `EDITOR_EXTRAS`
 * (`apps/api/src/iam/role-perms.ts`), so an editor would gain visibility and
 * control of the project-wide kill switch, which the original code gated on
 * raw `effective_project_role === 'manager'` alone — manager-only, strictly
 * narrower than `canWrite`, and for a custom IAM role the two aren't even
 * equivalent in principle (independently grantable). This component keeps that
 * exact gate with its own `getProject` probe — see `schedule-view.test.tsx`.
 *
 * Reads `qk.project.triggers(projectId)` with its OWN `useQuery` — the SAME
 * key `ScheduleView` queries below. React Query dedupes both calls into one
 * request and one cache write, so this switch and `ScheduleView`'s paused
 * banner can never disagree or double-fetch.
 */
function TriggersActivationCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const queryKey = qk.project.triggers(projectId);
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    ...contract('config'),
  });
  const paused = triggersQuery.data?.triggers_paused ?? false;

  // Raw manager-only gate — see this component's header comment for why this
  // is its OWN probe rather than `ScheduleView`'s `canWrite`.
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  const canManage = projectQuery.data?.effective_project_role === 'manager';

  const mutation = useMutation({
    mutationFn: (next: boolean) => setProjectTriggersActivation(projectId, next),
    onSuccess: (data, next) => {
      queryClient.setQueryData(queryKey, data);
      successToast(next ? 'Everything paused for this project' : 'Everything resumed');
    },
    onError: (error: Error) => errorToast(error.message || 'Could not update'),
  });

  return (
    <TriggerPauseSwitch
      canManage={canManage}
      paused={paused}
      isPending={mutation.isPending || triggersQuery.isLoading}
      onToggle={(v) => mutation.mutate(v)}
    />
  );
}

export function ScheduleView({ projectId, type }: { projectId: string; type: TriggerKind }) {
  const copy = KIND_COPY[type];
  const queryClient = useQueryClient();
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE).allowed === true;

  // Same entity/fetcher `TriggersActivationCard` above reads — both must share
  // this key, via `qk.project.triggers`, or a pause in one goes unseen in the
  // other (see that component's own header comment).
  const queryKey = useMemo(() => qk.project.triggers(projectId), [projectId]);
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    refetchInterval: 10_000,
    ...contract('config'),
  });

  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTrigger | null>(null);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  /* ── Mutations shared by the row menu and the detail panel ───────────── */

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
      invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'It could not start'),
  });

  const toggle = useMutation({
    mutationFn: (trigger: ProjectTrigger) =>
      updateProjectTrigger(projectId, trigger.slug, { enabled: !trigger.enabled }),
    onSuccess: (_data, trigger) => {
      successToast(trigger.enabled ? 'Paused' : 'Resumed');
      invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Could not update'),
  });

  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) => deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: () => {
      successToast(`${copy.noun[0].toUpperCase()}${copy.noun.slice(1)} deleted`);
      setDeleteTarget(null);
      setSelectedSlug(null);
      invalidate();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Could not delete it'),
  });

  /* ── Derived state ──────────────────────────────────────────────────── */

  const isForbidden =
    triggersQuery.isError && /403|forbidden/i.test((triggersQuery.error as Error)?.message ?? '');
  const showContent = !triggersQuery.isLoading && !isForbidden && !triggersQuery.isError;

  const triggers = useMemo(
    () => (triggersQuery.data?.triggers ?? []).filter((t) => t.type === type),
    [triggersQuery.data, type],
  );
  const filtered = useMemo(() => triggers.filter((t) => matchesQuery(t, query)), [triggers, query]);
  const selected = triggers.find((t) => t.slug === selectedSlug) ?? null;
  const parseErrors = triggersQuery.data?.errors ?? [];
  const paused = triggersQuery.data?.triggers_paused ?? false;

  return (
    <>
      <CustomizeSectionWrapper
        title={copy.title}
        description={copy.description}
        action={
          showContent && canWrite ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4 shrink-0" />
              {copy.createLabel}
            </Button>
          ) : null
        }
      >
        <div className="space-y-4">
          {/* Project-wide, not per-type — rendered on Schedules only so it has
              exactly one home. Visibility is its OWN manager-only probe, not
              this view's `canWrite`. */}
          {type === 'cron' && showContent ? <TriggersActivationCard projectId={projectId} /> : null}

          {paused && showContent && (
            <InfoBanner tone="warning" icon={WarningIcon} title="Everything is paused">
              Nothing in this project runs on its own right now. You can still start a {copy.noun}{' '}
              by hand.{' '}
              {type === 'cron' ? 'Turn the switch above off to resume.' : 'Resume it on Schedules.'}
            </InfoBanner>
          )}

          {showContent && triggers.length > 0 ? (
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <SearchIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder={copy.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
          ) : null}

          {triggersQuery.isLoading ? (
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : isForbidden ? (
            <InfoBanner tone="warning" icon={LockKeyIcon} title="You don't have access">
              Ask a project manager to give you access to this project&apos;s {copy.noun}s.
            </InfoBanner>
          ) : triggersQuery.isError ? (
            <ErrorState
              size="sm"
              title={`Couldn't load your ${copy.noun}s`}
              description={(triggersQuery.error as Error)?.message ?? 'Something went wrong.'}
              action={
                <Button variant="outline" size="sm" onClick={() => triggersQuery.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : triggers.length === 0 ? (
            <EmptyState
              icon={type === 'cron' ? TimerIcon : WebhooksLogoIcon}
              size="sm"
              title={copy.emptyTitle}
              description={copy.emptyBody}
              action={
                canWrite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setCreateOpen(true)}
                  >
                    <PlusIcon className="size-3.5 shrink-0" />
                    {copy.createLabel}
                  </Button>
                ) : undefined
              }
            />
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              Nothing matches <span className="text-foreground font-medium">{query}</span>.
            </p>
          ) : (
            <ScheduleTable
              kind={type}
              triggers={filtered}
              canWrite={canWrite}
              runningSlug={run.isPending ? (run.variables?.slug ?? null) : null}
              togglingSlug={toggle.isPending ? (toggle.variables?.slug ?? null) : null}
              onOpen={(t) => setSelectedSlug(t.slug)}
              onRun={(t) => run.mutate(t)}
              onToggle={(t) => toggle.mutate(t)}
              onDelete={(t) => setDeleteTarget(t)}
            />
          )}

          {parseErrors.length > 0 && (
            <InfoBanner tone="warning" icon={WarningIcon} title="Some entries could not be read">
              <ul className="space-y-0.5 text-xs">
                {parseErrors.map((err) => (
                  <li key={err.slug}>
                    <code className="font-mono">{err.path}</code> — {err.error}
                  </li>
                ))}
              </ul>
            </InfoBanner>
          )}
        </div>
      </CustomizeSectionWrapper>

      <ScheduleCreateModal
        projectId={projectId}
        kind={type}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(slug) => {
          setCreateOpen(false);
          invalidate();
          // Drop straight into the new entry so the address or the first run
          // is one click away, not two.
          setSelectedSlug(slug);
        }}
      />

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
        title={`Delete this ${copy.noun}?`}
        description={
          deleteTarget ? (
            <>
              <span className="text-foreground font-medium">{triggerName(deleteTarget)}</span> (
              {describeWhen(deleteTarget).toLowerCase()}) stops running and is removed. Runs it has
              already done are kept.
            </>
          ) : null
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </>
  );
}
