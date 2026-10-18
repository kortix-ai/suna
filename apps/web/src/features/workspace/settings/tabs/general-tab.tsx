'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

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
import {
  ProjectIconField,
  type ProjectIconValue,
} from '@/features/projects/modal/project-icon-field';
import { useAuth } from '@/features/providers/auth-provider';
import {
  renameOnError,
  renameOnMutate,
  renameOnSettled,
} from '@/hooks/projects/project-rename-cache';
import { useDebounce } from '@/hooks/use-debounce';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { forgetLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { TransferWorkspaceEntry } from './transfer-workspace-dialog';
import {
  archiveProject,
  getProject,
  updateProject,
  type KortixProject,
  type ProjectInput,
} from '@kortix/sdk';
import { contract, invalidateProjectIdentity, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { SettingsTabHeader } from '../settings-tab-header';

/** Asked for in ONE batched probe. `project.delete` and `project.write` are
 *  separate permissions — see `ProjectSettingsGeneralProps.canDelete`. */
const GENERAL_TAB_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_DELETE,
] as const;

export const DELETE_WORKSPACE_CONSEQUENCES = [
  'Every session in this workspace, with its files, history, and outputs',
  'All scheduled runs and triggers — they stop firing straight away',
  'Every connected integration, secret, and API key scoped to this workspace',
  'The Kortix-managed git repository for this workspace, with every commit in it',
  'Access for everyone on the team — nobody can reach this workspace again',
] as const;

/** Stated because it is true and because its absence would be read as a
 *  denial. `deleteManagedProjectRepo` deletes only the Kortix-managed
 *  upstream; repositories the user connected themselves are never touched
 *  (`apps/api/src/projects/routes/project-settings.ts`). */
export const DELETE_WORKSPACE_REASSURANCE =
  'Git repositories you connected yourself are not deleted. Any code already pushed to them stays where it is.';

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
  copy?: GeneralTabCopy;
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
  /** `TransferWorkspaceEntry` — the second danger-zone row and its dialog.
   *  A slot for the same reason the others are: the dialog owns its own
   *  accounts query and mutation, so it cannot render under
   *  `renderToStaticMarkup` with no providers. Shares the Delete section's
   *  `canDelete` gate — the API's source gate for a transfer is the same
   *  destructive tier that gates delete. */
  transferSlot?: ReactNode;
}

export interface GeneralTabCopy {
  loadFailed: string;
  retry: string;
  dangerZone: string;
  deleteWorkspace: string;
  deleteDescription: string;
  deleteTitle: string;
  deleteDialog: (name: string) => ReactNode;
  consequencesTitle: string;
  consequences: readonly string[];
  reassurance: string;
  keepWorkspace: string;
}

const DEFAULT_GENERAL_COPY: GeneralTabCopy = {
  loadFailed: 'Failed to load project',
  retry: 'Retry',
  dangerZone: 'Danger zone',
  deleteWorkspace: 'Delete workspace',
  deleteDescription:
    'Removes this workspace and everything inside it, for every member. This cannot be undone.',
  deleteTitle: 'Delete workspace?',
  deleteDialog: (name) =>
    `This deletes ${name} for everyone with access to it. It cannot be undone.`,
  consequencesTitle: 'You immediately lose:',
  consequences: DELETE_WORKSPACE_CONSEQUENCES,
  reassurance: DELETE_WORKSPACE_REASSURANCE,
  keepWorkspace: 'Keep workspace',
};

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `GeneralTab` so this renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider` — see
 *  `ProfileTabView`/`ConnectedAccountsTabView` for the same split. Every
 *  prop is optional with a safe default so the bare `<GeneralTabView />`
 *  the test file renders shows the Delete-workspace section fully formed. */
export function GeneralTabView({
  copy = DEFAULT_GENERAL_COPY,
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  generalFieldsSlot,
  canDelete = true,
  workspaceName = '',
  archiveOpen = false,
  onOpenArchiveDialog = () => {},
  onCloseArchiveDialog = () => {},
  onConfirmArchive = () => {},
  isArchivePending = false,
  transferSlot,
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
          title={copy.loadFailed}
          description={errorMessage}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              {copy.retry}
            </Button>
          }
        />
      ) : (
        <>
          {generalFieldsSlot}
          {canDelete ? (
            <section className="space-y-3">
              <SettingsSubsectionHeader title={copy.dangerZone} />
              <SettingsRowGroup>
                <SettingsRow label={copy.deleteWorkspace} description={copy.deleteDescription}>
                  {/* Red text, not a filled button: the weight belongs to the
                      confirmation, not to the affordance that opens it. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={onOpenArchiveDialog}
                  >
                    {copy.deleteWorkspace}
                  </Button>
                </SettingsRow>
                {transferSlot}
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
        title={copy.deleteTitle}
        description={copy.deleteDialog(workspaceName)}
        consequencesTitle={copy.consequencesTitle}
        consequences={copy.consequences}
        reassurance={copy.reassurance}
        // The workspace's own name, so confirming proves the user knows WHICH
        // workspace this is — the mistake that actually costs data. While the
        // project query is still in flight this is `''`, and
        // `confirmationPhraseMatches` refuses to arm on a blank phrase.
        confirmPhrase={workspaceName}
        confirmLabel={copy.deleteWorkspace}
        cancelLabel={copy.keepWorkspace}
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

function SaveStatus({ label }: { label: string }) {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{label}</span>;
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
 * Archiving the account's last project needs no guard: the landing door
 * never auto-creates a project, so an empty account lands on the chooser.
 */
export async function runProjectArchive(
  projectId: string,
  client: RunProjectArchiveClient,
  /** Forget this project as the remembered landing target (JAY-729). Runs
   *  only after the archive lands — a failed archive leaves a project that
   *  still renders, so its cookie must survive. */
  onForget?: () => void,
  /** Leave the deleted project for the id-free landing door. Runs LAST, after
   *  the cookie is forgotten, so the door opens the next project — or, after
   *  the account's last one, the create form. */
  onLeave?: (path: string) => void,
): Promise<void> {
  await client.archiveProject(projectId);
  onForget?.();
  onLeave?.(PROJECT_LANDING_PATH);
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.workspace');
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const { debouncedValue: debouncedName, isLoading: isDebouncing } = useDebounce(name, 500);
  // The last name the autosave effect sent and that the input has not changed
  // since. A failed rename leaves the server name unchanged (the optimistic
  // write is rolled back by `renameOnError`, and the summary cache this card
  // reads is never optimistically written), so the effect's equality guard
  // alone would re-fire the same rename on every `isRenamePending` flip,
  // forever. Skipping the attempted name breaks that loop: a failed save
  // idles until the user edits again (any settled edit that differs clears
  // it), and a successful one clears it in `onSuccess`.
  const attemptedName = useRef<string | null>(null);

  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  const renameMutation = useMutation({
    mutationFn: (nextName: string) => updateProject(project.project_id, { name: nextName }),
    onMutate: (nextName) => renameOnMutate(queryClient, project.project_id, nextName),
    onSuccess: (updated) => {
      attemptedName.current = null;
      queryClient.setQueryData(qk.project.summary(project.project_id), updated);
    },
    onError: (error: Error, _nextName, context) => {
      renameOnError(queryClient, project.project_id, context);
      errorToast(error.message || t('updateFailed'));
    },
    onSettled: () => renameOnSettled(queryClient, project.project_id),
  });

  const { mutate: mutateName, isPending: isRenamePending } = renameMutation;

  useEffect(() => {
    if (!canManage || isRenamePending) return;

    const trimmed = debouncedName.trim();
    if (attemptedName.current === trimmed) return;
    attemptedName.current = null;
    if (!trimmed || trimmed === project.name) return;

    attemptedName.current = trimmed;
    mutateName(trimmed);
  }, [debouncedName, canManage, project.name, isRenamePending, mutateName]);

  const iconMutation = useMutation({
    mutationFn: (patch: Partial<ProjectInput>) => updateProject(project.project_id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.project.summary(project.project_id), updated);
    },
    onError: (error: Error) => errorToast(error.message || t('iconUpdateFailed')),
    // The icon is read from THREE caches and this mutation used to write back
    // to one. `setQueryData` above repaints the sidebar switcher, which reads
    // `qk.project.summary`; the projects grid and ⌘K read a
    // `qk.projects.list(accountId)` entry, and the project-home heading reads
    // `qk.project.detail` through `useProjectName` / `useProjectIcon`. Neither
    // of those two was touched, so a new icon showed in the sidebar and stayed
    // stale everywhere else until eviction.
    //
    // Exactly the bug `invalidateProjectIdentity` was written for when the
    // project NAME had it (see its doc comment in
    // `@kortix/sdk/react/invalidate-project.ts` — note it needs the
    // `qk.projects.scope()` PREFIX, since `list()` and `list(accountId)` are
    // siblings, not parent and child). The rename mutation above reaches it
    // through `renameOnSettled`; this one calls it directly, because there is
    // no optimistic write here to snapshot or roll back.
    //
    // `onSettled`, not `onSuccess`: a rejected save must re-sync too, or the
    // caches keep whatever the failed attempt left them believing.
    onSettled: () => invalidateProjectIdentity(queryClient, project.project_id),
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
      <SettingsRow label={t('icon')} description={t('iconDescription')}>
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
      <SettingsRow label={t('name')} description={t('nameDescription')}>
        {saving ? <SaveStatus label={t('saving')} /> : null}
        <Input
          id="workspace-name"
          // The row label is a heading, not a `<label htmlFor>` — the control
          // carries its own accessible name.
          aria-label={t('name')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.workspace');
  const queryClient = useQueryClient();
  const router = useRouter();
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

  const archiveMutation = useMutation({
    mutationFn: () =>
      runProjectArchive(
        projectId,
        { archiveProject },
        // The archived project must stop being where `/` and the settings
        // exit land (JAY-729) — otherwise they redirect into a 404 gate.
        () => forgetLastProjectId(user?.id, projectId),
        // The overlay's open state is global, so close it first or it would
        // reopen over the next project. `replace`: Back must not return to
        // the deleted project.
        (path) => {
          useSettingsPanelStore.getState().close();
          router.replace(path);
        },
      ),
    onSuccess: () => {
      successToast(tI18nComplete('textdd9e881230eb'));
      // qk.projects.scope(): for a single-account user the archived
      // project's account IS the primary account qk.projects.list() (no
      // args) resolves to, so a precise invalidation would leave the
      // marketplace picker showing the archived project until gcTime
      // evicts it. Archiving is rare — over-invalidating costs nothing.
      queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
      setArchiveOpen(false);
    },
    onError: (error: Error) => errorToast(error.message || t('archiveFailed')),
  });

  return (
    <GeneralTabView
      copy={{
        loadFailed: t('loadFailed'),
        retry: t('retry'),
        dangerZone: t('dangerZone'),
        deleteWorkspace: t('deleteWorkspace'),
        deleteDescription: t('deleteDescription'),
        deleteTitle: t('deleteTitle'),
        deleteDialog: (name) => t('deleteDialog', { name }),
        consequencesTitle: t('consequencesTitle'),
        consequences: [
          t('consequences.sessions'),
          t('consequences.automation'),
          t('consequences.integrations'),
          t('consequences.managedRepo'),
          t('consequences.access'),
        ],
        reassurance: t('reassurance'),
        keepWorkspace: t('keepWorkspace'),
      }}
      isLoading={projectQuery.isLoading}
      isError={projectQuery.isError}
      errorMessage={(projectQuery.error as Error)?.message ?? ''}
      onRetry={() => projectQuery.refetch()}
      generalFieldsSlot={
        project ? <GeneralWorkspaceCard project={project} canManage={canEdit} /> : undefined
      }
      // No git-repo slot: Git repo is its own Settings section since
      // 2026-09-03 (`project-settings-sections.ts`).
      canDelete={canDelete}
      workspaceName={project?.name}
      archiveOpen={archiveOpen}
      onOpenArchiveDialog={() => setArchiveOpen(true)}
      onCloseArchiveDialog={() => setArchiveOpen(false)}
      onConfirmArchive={() => archiveMutation.mutate()}
      isArchivePending={archiveMutation.isPending}
      transferSlot={
        <TransferWorkspaceEntry
          projectId={projectId}
          currentAccountId={project?.account_id}
        />
      }
    />
  );
}
