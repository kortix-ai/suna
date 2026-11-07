'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '../../../primitives/button';
import type { GlyphSelection } from '../../../primitives/glyph-picker';
import { Input } from '../../../primitives/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../primitives/select';
import { SettingsRow, SettingsRowGroup } from '../../../primitives/settings-row';
import { SettingsSubsectionHeader } from '../../../primitives/settings-subsection-header';
import { Skeleton } from '../../../primitives/skeleton';
import { errorToast, successToast } from '../../../primitives/toast';
import { TypeToConfirmDialog } from '../../../primitives/type-to-confirm-dialog';
import { ErrorState } from '../../../primitives/error-state';
import { CopyRow } from '../../../access/access/copy-row';
import {
  ProjectIconField,
  type ProjectIconValue,
} from '../../../workspace/projects/modal/project-icon-field';
import {
  renameOnError,
  renameOnMutate,
  renameOnSettled,
} from '../../../internal/hooks/projects/project-rename-cache';
import { useDebounce } from '../../../hooks/use-debounce';
import { useTranslations } from '../../../i18n';
import { PROJECT_LANDING_PATH } from '../../../internal/lib/onboarding/landing-destination';
import { forgetLastProjectId } from '../../../internal/lib/onboarding/last-project-cookie';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCans } from '../../../internal/lib/use-project-can';
import { useCan } from '../../../internal/lib/use-permission';
import { useSettingsPanelStore } from '../../../internal/stores/settings-panel-store';
import { useLeaveWorkspace } from '../../../workspace/settings/use-leave-workspace';
import { SplitNoticeBanner } from '../../../workspace/settings/split-notice-banner';
import {
  deleteWorkspace,
  getProject,
  setDefaultReasoningEffort,
  updateProject,
  type KortixProject,
  type ProjectInput,
} from '@kortix/sdk';
import { contract, invalidateProjectIdentity, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiRouter, useUiViewerId } from '../../../providers/ui-provider';
import { SettingsTabHeader } from '../settings-tab-header';

/** Asked for in ONE batched probe. `project.delete` and `project.settings.write` are
 *  separate permissions — see `ProjectSettingsGeneralProps.canDelete`. */
const GENERAL_TAB_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE,
  PROJECT_ACTIONS.PROJECT_DELETE,
] as const;

/** The effort ladder the default-effort picker offers. These are models.dev
 *  variant ids — technical values, shown capitalized like the composer's
 *  own effort selector does (its `label`), never translated.
 *
 *  The API clamps the stored default at delivery to what the session's model
 *  actually publishes (`effortVariantForPrompt`), so a pick the session's
 *  model does not carry degrades to Automatic rather than breaking the turn;
 *  the picker still offers the superset the catalog carries. */
const DEFAULT_EFFORT_OPTIONS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const DEFAULT_EFFORT_AUTOMATIC = '';

/** `medium` → `Medium` — same casing rule as the composer's effort selector. */
const effortOptionLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export const DELETE_WORKSPACE_CONSEQUENCES = [
  'Every member loses access to this workspace',
  'Triggers and scheduled runs stop firing',
  'Its API keys and connected apps stop working',
  // workspaces/lifecycle.ts closeWorkspace: a live Stripe subscription is set
  // to cancel at period end; a restore reactivates it.
  'A paid plan is set to cancel at the end of its billing period; restoring the workspace keeps it',
  'After 14 days, its sessions, files, and Kortix-managed repository are erased',
] as const;

/** Stated because it is true and because its absence would be read as a
 *  denial. `deleteManagedProjectRepo` deletes only the Kortix-managed
 *  upstream; repositories the user connected themselves are never touched
 *  (`apps/api/src/projects/routes/project-settings.ts`). */
export const DELETE_WORKSPACE_REASSURANCE =
  'Git repositories you connected yourself are not deleted.';

/**
 * A section label between two groups — plain small text, optionally one line
 * of explanation, sitting above the next group. No border and no background,
 * so the bordered group below it reads as the thing being labelled. Still an
 * `h2` so the pane keeps a real heading outline.
 *
 * Deliberately duplicated in `profile-tab.tsx` rather than shared: the two
 * Linear restyles landed in parallel and neither should have edited the other
 * agent's file. Promote it to `packages/ui/src/primitives/settings-row.tsx` once a third
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
  /** The workspace id, shown with a copy button. */
  workspaceId?: string;
  /** The caller may leave (not the last owner). */
  canLeave?: boolean;
  onOpenLeaveDialog?: () => void;
  /** The Leave confirmation (a container concern: it owns the mutation). */
  leaveDialog?: ReactNode;
  /** Whether the Delete-workspace section shows at all — gated on
   *  `project.delete`, NOT the broader `project.settings.write` gate
   *  `generalFieldsSlot`'s fields use. Deleting and editing are separate
   *  permissions, so a custom role can grant one without the other. */
  canDelete?: boolean;
  workspaceName?: string;
  archiveOpen?: boolean;
  onOpenArchiveDialog?: () => void;
  onCloseArchiveDialog?: () => void;
  onConfirmArchive?: () => void;
  isArchivePending?: boolean;
  /**
   * `all` (default): the whole tab. Workspace settings splits it in two rail
   * rows: `settings` (General: name, icon, workspace id) and `danger` (Danger
   * zone: Leave and Delete workspace, with their dialogs).
   */
  part?: GeneralTabPart;
}

export type GeneralTabPart = 'all' | 'settings' | 'danger';

export interface GeneralTabCopy {
  loadFailed: string;
  retry: string;
  workspaceId: string;
  workspaceIdDescription: string;
  leaveWorkspace: string;
  leaveDescription: string;
  leaveTitle: string;
  leaveDialog: (name: string) => ReactNode;
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
  loadFailed: 'Failed to load workspace',
  retry: 'Retry',
  workspaceId: 'Workspace ID',
  workspaceIdDescription: 'For the CLI, the API, and support.',
  leaveWorkspace: 'Leave workspace',
  leaveDescription: 'You lose access to this workspace. An admin can invite you again.',
  leaveTitle: 'Leave workspace?',
  leaveDialog: (name) => `You lose access to ${name}. An admin can invite you again.`,
  dangerZone: 'Danger zone',
  deleteWorkspace: 'Delete workspace',
  deleteDescription: 'Deletes this workspace for every member. You can restore it for 14 days.',
  deleteTitle: 'Delete workspace?',
  deleteDialog: (name) => `This deletes ${name} for every member. You can restore it for 14 days.`,
  consequencesTitle: 'Straight away:',
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
  workspaceId,
  canLeave = false,
  onOpenLeaveDialog = () => {},
  leaveDialog,
  canDelete = true,
  workspaceName = '',
  archiveOpen = false,
  onOpenArchiveDialog = () => {},
  onCloseArchiveDialog = () => {},
  onConfirmArchive = () => {},
  isArchivePending = false,
  part = 'all',
}: GeneralTabViewProps) {
  const showSettings = part !== 'danger';
  const showDanger = part !== 'settings';
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      {showSettings ? <SettingsTabHeader tab="general" /> : null}

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
          {showSettings ? generalFieldsSlot : null}
          {showSettings && workspaceId ? (
            <SettingsRowGroup>
              <SettingsRow label={copy.workspaceId} description={copy.workspaceIdDescription}>
                <CopyRow value={workspaceId} className="w-full max-w-80" />
              </SettingsRow>
            </SettingsRowGroup>
          ) : null}
          {showDanger && (canDelete || canLeave) ? (
            <section className="space-y-3">
              <SettingsSubsectionHeader title={copy.dangerZone} />
              <SettingsRowGroup>
                {canLeave ? (
                  <SettingsRow label={copy.leaveWorkspace} description={copy.leaveDescription}>
                    <Button variant="outline" size="sm" onClick={onOpenLeaveDialog}>
                      {copy.leaveWorkspace}
                    </Button>
                  </SettingsRow>
                ) : null}
                {canDelete ? (
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
                ) : null}
              </SettingsRowGroup>
            </section>
          ) : null}
        </>
      )}

      {leaveDialog}
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
  /** Drop the project from the cached project lists. Runs before `onLeave`:
   *  the door decides from the cache at once, and a list that still names
   *  the deleted project sent the browser straight back to it (KRTX-2904). */
  onDropCached?: () => void,
): Promise<void> {
  await client.archiveProject(projectId);
  onForget?.();
  onDropCached?.();
  onLeave?.(PROJECT_LANDING_PATH);
}

/** A cached project list without `projectId`; any other cached value (the
 *  quota under the same key prefix) is returned unchanged. */
export function withoutProject(data: unknown, projectId: string): unknown {
  if (!Array.isArray(data)) return data;
  return data.filter((p: { project_id?: string }) => p?.project_id !== projectId);
}

/** Workspace name + icon. Moved from `settings-view.tsx`'s
 *  `GeneralProjectCard` (name — see this file's header comment for what's
 *  byte-identical) and extended with icon editing, reusing `ProjectIconField`
 *  / `buildProjectEditPatch` unmodified — see this file's header comment. */
function GeneralWorkspaceCard({
  project,
  canManage,
  canManageEffort,
}: {
  project: KortixProject;
  canManage: boolean;
  canManageEffort: boolean;
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
  // forever. Skipping the attempted name breaks that loop: a save, failed or
  // successful, idles until the user edits again (any settled edit that
  // differs clears it). A success keeps it too: the rename refetches the
  // project row (`renameOnSettled`), and a read that still returns the old
  // name would otherwise re-send the same rename on every refetch.
  const attemptedName = useRef<string | null>(null);

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
      errorToast(error.message || t('updateFailed'));
    },
    onSettled: () => renameOnSettled(queryClient, project.project_id),
  });

  const { mutate: mutateName, isPending: isRenamePending } = renameMutation;

  const effortMutation = useMutation({
    mutationFn: (effort: string | null) => setDefaultReasoningEffort(project.project_id, effort),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.project.summary(project.project_id), updated);
    },
    onError: (error: Error) => errorToast(error.message || t('updateFailed')),
  });

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
    // The project id travels with each save: a debounced save runs after the
    // pick, and by then this tab may be showing a different project.
    mutationFn: ({ projectId, patch }: { projectId: string; patch: Partial<ProjectInput> }) =>
      updateProject(projectId, patch),
    onSuccess: (updated, { projectId }) => {
      queryClient.setQueryData(qk.project.summary(projectId), updated);
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
    onSettled: (_data, _error, { projectId }) => invalidateProjectIdentity(queryClient, projectId),
  });

  // `draft.name` is always the SERVER-confirmed name (`project.name`), never
  // the local `name` draft above — so an icon pick can never accidentally
  // also send a half-typed, not-yet-debounced rename. See this file's header
  // comment.
  // The picker stays open while you try icons and colours, so the trigger
  // shows a local draft at once and the PATCH waits for a 400 ms pause: a
  // colour drag sends one request, not one per pointer move.
  //
  // Each save sends the chosen icon outright rather than a diff against
  // `project`: while an earlier PATCH is in flight `project` is stale, and a
  // diff would skip going back to the stored icon. Saves chain, so they reach
  // the server in pick order. Leaving the page sends a pending save at once
  // instead of dropping it. The draft drops when the last save settles.
  const [draftIcon, setDraftIcon] = useState<ProjectIconValue | undefined>(undefined);
  const iconSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIcon = useRef<{ projectId: string; icon: ProjectIconValue } | undefined>(undefined);
  const iconSaveChain = useRef<Promise<unknown>>(Promise.resolve());
  const iconSaveSeq = useRef(0);
  const flushIcon = () => {
    if (iconSaveTimer.current) clearTimeout(iconSaveTimer.current);
    iconSaveTimer.current = null;
    const pending = pendingIcon.current;
    if (pending === undefined) return;
    pendingIcon.current = undefined;
    const { projectId, icon: next } = pending;
    const seq = ++iconSaveSeq.current;
    const patch: Partial<ProjectInput> =
      next === null
        ? { icon: null, icon_glyph: null }
        : 'glyph' in next
          ? { icon_glyph: next.glyph }
          : { icon: next.emoji };
    iconSaveChain.current = iconSaveChain.current
      .catch(() => undefined)
      .then(() => iconMutation.mutateAsync({ projectId, patch }))
      // The mutation's own onError already toasts the failure.
      .catch(() => undefined)
      .finally(() => {
        // Only the latest save may drop the draft: an earlier one settling
        // while a later save is queued would flash the older icon.
        if (seq === iconSaveSeq.current && pendingIcon.current === undefined) setDraftIcon(undefined);
      });
  };
  const flushIconRef = useRef(flushIcon);
  useEffect(() => {
    flushIconRef.current = flushIcon;
  });
  useEffect(() => () => flushIconRef.current(), []);
  // Switching project in place: send the pending pick to the project it was
  // made on, and drop the draft so the new project shows its own icon.
  const shownProjectId = project.project_id;
  useEffect(
    () => () => {
      flushIconRef.current();
      setDraftIcon(undefined);
    },
    [shownProjectId],
  );
  const applyIcon = (nextIcon: ProjectIconValue) => {
    setDraftIcon(nextIcon);
    pendingIcon.current = { projectId: project.project_id, icon: nextIcon };
    if (iconSaveTimer.current) clearTimeout(iconSaveTimer.current);
    iconSaveTimer.current = setTimeout(() => flushIconRef.current(), 400);
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
          value={draftIcon !== undefined ? draftIcon : toIconValue(project.icon, project.icon_glyph)}
          onChange={(emoji) => applyIcon({ emoji })}
          onGlyphChange={(glyph) => applyIcon({ glyph })}
          onClear={() => applyIcon(null)}
          disabled={!canManage}
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
      {/* The project-wide default effort. '' (= null on the wire) means
          automatic. Delivery injects the stored value only when a prompt
          carries no variant of its own, so this can never fight an explicit
          pick made in a session. (The sandbox-provider pin instead uses a
          distinct '__auto__' sentinel; here the empty string maps 1:1 to the
          wire's null, so no extra token is needed.) */}
      <SettingsRow label={t('defaultEffort')} description={t('defaultEffortDescription')}>
        <Select
          value={project.default_reasoning_effort ?? DEFAULT_EFFORT_AUTOMATIC}
          onValueChange={(v) =>
            effortMutation.mutate(v === DEFAULT_EFFORT_AUTOMATIC ? null : v)
          }
          disabled={!canManageEffort || effortMutation.isPending}
        >
          <SelectTrigger aria-label={t('defaultEffort')} className="h-8 w-40 shrink-0">
            <SelectValue placeholder={t('defaultEffortAutomatic')} />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={DEFAULT_EFFORT_AUTOMATIC}>{t('defaultEffortAutomatic')}</SelectItem>
            {DEFAULT_EFFORT_OPTIONS.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effortOptionLabel(effort)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsRowGroup>
  );
}

/** Container: owns every hook (React Query, IAM probe, archive dialog state)
 *  and renders `GeneralTabView` with real data + slots. Only ever mounted
 *  while this tab is active (`SettingsTabPane` in `settings-panel.tsx`
 *  returns `null` otherwise), so nothing here fetches on panel open. */
export function GeneralTab({
  projectId,
  slot,
  part = 'all',
}: {
  projectId: string;
  /** Which half Workspace settings shows (see `GeneralTabViewProps.part`). */
  part?: GeneralTabPart;
  /** Rendered after the name and icon, before the Danger zone: the workspace's
   *  account settings (security policy) in Workspace settings › General. */
  slot?: ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.workspace');
  const tWorkspaces = useTranslations('workspaces.settings');
  const queryClient = useQueryClient();
  const router = useUiRouter();
  const viewerId = useUiViewerId();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const leave = useLeaveWorkspace(projectId);

  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });

  const project = projectQuery.data;
  // Two DIFFERENT permissions, asked for separately. `project.delete` gates the
  // Delete-workspace section; `project.settings.write` gates the fields. Reading a
  // `manager` role label instead would have hidden Delete from a custom role
  // that holds `project.delete`, and shown it to one that does not.
  const caps = useProjectCans(projectId, GENERAL_TAB_ACTIONS);
  // Deleting a workspace closes its account (billing, members, keys): the API
  // also asks for the owner-only `account.delete`. Show Delete only to a
  // person who holds both.
  const closeAccount = useCan({ accountId: project?.account_id ?? undefined }, 'account.delete');
  const canDelete = caps[PROJECT_ACTIONS.PROJECT_DELETE]?.allowed === true && closeAccount.allowed === true;
  const canEdit = caps[PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE]?.allowed === true;
  const canEditEffort = canEdit;

  const archiveMutation = useMutation({
    mutationFn: () =>
      runProjectArchive(
        projectId,
        // DELETE /v1/workspaces/:id closes the workspace: members lose access
        // now, owners can restore it until `deletion_scheduled_for` (K2).
        { archiveProject: (id: string) => deleteWorkspace(id) },
        // The archived project must stop being where `/` and the settings
        // exit land (JAY-729) — otherwise they redirect into a 404 gate.
        () => forgetLastProjectId(viewerId, projectId),
        // The overlay's open state is global, so close it first or it would
        // reopen over the next project. `replace`: Back must not return to
        // the deleted project.
        (path) => {
          useSettingsPanelStore.getState().close();
          router.replace(path);
        },
        () =>
          queryClient.setQueriesData({ queryKey: qk.projects.scope() }, (old: unknown) =>
            withoutProject(old, projectId),
          ),
      ),
    onSuccess: () => {
      successToast(tWorkspaces('deletedToast'));
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
      part={part}
      copy={{
        loadFailed: t('loadFailed'),
        retry: t('retry'),
        workspaceId: tWorkspaces('workspaceId'),
        workspaceIdDescription: tWorkspaces('workspaceIdDescription'),
        leaveWorkspace: tWorkspaces('leaveWorkspace'),
        leaveDescription: tWorkspaces('leaveDescription'),
        leaveTitle: tWorkspaces('leaveTitle'),
        leaveDialog: (name) => tWorkspaces('leaveDialog', { name }),
        dangerZone: t('dangerZone'),
        deleteWorkspace: t('deleteWorkspace'),
        deleteDescription: t('deleteDescription'),
        deleteTitle: t('deleteTitle'),
        deleteDialog: (name) => t('deleteDialog', { name }),
        consequencesTitle: t('consequencesTitle'),
        consequences: [
          t('consequences.access'),
          t('consequences.automation'),
          t('consequences.integrations'),
          t('consequences.plan'),
          t('consequences.sessions'),
        ],
        // Deleting a workspace never deletes the person: their login stays,
        // with 0 workspaces they land on create-or-join (FAQ, DEL-6).
        reassurance: `${t('reassurance')} ${tWorkspaces('deleteKeepsLogin')}`,
        keepWorkspace: t('keepWorkspace'),
      }}
      isLoading={projectQuery.isLoading}
      isError={projectQuery.isError}
      errorMessage={(projectQuery.error as Error)?.message ?? ''}
      onRetry={() => projectQuery.refetch()}
      generalFieldsSlot={
        project ? (
          <>
            <SplitNoticeBanner workspaceId={projectId} />
            <GeneralWorkspaceCard project={project} canManage={canEdit} canManageEffort={canEditEffort} />
            {slot}
          </>
        ) : undefined
      }
      // No git-repo slot: Git repo is its own Settings section since
      // 2026-09-03 (`project-settings-sections.ts`).
      workspaceId={project?.project_id}
      canLeave={leave.canLeave}
      onOpenLeaveDialog={leave.open}
      canDelete={canDelete}
      workspaceName={project?.name}
      archiveOpen={archiveOpen}
      onOpenArchiveDialog={() => setArchiveOpen(true)}
      onCloseArchiveDialog={() => setArchiveOpen(false)}
      onConfirmArchive={() => archiveMutation.mutate()}
      isArchivePending={archiveMutation.isPending}
      leaveDialog={leave.dialog}
    />
  );
}
