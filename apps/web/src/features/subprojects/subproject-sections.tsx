'use client';

/**
 * The editors for what a subproject owns — Instructions, Context, Scheduled —
 * hosted by the page's right-hand panel (`subproject-aside.tsx`).
 *
 * Every mutation goes through the SDK's subproject client and invalidates
 * both `qk.project.subproject(pid, slug)` (this page) and
 * `qk.project.subprojects(pid)` (the sidebar).
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  KIND_COPY,
  type TriggerKind,
  describeWhen,
  isTriggerKind,
  triggerName,
} from '@/components/projects/schedule/schedule-copy';
import { ScheduleCreateModal } from '@/components/projects/schedule/schedule-create-modal';
import { ScheduleDetailSheet } from '@/components/projects/schedule/schedule-detail-sheet';
import { AgentPeopleSection } from '@/features/workspace/capabilities/agents/agent-people-section';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  addProjectSubprojectContext,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggers,
  removeProjectSubprojectContext,
  updateProjectSubproject,
  type ProjectTrigger,
  type Subproject,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  CaretRightIcon,
  ClockIcon,
  FileTextIcon,
  NotePencilIcon,
  PlusIcon,
  PulseIcon,
  TimerIcon,
  UsersIcon,
  WebhooksLogoIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import { triggersForSubproject } from './subprojects-data';

/** The API's own cap on one context upload (spec §6). Refuse client-side so
 *  a 2 MB PDF drag does not travel to the server to be rejected. */
const CONTEXT_MAX_BYTES = 256 * 1024;

const KIND_ICON: Record<ProjectTrigger['type'], Icon> = {
  cron: TimerIcon,
  webhook: WebhooksLogoIcon,
  monitor: PulseIcon,
};

/** Both keys every subproject mutation moves: this page, and the sidebar. */
export function useInvalidateSubproject(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.subprojects(projectId) }),
      queryClient.invalidateQueries({ queryKey: qk.project.subproject(projectId, slug) }),
    ]);
  }, [queryClient, projectId, slug]);
}

/** One line of a longer text, for a disclosure summary. */
export function firstLine(text: string | null | undefined, max = 80): string | null {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  const trimmed = line.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ─── The strip ─────────────────────────────────────────────────────────────

// ─── Instructions ──────────────────────────────────────────────────────────

/**
 * The standing instructions, edited in place. Save is offered only while the
 * text differs from what is saved — an always-on pair of buttons is a row
 * that never earns itself.
 */
export function InstructionsBody({
  projectId,
  subproject,
  canManage,
}: {
  projectId: string;
  subproject: Subproject;
  canManage: boolean;
}) {
  const invalidate = useInvalidateSubproject(projectId, subproject.slug);
  const saved = subproject.instructions ?? '';
  const [draft, setDraft] = useState(saved);
  // Re-seed when the server value changes underneath the editor (another tab,
  // a refetch) without an effect: React's documented "props changed" pattern.
  const [seed, setSeed] = useState(saved);
  if (seed !== saved) {
    setSeed(saved);
    setDraft(saved);
  }
  const dirty = draft !== saved;

  const save = useMutation({
    // `''` clears the field — the API takes null for that, and an empty
    // string would otherwise write an empty instructions block.
    mutationFn: () =>
      updateProjectSubproject(projectId, subproject.slug, {
        instructions: draft.trim() ? draft : null,
      }),
    onSuccess: async () => {
      successToast('Instructions saved');
      await invalidate();
    },
    onError: (error: Error) => errorToast(error.message || 'Could not save the instructions'),
  });

  if (!canManage) {
    return saved ? (
      <p className="text-foreground text-sm leading-relaxed whitespace-pre-wrap">{saved}</p>
    ) : (
      <p className="text-muted-foreground text-sm">No instructions yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      <Textarea
        aria-label="Instructions"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Told to the agent at the start of every session here. Markdown."
        minHeight={96}
        className="text-sm leading-relaxed"
        disabled={save.isPending}
      />
      {dirty ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline-ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => setDraft(saved)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Context ───────────────────────────────────────────────────────────────

/**
 * The repo-relative paths the agent always sees. Adding one uploads a text
 * file, which the API commits into `.kortix/subprojects/<slug>/` and appends
 * to `context[]`; removing one drops the entry and never touches the file, so
 * a removed reference is recoverable from the repo.
 */
export function ContextBody({
  projectId,
  subproject,
  canManage,
}: {
  projectId: string;
  subproject: Subproject;
  canManage: boolean;
}) {
  const invalidate = useInvalidateSubproject(projectId, subproject.slug);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const add = useMutation({
    mutationFn: (file: File) =>
      file
        .text()
        .then((content) =>
          addProjectSubprojectContext(projectId, subproject.slug, { path: file.name, content }),
        ),
    onSuccess: async () => {
      successToast('Added to context');
      await invalidate();
    },
    onError: (error: Error) => errorToast(error.message || 'Could not add the file'),
  });

  const remove = useMutation({
    mutationFn: (path: string) => removeProjectSubprojectContext(projectId, subproject.slug, path),
    onSuccess: async () => {
      successToast('Removed from context');
      await invalidate();
    },
    onError: (error: Error) => errorToast(error.message || 'Could not remove the path'),
  });

  return (
    <div className="space-y-2">
      {subproject.context.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Add documents or other text the agent should read in every session here.
        </p>
      ) : (
        <ul>
          {subproject.context.map((path) => (
            <li key={path} className="group hover:bg-hover flex h-8 items-center gap-2 rounded-md px-2">
              <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs" title={path}>
                {path}
              </span>
              {canManage ? (
                <Hint label="Remove from context">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${path} from context`}
                    className="text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(path)}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </Hint>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.mdx,.txt,.json,.yaml,.yml,.csv,text/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Clear first: picking the same file twice must fire again.
              event.target.value = '';
              if (!file) return;
              if (file.size > CONTEXT_MAX_BYTES) {
                errorToast('That file is over 256 KB — reference it by path instead.');
                return;
              }
              add.mutate(file);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground -ml-2 gap-1.5"
            disabled={add.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {add.isPending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <PlusIcon className="size-3.5 shrink-0" />
            )}
            Add file
          </Button>
        </>
      ) : null}
    </div>
  );
}

// ─── Scheduled ─────────────────────────────────────────────────────────────

/**
 * The triggers filed under this subproject — the same rows, detail sheet and
 * create wizard the agent page and the Triggers tab use, against the same
 * `qk.project.triggers` key, so a run started here shows up there.
 */
export function ScheduledBody({
  projectId,
  slug,
  triggers,
  loading,
}: {
  projectId: string;
  slug: string;
  triggers: ProjectTrigger[];
  loading: boolean;
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
  const selected = triggers.find((trigger) => trigger.slug === selectedSlug) ?? null;

  const run = useMutation({
    mutationFn: (trigger: ProjectTrigger) => fireProjectTrigger(projectId, trigger.slug),
    onSuccess: (result) => {
      if (result.status === 'fired') {
        successToast('Started');
      } else if (result.status === 'queued') {
        successToast('Queued', { description: result.reason ?? 'Busy right now — it will retry' });
      } else {
        errorToast('It could not start', { description: result.error });
      }
      void invalidate();
    },
    onError: (error) => errorToast(error instanceof Error ? error.message : 'It could not start'),
  });

  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) => deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: () => {
      successToast('Deleted');
      setDeleteTarget(null);
      setSelectedSlug(null);
      void invalidate();
    },
    onError: (error) => errorToast(error instanceof Error ? error.message : 'Could not delete it'),
  });

  return (
    <div className="space-y-2">
      {loading ? (
        <div className="space-y-1">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-2/3 rounded-md" />
        </div>
      ) : triggers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Recurring or event-driven work that runs inside this subproject.
        </p>
      ) : (
        <ul>
          {triggers.map((trigger) => {
            const KindIcon = KIND_ICON[trigger.type] ?? TimerIcon;
            return (
              <li key={trigger.slug}>
                <button
                  type="button"
                  onClick={() => setSelectedSlug(trigger.slug)}
                  className={cn(
                    'hover:bg-hover flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors',
                    'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
                  )}
                >
                  <KindIcon
                    className={cn(
                      'size-3.5 shrink-0',
                      trigger.enabled ? 'text-kortix-green' : 'text-muted-foreground',
                    )}
                  />
                  <span className="text-foreground min-w-0 truncate text-sm">
                    {triggerName(trigger)}
                  </span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {describeWhen(trigger)}
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
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground -ml-2 gap-1.5"
          onClick={() => setCreateOpen(true)}
        >
          <PlusIcon className="size-3.5 shrink-0" />
          Add trigger
        </Button>
      ) : null}

      {canCreate ? (
        <ScheduleCreateModal
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialSubproject={slug}
          onCreated={(created) => {
            setCreateOpen(false);
            setSelectedSlug(created);
            void invalidate();
          }}
        />
      ) : null}

      <ScheduleDetailSheet
        projectId={projectId}
        trigger={selected}
        canWrite={canWrite}
        open={!!selected}
        onOpenChange={(next) => !next && setSelectedSlug(null)}
        onRun={() => selected && run.mutate(selected)}
        running={run.isPending}
        onDelete={() => selected && setDeleteTarget(selected)}
        onMutated={() => void invalidate()}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(next) => !next && setDeleteTarget(null)}
        title={`Delete ${deleteTarget ? triggerName(deleteTarget) : 'this trigger'}?`}
        description={
          deleteTarget && isTriggerKind(deleteTarget.type)
            ? `This ${KIND_COPY[deleteTarget.type as TriggerKind].noun} stops running and is removed from the project repo.`
            : 'It stops running and is removed from the project repo.'
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </div>
  );
}
