'use client';

/**
 * The General tab — workspace name, icon, and Delete workspace. Split off
 * `settings-view.tsx`'s `SettingsView`, which used to render this content
 * alongside Repository, Automation, and the full Experimental feature list on
 * one page (Task 18's brief). Experimental now has its own tab — see
 * `experimental-tab.tsx` — and is NOT rendered here.
 *
 * **This tab does not mention sandboxes (2026-08-17).** It used to carry a
 * "Sandbox" sub-section holding `SandboxProviderRow` — the per-project
 * sandbox-provider pin, with `AUTO_PROVIDER` and the
 * `applySandboxProviderResult`/`pollSandboxProviderTransition` helpers it
 * drives. All of it is CUT to `sandbox-tab.tsx` (the Sandbox templates
 * section), where it renders above the template list, so everything sandbox
 * related lives on one page. Cut, not copied — there is exactly one
 * implementation, and its behavior is unchanged; only its host page moved.
 * See `sandbox-tab.tsx`'s header comment for the move and for why the pin is
 * now read from the project query there.
 *
 * **What moved here, verbatim, from `settings-view.tsx`:**
 * - The rename mutation (`GeneralWorkspaceCard` below) — same
 *   `useMutation`/`renameOnMutate`/`renameOnError`/`renameOnSettled` wiring
 *   as the old `GeneralProjectCard`, byte-identical apart from the name of
 *   the enclosing function. `general-tab.rename.test.tsx` pins this the same
 *   way `settings-view.rename.test.tsx` used to.
 * - The Danger Zone (renamed "Delete workspace" per the task brief, to match
 *   the Profile tab's own "Delete account" section naming) — same
 *   `archiveProject` mutation. The mechanism is still an archive, NOT a row
 *   delete: no `deleteProject` exists anywhere in `@kortix/sdk` (checked:
 *   `grep -rn "deleteProject\b" packages/sdk/src apps/web/src` returns
 *   nothing).
 *
 *   **The copy used to say "recoverable". That was wrong, and it is fixed
 *   here.** The word described the DB row, not the product. Traced end to end
 *   (2026-08-12):
 *   - `archiveProject()` is `DELETE /v1/projects/:id`
 *     (`packages/sdk/src/core/rest/projects-client/projects.ts`), which sets
 *     `status: 'archived'` (`apps/api/src/projects/routes/r6.ts`).
 *   - `loadProjectForUser` — the gate in front of EVERY project-scoped route —
 *     returns `null` for an archived row
 *     (`apps/api/src/projects/lib/access.ts:575`). So every session, secret,
 *     integration and key under it 404s. This is not "hidden from a list".
 *   - Triggers and scheduled runs only fire for `status = 'active'`
 *     (`apps/api/src/projects/lib/triggers.ts`,
 *     `apps/api/src/projects/trigger-execution-store.ts`), so automation stops
 *     immediately.
 *   - Nothing in `apps/web` or `@kortix/sdk` can un-archive a project — there
 *     is no route, no SDK call, and no UI. Only the platform-admin surface can
 *     even list archived rows (`packages/sdk/src/react/use-admin-projects.ts`).
 *
 *   So from the user's side the loss is total and one-way, and the copy now
 *   says that. What it does NOT say is that the data is erased, because it is
 *   not — and it explicitly reassures that the Git repository survives, which
 *   is true: `deleteManagedProjectRepo` runs only under `?purge=true`
 *   (`r6.ts`), a query param `archiveProject()` never sends. Claiming the repo
 *   was destroyed would be the one genuinely false thing this dialog could
 *   say, and it is the thing users would panic about first.
 *
 *   Because the action is irreversible AND ambiguous (an account has several
 *   workspaces; the wrong one is one click away), the confirmation is
 *   `TypeToConfirmDialog` — the user types the workspace name — rather than the
 *   one-click `ConfirmDialog`. See `components/ui/type-to-confirm-dialog.tsx`
 *   for why that primitive exists and why the matcher is a separate pure
 *   function.
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
 * scoped this split to exactly "General" (name, icon, sandbox pin, delete)
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
 * `GeneralTabView` is the pure, props-only half — the one stateful piece
 * (`GeneralWorkspaceCard`'s name+icon mutations) owns its own hooks and can't
 * render under `renderToStaticMarkup` with no `QueryClientProvider`, so it is
 * threaded through as a slot — same reasoning as `connected-tab.tsx`'s
 * `githubAppSetupSlot`/`chatgptConnectSlot`. `GeneralTab` is the container:
 * every hook only runs once this tab is actually mounted, which
 * `SettingsTabPane` in `settings-panel.tsx` guarantees happens only while
 * this tab is active.
 *
 * **Layout: Linear's settings shape** (Jay's reference, 2026-08-11). Heading,
 * hairline rule, then rows — label left, control right, consecutive rows
 * sharing ONE bordered box (`SettingsRowGroup` / `SettingsRow`, see
 * `components/ui/settings-row.tsx`). Icon and Workspace name are one group;
 * Danger zone gets a plain section label above its own group. Delete
 * workspace is red TEXT, not a filled destructive button — the
 * `ConfirmDialog` behind it, and the `project.delete` gate in front of
 * it, are both unchanged.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import type { GlyphSelection } from '@/components/ui/glyph-picker';
import { Input } from '@/components/ui/input';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { TypeToConfirmDialog } from '@/components/ui/type-to-confirm-dialog';
import { ErrorState } from '@/features/layout/section/error-state';
import { buildProjectEditPatch } from '@/features/projects/modal/project-edit-patch';
import { GitView } from '@/features/workspace/customize/sections/view/git-view';
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
import { useAuth } from '@/features/providers/auth-provider';
import { suppressAutoProjectAfterDelete } from '@/lib/onboarding/ensure-first-project';
import { forgetLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';

/** Asked for in ONE batched probe. `project.delete` and `project.write` are
 *  separate permissions — see `ProjectSettingsGeneralProps.canDelete`. */
const GENERAL_TAB_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_DELETE,
] as const;
import {
  archiveProject,
  getProject,
  listProjectsForAccount,
  updateProject,
  type KortixProject,
  type ProjectInput,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingsTabHeader } from '../settings-tab-header';

/**
 * What the user actually loses, in the order they will care about it.
 *
 * Module-level and exported on purpose. The dialog renders through a Radix
 * portal, so `renderToStaticMarkup` emits none of this copy (see
 * `general-tab.test.tsx`) and a test asserting on rendered output would be
 * unable to fail. Exporting the array gives the test something real to hold —
 * see `general-tab.delete-copy.test.ts`.
 *
 * Every line is a traced consequence of `status: 'archived'`, not a guess.
 * The trace, with file references, is in this file's header comment. Two
 * standing rules for editing this list:
 *
 * 1. **Never claim the data is erased.** It is not — the row survives, the
 *    Git repository survives. Claim only the loss of access, which IS total:
 *    `loadProjectForUser` 404s every project-scoped route for an archived row.
 * 2. **Never drop the repository reassurance below.** "Permanent" plus silence
 *    about the repo reads as "my code is gone", which is the one thing a user
 *    would panic about and the one thing that is false.
 */
export const DELETE_WORKSPACE_CONSEQUENCES = [
  'Every session in this workspace, with its files, history, and outputs',
  'All scheduled runs and triggers — they stop firing straight away',
  'Every connected integration, secret, and API key scoped to this workspace',
  'Access for everyone on the team — nobody can reach this workspace again',
] as const;

/** Stated because it is true and because its absence would be read as a
 *  denial. `archiveProject()` sends no `?purge=true`, which is the only thing
 *  that deletes a Kortix-managed repository (`apps/api/.../routes/r6.ts`);
 *  user-connected repositories are never touched at all. */
export const DELETE_WORKSPACE_REASSURANCE =
  'Your connected Git repository is not deleted. Any code already pushed to it stays where it is.';

/**
 * A section label between two groups — plain small text, optionally one line
 * of explanation, sitting above the next group. No border and no background,
 * so the bordered group below it reads as the thing being labelled. Still an
 * `h2` so the pane keeps a real heading outline.
 *
 * Deliberately duplicated in `profile-tab.tsx` rather than shared: the two
 * Linear restyles landed in parallel and neither should have edited the other
 * agent's file. Promote it to `components/ui/settings-row.tsx` once a third
 * pane needs it.
 */
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
  /** `GitView` — the repository connection, its status, and the two settings
   *  that change how Kortix uses it. Repositories merged into General as a
   *  "Git repo" subsection (Jay's call, 2026-08-17); a slot for the same
   *  reason `generalFieldsSlot` is one — `GitView` owns its own
   *  `useQuery`/mutations, so it can't render under `renderToStaticMarkup`
   *  with no providers. */
  gitRepoSlot?: ReactNode;
  /** Whether the Delete-workspace section shows at all — gated on
   *  `project.delete`, NOT the broader `project.write` gate
   *  `generalFieldsSlot`'s fields use. Deleting and editing are separate
   *  permissions, so a custom role can grant one without the other. */
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
  gitRepoSlot,
  canDelete = true,
  workspaceName = '',
  archiveOpen = false,
  onOpenArchiveDialog = () => {},
  onCloseArchiveDialog = () => {},
  onConfirmArchive = () => {},
  isArchivePending = false,
}: GeneralTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
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
          {gitRepoSlot}
          {canDelete ? (
            <section className="space-y-3">
              <SettingsSubsectionHeader title="Danger zone" />
              <SettingsRowGroup>
                <SettingsRow
                  label="Delete workspace"
                  description="Removes this workspace and everything inside it, for every member. This cannot be undone."
                >
                  {/* Red text, not a filled button: the weight belongs to the
                      confirmation, not to the affordance that opens it. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={onOpenArchiveDialog}
                  >
                    Delete workspace
                  </Button>
                </SettingsRow>
              </SettingsRowGroup>
            </section>
          ) : null}
        </>
      )}

      <TypeToConfirmDialog
        open={archiveOpen}
        onOpenChange={(open) => {
          if (!open) onCloseArchiveDialog();
        }}
        title="Delete workspace?"
        description={
          <>
            This deletes <span className="text-foreground font-medium">{workspaceName}</span> for
            everyone with access to it. It cannot be undone.
          </>
        }
        consequencesTitle="You immediately lose:"
        consequences={DELETE_WORKSPACE_CONSEQUENCES}
        reassurance={DELETE_WORKSPACE_REASSURANCE}
        // The workspace's own name, so confirming proves the user knows WHICH
        // workspace this is — the mistake that actually costs data. While the
        // project query is still in flight this is `''`, and
        // `confirmationPhraseMatches` refuses to arm on a blank phrase.
        confirmPhrase={workspaceName}
        confirmLabel="Delete workspace"
        cancelLabel="Keep workspace"
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
  /** Forget this project as the remembered landing target (JAY-729). Runs
   *  only after the archive lands — a failed archive leaves a project that
   *  still renders, so its cookie must survive. Unlike `onSuppress` it does
   *  not depend on the remaining count: forgetting is about THIS project. */
  onForget?: () => void,
): Promise<void> {
  await client.archiveProject(projectId);
  onForget?.();
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
    // No section label here — the pane heading right above already reads
    // "General" (this tab's own rail label), and a second "General" directly
    // under it would repeat the same word. See `settings-tab-header.tsx`.
    // Both fields share ONE bordered group, Linear-style.
    <SettingsRowGroup>
      <SettingsRow label="Icon" description="Shown next to the workspace name.">
        <ProjectIconField
          value={toIconValue(project.icon, project.icon_glyph)}
          onChange={(emoji) => applyIcon({ emoji })}
          onGlyphChange={(glyph) => applyIcon({ glyph })}
          onClear={() => applyIcon(null)}
          disabled={!canManage || iconMutation.isPending}
          align="end"
        />
      </SettingsRow>
      {/* A description on every row is not decoration here: `Field`'s
          `has-[>[data-slot=field-content]]:items-start` outranks the
          `items-center` `SettingsRow` applies when there is no description
          (specificity 0,2,0 vs 0,1,0), so a description-less row top-aligns
          its control against a single-line label. See this task's report. */}
      <SettingsRow
        label="Workspace name"
        description="Shown in the workspace switcher and anywhere this workspace is listed."
      >
        {saving ? <SaveStatus /> : null}
        <Input
          id="workspace-name"
          // The row label is a heading, not a `<label htmlFor>` — the control
          // carries its own accessible name.
          aria-label="Workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage || isRenamePending}
          maxLength={120}
          // Not `variant="popover"` any more: the group it now sits in is
          // itself `bg-popover`, so a popover-tinted input would vanish into
          // it. The default `bg-input` is what makes it read as a control.
          className="h-8 w-56"
        />
      </SettingsRow>
    </SettingsRowGroup>
  );
}

/** Container: owns every hook (React Query, IAM probe, archive dialog state)
 *  and renders `GeneralTabView` with real data + slots. Only ever mounted
 *  while this tab is active (`SettingsTabPane` in `settings-panel.tsx`
 *  returns `null` otherwise), so nothing here fetches on panel open. */
export function GeneralTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [archiveOpen, setArchiveOpen] = useState(false);

  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });

  const project = projectQuery.data;
  // Two DIFFERENT permissions, asked for separately. `project.delete` gates the
  // Delete-workspace section; `project.write` gates the fields. Reading a
  // `manager` role label instead would have hidden Delete from a custom role
  // that holds `project.delete`, and shown it to one that does not.
  const caps = useProjectCans(projectId, GENERAL_TAB_ACTIONS);
  const canDelete = caps[PROJECT_ACTIONS.PROJECT_DELETE]?.allowed === true;
  const canEdit = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true;

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
        // The archived project must stop being where `/` and the settings
        // exit land (JAY-729) — otherwise they redirect into a 404 gate.
        () => forgetLastProjectId(user?.id, projectId),
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
      gitRepoSlot={<GitView projectId={projectId} />}
      canDelete={canDelete}
      workspaceName={project?.name}
      archiveOpen={archiveOpen}
      onOpenArchiveDialog={() => setArchiveOpen(true)}
      onCloseArchiveDialog={() => setArchiveOpen(false)}
      onConfirmArchive={() => archiveMutation.mutate()}
      isArchivePending={archiveMutation.isPending}
    />
  );
}
