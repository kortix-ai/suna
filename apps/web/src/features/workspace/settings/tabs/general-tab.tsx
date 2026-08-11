'use client';

/**
 * The General tab — workspace name, icon, the sandbox-provider pin, and
 * Delete workspace. Split off `settings-view.tsx`'s `SettingsView`, which
 * used to render this content alongside Repository, Automation, and the full
 * Experimental feature list on one page (Task 18's brief). Experimental now
 * has its own tab — see `experimental-tab.tsx` — and is NOT rendered here.
 *
 * **What moved here, verbatim, from `settings-view.tsx`:**
 * - The rename mutation (`GeneralWorkspaceCard` below) — same
 *   `useMutation`/`renameOnMutate`/`renameOnError`/`renameOnSettled` wiring
 *   as the old `GeneralProjectCard`, byte-identical apart from the name of
 *   the enclosing function. `general-tab.rename.test.tsx` pins this the same
 *   way `settings-view.rename.test.tsx` used to.
 * - `SandboxProviderRow` (including `AUTO_PROVIDER` and the
 *   `applySandboxProviderResult`/`pollSandboxProviderTransition` helpers it
 *   drives) — cut from inside the old `ExperimentalCard`'s disclosure, not
 *   copied, per the task brief ("a copy leaves two implementations to
 *   drift"). Its own behavior is unchanged; only its host page moved.
 * - The Danger Zone (renamed "Delete workspace" per the task brief, to match
 *   the Profile tab's own "Delete account" section naming) — same
 *   `archiveProject` mutation, same `ConfirmDialog`, same recoverable-archive
 *   semantics. The mechanism is still an archive (`archiveProject`), NOT a
 *   hard delete — no `deleteProject` function exists anywhere in `@kortix/sdk`
 *   (checked: `grep -rn "deleteProject\b" packages/sdk/src apps/web/src`
 *   returns nothing). The section heading uses the brief's wording; the row
 *   copy stays honest about what actually happens (hide + recoverable, not
 *   permanent removal), same as the original "Archive Project" copy.
 *
 * **New: the icon field.** Reuses `ProjectIconField`
 * (`features/projects/modal/project-icon-field.tsx`) and
 * `buildProjectEditPatch`/`summarizeProjectEdit`
 * (`features/projects/modal/project-edit-patch.ts`) UNMODIFIED — the same
 * icon-diffing logic `EditProjectModal` uses, so the emoji/glyph mutual-
 * exclusion rules (see that module's header comment) can't drift between the
 * two write paths. The icon patch always sends `draft.name === project.name`
 * (the server-confirmed name, not the possibly-still-debouncing local draft),
 * so an icon pick can never accidentally also send a half-typed rename.
 *
 * **A field the task brief asked for that does not exist: workspace
 * description.** `KortixProject`/`ProjectInput` (`packages/sdk/src/core/rest/
 * projects-client/projects.ts`) have no `description` field — checked
 * directly against both interfaces. The `description` that DOES exist on
 * that file (`CreateProjectRepoInput.description`) is a GitHub-repo-creation
 * parameter, write-only at project creation, never stored back or
 * readable/editable afterward. There is nothing to wire up here without
 * inventing a field the backend doesn't have; this tab does not render one.
 *
 * **What did NOT move here: Repository and Automation.** The task brief
 * scopes this split to exactly "General" (name, icon, sandbox pin, delete)
 * and "Experimental" — it does not mention `RepositoryCard` (default branch,
 * manifest path, GitHub collaborator invite) or `TriggersActivationCard`
 * (the project-wide "pause all triggers" switch). Neither belongs on General
 * by that scope, but leaving them in the deleted `settings-view.tsx` would
 * have made both unreachable with no replacement — so they moved (cut, not
 * copied) to where a user would actually look for them instead:
 * `RepositoryCard` into `GitView` (`customize/sections/view/git-view.tsx`,
 * the Repositories tab) and `TriggersActivationCard` into `ScheduleView`
 * (`components/projects/schedule-view.tsx`, the Schedules tab). See each
 * file's own header comment for the move.
 *
 * **Ported from `main` at the settings-panel merge: archive suppression.**
 * `main` moved the deleted `/projects` list page's archive handler into
 * `settings-view.tsx` as `runProjectArchive` +
 * `accountProjectCountForArchive`. That file is deleted here, so both
 * functions live below and this tab's archive mutation drives them. Without
 * the port, `suppressAutoProjectAfterDelete()` would have had ZERO callers and
 * `/projects/start` would silently re-provision a workspace the user just
 * deleted. `general-tab.archive.test.ts` carries `main`'s tests for them.
 *
 * `GeneralTabView` is the pure, props-only half — every stateful piece
 * (`GeneralWorkspaceCard`'s name+icon mutations, `SandboxProviderRow`'s
 * mutation+polling) owns its own hooks and can't render under
 * `renderToStaticMarkup` with no `QueryClientProvider`, so both are threaded
 * through as slots — same reasoning as `connected-tab.tsx`'s
 * `githubAppSetupSlot`/`chatgptConnectSlot`. `GeneralTab` is the container:
 * every hook only runs once this tab is actually mounted, which
 * `SettingsTabPane` in `settings-panel.tsx` guarantees happens only while
 * this tab is active.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import type { GlyphSelection } from '@/components/ui/glyph-picker';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { buildProjectEditPatch } from '@/features/projects/modal/project-edit-patch';
import {
  ProjectIconField,
  type ProjectIconValue,
} from '@/features/projects/modal/project-icon-field';
import {
  renameOnError,
  renameOnMutate,
  renameOnSettled,
} from '@/hooks/projects/project-rename-cache';
import { useDebounce } from '@/hooks/use-debounce';
import { suppressAutoProjectAfterDelete } from '@/lib/onboarding/ensure-first-project';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  archiveProject,
  getProject,
  listProjectsForAccount,
  updateProject,
  updateProjectSandboxProvider,
  type KortixProject,
  type ProjectInput,
  type SandboxProviderName,
} from '@kortix/sdk';
import { contract, invalidateProject, qk } from '@kortix/sdk/react';
import { TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applySandboxProviderResult,
  pollSandboxProviderTransition,
} from '../../customize/sections/view/sandbox-provider-result';
import { SettingsTabHeader } from '../settings-tab-header';

export interface GeneralTabViewProps {
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  /** `GeneralWorkspaceCard` — name + icon editing. Owns its own
   *  `useMutation`/`useState`, so it's a slot — see this file's header
   *  comment. Left `undefined` by default so the bare view still renders
   *  under `renderToStaticMarkup` with no providers. */
  generalFieldsSlot?: ReactNode;
  /** `SandboxProviderRow`, moved here unmodified from `settings-view.tsx`
   *  — see this file's header comment. Same slot reasoning as
   *  `generalFieldsSlot` above. */
  sandboxProviderSlot?: ReactNode;
  /** Whether the Delete-workspace section shows at all — manager-only
   *  (`effective_project_role === 'manager'`), NOT the broader `canEdit`
   *  (manager OR `project.write`) gate `generalFieldsSlot`'s fields use.
   *  Matches `settings-view.tsx`'s original raw `canManage` vs `canEdit`
   *  split exactly (see this file's header comment). */
  canDelete?: boolean;
  workspaceName?: string;
  archiveOpen?: boolean;
  onOpenArchiveDialog?: () => void;
  onCloseArchiveDialog?: () => void;
  onConfirmArchive?: () => void;
  isArchivePending?: boolean;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `GeneralTab` so this renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider` — see
 *  `ProfileTabView`/`ConnectedAccountsTabView` for the same split. Every
 *  prop is optional with a safe default so the bare `<GeneralTabView />`
 *  the test file renders shows the Delete-workspace section fully formed. */
export function GeneralTabView({
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  generalFieldsSlot,
  sandboxProviderSlot,
  canDelete = true,
  workspaceName = '',
  archiveOpen = false,
  onOpenArchiveDialog = () => {},
  onCloseArchiveDialog = () => {},
  onConfirmArchive = () => {},
  isArchivePending = false,
}: GeneralTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-6 py-10">
      <SettingsTabHeader tab="general" />
      {isLoading ? (
        <div className="space-y-5">
          <Skeleton className="h-40 rounded-md" />
          <Skeleton className="h-20 rounded-md" />
        </div>
      ) : isError ? (
        <ErrorState
          size="sm"
          title="Failed to load project"
          description={errorMessage}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          {generalFieldsSlot}
          {sandboxProviderSlot}
          {canDelete ? (
            <section className="space-y-4">
              <SettingsSectionHeader title="Delete workspace" />
              <div className="bg-popover rounded-md border px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-medium">Archive this workspace</p>
                    <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                      Hides it from the active project list. Current sessions remain recoverable.
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                    onClick={onOpenArchiveDialog}
                  >
                    <TrashIcon className="size-4" />
                    Delete
                  </Button>
                </div>
              </div>
            </section>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={(open) => {
          if (!open) onCloseArchiveDialog();
        }}
        title="Delete workspace?"
        description={
          workspaceName ? `Archive ${workspaceName}? Current sessions remain recoverable.` : ''
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={onConfirmArchive}
        isPending={isArchivePending}
      />
    </div>
  );
}

/** The field's union, seeded from the project's two independent stored
 *  columns. Mirrors `edit-project-modal.tsx`'s private `toIconValue` exactly
 *  (glyph wins if a stale row somehow carries both) — duplicated rather than
 *  imported because that helper isn't exported and is four lines of pure
 *  mapping, not logic that can meaningfully drift. */
function toIconValue(icon?: string | null, glyph?: GlyphSelection | null): ProjectIconValue {
  if (glyph) return { glyph };
  if (icon) return { emoji: icon };
  return null;
}

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}

export interface RunProjectArchiveClient {
  archiveProject: (projectId: string) => Promise<unknown>;
}

/**
 * The archive mutation's real side effects, pulled out of the container so
 * this exact wiring can be pinned with a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — process-wide in this monorepo and a
 * hazard for sibling suites.
 *
 * Ported from `main` at the settings-panel merge (`settings-view.tsx`'s
 * `runProjectArchive`), which itself carried it over from the deleted
 * `/projects` list page's archive handler: "Archiving the LAST project must
 * leave the account empty. Without this the auto-provision door would see zero
 * active projects and immediately recreate one, undoing the delete the user
 * just confirmed." Same condition (`<= 1`, against the count from BEFORE this
 * archive lands), same tab-scoped `sessionStorage` guard
 * (`suppressAutoProjectAfterDelete`) — deliberately NOT `localStorage`: a
 * later sign-in or a fresh tab must still auto-provision for an empty account
 * like any other.
 *
 * Without this, `main`'s `/projects/start` landing door is the only consumer of
 * `isAutoProjectSuppressed()` and NOTHING would ever set the flag — deleting
 * `settings-view.tsx` alone would have orphaned the whole mechanism silently.
 *
 * `onSuppress` only runs after `client.archiveProject` resolves — a failed
 * archive must not suppress auto-provision for a project that still exists.
 *
 * `remainingProjectCountBeforeArchive` is `number | null`, NOT the deleted
 * page's plain number: that page's count and its Archive button read the SAME
 * query, so the button could not render before the count existed. Here the
 * count is a separate, dependent query that can still be loading or errored
 * when Delete is confirmed. `null` means "count unknown" and deliberately does
 * NOT suppress — failing closed, because the cost of skipping a suppression is
 * one unwanted auto-create, while the cost of a FALSE suppression is
 * `/projects/start` refusing to auto-create for the next empty account this
 * tab visits.
 */
export async function runProjectArchive(
  projectId: string,
  remainingProjectCountBeforeArchive: number | null,
  client: RunProjectArchiveClient,
  onSuppress: () => void,
): Promise<void> {
  await client.archiveProject(projectId);
  if (remainingProjectCountBeforeArchive !== null && remainingProjectCountBeforeArchive <= 1) {
    onSuppress();
  }
}

/**
 * `accountProjectsQuery.data` -> the count `runProjectArchive` needs, kept as
 * its own exported step so the exact mapping is pinned independently of
 * TanStack Query. The bug this guards against lived in a bare
 * `accountProjectsQuery.data?.length ?? 0` at the call site: `undefined`
 * (still loading, OR the query errored — react-query leaves `data` `undefined`
 * in both) silently became `0`, which reads as "zero projects remain" and
 * fires a false suppression. `undefined` must map to `null` ("unknown"), never
 * to `0` ("confirmed empty"). Ported from `main`.
 */
export function accountProjectCountForArchive(data: unknown[] | undefined): number | null {
  return data ? data.length : null;
}

/** Workspace name + icon. Moved from `settings-view.tsx`'s
 *  `GeneralProjectCard` (name — see this file's header comment for what's
 *  byte-identical) and extended with icon editing, reusing `ProjectIconField`
 *  / `buildProjectEditPatch` unmodified — see this file's header comment. */
function GeneralWorkspaceCard({
  project,
  canManage,
}: {
  project: KortixProject;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const { debouncedValue: debouncedName, isLoading: isDebouncing } = useDebounce(name, 500);

  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  const renameMutation = useMutation({
    mutationFn: (nextName: string) => updateProject(project.project_id, { name: nextName }),
    onMutate: (nextName) => renameOnMutate(queryClient, project.project_id, nextName),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.project.summary(project.project_id), updated);
    },
    onError: (error: Error, _nextName, context) => {
      renameOnError(queryClient, project.project_id, context);
      errorToast(error.message || 'Failed to update project');
    },
    onSettled: () => renameOnSettled(queryClient, project.project_id),
  });

  const { mutate: mutateName, isPending: isRenamePending } = renameMutation;

  useEffect(() => {
    if (!canManage || isRenamePending) return;

    const trimmed = debouncedName.trim();
    if (!trimmed || trimmed === project.name) return;

    mutateName(trimmed);
  }, [debouncedName, canManage, project.name, isRenamePending, mutateName]);

  const iconMutation = useMutation({
    mutationFn: (patch: Partial<ProjectInput>) => updateProject(project.project_id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.project.summary(project.project_id), updated);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update workspace icon'),
  });

  // `draft.name` is always the SERVER-confirmed name (`project.name`), never
  // the local `name` draft above — so an icon pick can never accidentally
  // also send a half-typed, not-yet-debounced rename. See this file's header
  // comment.
  const applyIcon = (nextIcon: ProjectIconValue) => {
    const edit = buildProjectEditPatch(
      { name: project.name, icon: project.icon, icon_glyph: project.icon_glyph },
      { name: project.name, icon: nextIcon },
    );
    if (edit.status !== 'ready') return;
    iconMutation.mutate(edit.patch);
  };

  const saving = isDebouncing || isRenamePending;

  return (
    // No section heading here — the pane heading right above already reads
    // "General" (this tab's own rail label), and a second "General" directly
    // under it would repeat the same word. See `settings-tab-header.tsx`.
    <section className="space-y-4">
      <div className="flex items-start gap-2">
        <ProjectIconField
          value={toIconValue(project.icon, project.icon_glyph)}
          onChange={(emoji) => applyIcon({ emoji })}
          onGlyphChange={(glyph) => applyIcon({ glyph })}
          onClear={() => applyIcon(null)}
          disabled={!canManage || iconMutation.isPending}
        />
        <div className="min-w-0 flex-1">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
              {saving ? <SaveStatus /> : null}
            </div>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage || isRenamePending}
              maxLength={120}
              variant="popover"
            />
          </Field>
        </div>
      </div>
    </section>
  );
}

// Per-project sandbox-provider pin — moved unmodified from `settings-view.tsx`'s
// `ExperimentalCard` (it used to render as a row INSIDE the Experimental
// disclosure; the task brief moves it here instead — see this file's header
// comment). Overrides the platform's weighted distribution for THIS project
// only. Options come from the project payload (`available_sandbox_providers`).
// Hidden only when no provider is usable.
const AUTO_PROVIDER = '__auto__';
function SandboxProviderRow({
  project,
  canManage,
}: {
  project: KortixProject;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const available = project.available_sandbox_providers ?? [];
  const current = project.default_sandbox_provider ?? null;
  const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

  const mutation = useMutation({
    mutationFn: (next: SandboxProviderName | null) =>
      updateProjectSandboxProvider(project.project_id, next),
    onSuccess: (result, next) => {
      // FIX-L: the PATCH returns EITHER the updated project (immediate) OR a
      // preparation object (the prepare branch — a switch to a different enabled
      // provider). Write the project cache ONLY for the immediate result; a
      // preparation is a transition, not a project, and must not clobber the
      // cached project shape.
      const kind = applySandboxProviderResult(queryClient, project.project_id, result);
      if (kind === 'preparation') {
        successToast(
          `Preparing ${next ? label(next) : 'the sandbox provider'}… this can take a few minutes`,
        );
        // Poll the durable transition (bounded, backoff, terminal-stop, 404 = done)
        // and refresh the project once it settles so the now-active provider shows.
        void pollSandboxProviderTransition(project.project_id, {
          onSettled: (state) => {
            // invalidateProject() reaches qk.project.scope(project.project_id),
            // which qk.project.summary(project.project_id) nests under — so it
            // already covers the bare-project row too; no separate summary
            // invalidation needed here.
            void invalidateProject(queryClient, project.project_id);
            // qk.projects.scope(): restores the reach the old bare
            // projects-literal prefix match had. A sandbox-provider switch
            // is rare — over-invalidating a few extra account lists costs
            // nothing measurable.
            queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
            const status = state?.latest?.status;
            if (status === 'activated') {
              successToast(`Switched to ${label(state?.latest?.target_provider ?? '')}`);
            } else if (status === 'failed') {
              errorToast(state?.latest?.label || 'Sandbox provider switch failed');
            }
          },
        });
      }
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update sandbox provider'),
  });

  if (available.length === 0) return null;

  return (
    <section className="space-y-4">
      <SettingsSectionHeader title="Sandbox provider" />
      <div className="bg-popover flex items-center justify-between gap-4 rounded-md border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-foreground text-sm font-medium">Sandbox provider</p>
            <Badge variant="highlight" size="sm">
              Experimental
            </Badge>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            Pin this project to a specific sandbox provider, overriding the platform default. New
            sessions here run on the chosen provider — “Automatic” follows the platform default.
          </p>
        </div>
        <Select
          value={current ?? AUTO_PROVIDER}
          onValueChange={(v) =>
            mutation.mutate(
              v === AUTO_PROVIDER ? null : (available.find((provider) => provider === v) ?? null),
            )
          }
          disabled={!canManage || mutation.isPending}
        >
          <SelectTrigger className="w-40 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_PROVIDER}>Automatic</SelectItem>
            {available.map((p) => (
              <SelectItem key={p} value={p}>
                {label(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

/** Container: owns every hook (React Query, IAM probe, archive dialog state)
 *  and renders `GeneralTabView` with real data + slots. Only ever mounted
 *  while this tab is active (`SettingsTabPane` in `settings-panel.tsx`
 *  returns `null` otherwise), so nothing here fetches on panel open. */
export function GeneralTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);

  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });

  const project = projectQuery.data;
  // Raw, manager-only — gates ONLY the Delete-workspace section's visibility,
  // matching `settings-view.tsx`'s original split (see this file's header
  // comment). `canEdit` below (manager OR project.write) gates the fields
  // themselves, same as the original `GeneralProjectCard`/`SandboxProviderRow`.
  const canManage = project?.effective_project_role === 'manager';
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const canEdit = canManage || canWrite;

  // Same `qk.projects.list(accountId)` cache entry the workspace switcher and
  // `/new` already fetch with, so this is warm (no extra request) for the
  // common case. Read, not re-derived from `project`: this is the account's
  // PROJECT COUNT before the archive commits, which `runProjectArchive` needs
  // to decide whether this was the last one. Ported from `main`.
  const accountId = project?.account_id;
  const accountProjectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId as string),
    enabled: !!accountId,
    ...contract('inventory'),
  });

  const archiveMutation = useMutation({
    mutationFn: () =>
      runProjectArchive(
        projectId,
        accountProjectCountForArchive(accountProjectsQuery.data),
        { archiveProject },
        suppressAutoProjectAfterDelete,
      ),
    onSuccess: () => {
      successToast('Workspace archived');
      // qk.projects.scope(): for a single-account user the archived
      // project's account IS the primary account qk.projects.list() (no
      // args) resolves to, so a precise invalidation would leave the
      // marketplace picker showing the archived project until gcTime
      // evicts it. Archiving is rare — over-invalidating costs nothing.
      queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
      setArchiveOpen(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to archive project'),
  });

  return (
    <GeneralTabView
      isLoading={projectQuery.isLoading}
      isError={projectQuery.isError}
      errorMessage={(projectQuery.error as Error)?.message ?? ''}
      onRetry={() => projectQuery.refetch()}
      generalFieldsSlot={
        project ? <GeneralWorkspaceCard project={project} canManage={canEdit} /> : undefined
      }
      sandboxProviderSlot={
        project ? <SandboxProviderRow project={project} canManage={canEdit} /> : undefined
      }
      canDelete={canManage}
      workspaceName={project?.name}
      archiveOpen={archiveOpen}
      onOpenArchiveDialog={() => setArchiveOpen(true)}
      onCloseArchiveDialog={() => setArchiveOpen(false)}
      onConfirmArchive={() => archiveMutation.mutate()}
      isArchivePending={archiveMutation.isPending}
    />
  );
}
