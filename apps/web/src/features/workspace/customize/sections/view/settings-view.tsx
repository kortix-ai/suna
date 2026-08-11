'use client';

import { useTranslations } from 'next-intl';

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';

import { useDebounce } from '@/hooks/use-debounce';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import type { GlyphSelection } from '@/components/ui/glyph-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Github } from '@/features/icon/icons/github';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  buildWorkspaceEditPatch,
  type WorkspaceEditDraft,
  type WorkspaceEditSubject,
} from '@/features/workspaces/modal/workspace-edit-patch';
import {
  WorkspaceIconField,
  type WorkspaceIconValue,
} from '@/features/workspaces/modal/workspace-icon-field';
import {
  renameOnError,
  renameOnMutate,
  renameOnSettled,
} from '@/hooks/workspaces/workspace-rename-cache';
import { suppressAutoWorkspaceAfterDelete } from '@/lib/onboarding/ensure-first-workspace';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import {
  archiveWorkspace,
  getWorkspace,
  inviteRepoCollaborator,
  isManagedGithubWorkspace,
  listWorkspaceBranches,
  listWorkspacesForAccount,
  listWorkspaceTriggers,
  setWorkspaceTriggersActivation,
  updateWorkspace,
  type KortixWorkspace,
  type WorkspaceInput,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { TrashIcon } from '@phosphor-icons/react';
import CustomizeSectionWrapper from '../component/section-wrapper';

export interface RunWorkspaceArchiveClient {
  archiveWorkspace: (workspaceId: string) => Promise<unknown>;
}

/**
 * The archive mutation's real side effects, pulled out of the component so
 * this exact wiring can be pinned with a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — process-wide in this monorepo and a
 * hazard for sibling suites (see ensure-first-workspace.provision.test.ts /
 * use-create-workspace.test.ts, which use this same injected-client shape).
 *
 * Ported from the deleted `/workspaces` list page's archive handler
 * (`app/(app)/workspaces/page.tsx`, pre-Task-21): "Archiving the LAST workspace
 * must leave the account empty. Without this the auto-provision door would
 * see zero active workspaces and immediately recreate one, undoing the delete
 * the user just confirmed." Same condition (`<= 1`, evaluated against the
 * workspace count from BEFORE this archive lands), same tab-scoped
 * `sessionStorage` guard (`suppressAutoWorkspaceAfterDelete`) — deliberately
 * NOT `localStorage`: a later sign-in or a fresh tab must still auto-provision
 * for an empty account like any other.
 *
 * `onSuppress` only runs after `client.archiveWorkspace` resolves — a failed
 * archive must not suppress auto-provision for a workspace that still exists.
 *
 * `remainingWorkspaceCountBeforeArchive` is `number | null`, NOT the deleted
 * page's plain number: that page's count and its Archive button read the
 * SAME query, so the button could not render before the count existed. Here
 * the count is a separate, dependent query (`accountWorkspacesQuery`) that can
 * still be loading or errored when Archive is clicked. `null` means "count
 * unknown" and deliberately does NOT suppress — failing closed, because the
 * cost of skipping a suppression is one unwanted auto-create, while the cost
 * of a FALSE suppression (from an unrelated `?? 0`) is `/workspaces/start`
 * refusing to auto-create for the next empty account this tab visits, with
 * nothing left to clear the flag until this same terminal screen is reached
 * again for an account where it actually applies.
 */
export async function runWorkspaceArchive(
  workspaceId: string,
  remainingWorkspaceCountBeforeArchive: number | null,
  client: RunWorkspaceArchiveClient,
  onSuppress: () => void,
): Promise<void> {
  await client.archiveWorkspace(workspaceId);
  if (remainingWorkspaceCountBeforeArchive !== null && remainingWorkspaceCountBeforeArchive <= 1) {
    onSuppress();
  }
}

/**
 * `accountWorkspacesQuery.data` -> the count `runWorkspaceArchive` needs, kept as
 * its own exported step so the exact mapping is pinned independently of
 * TanStack Query. The bug this guards against lived in a bare
 * `accountWorkspacesQuery.data?.length ?? 0` at the call site: `undefined`
 * (still loading, OR the query errored — react-query leaves `data`
 * `undefined` in both) silently became `0`, which reads as "zero workspaces
 * remain" and fires a false suppression. `undefined` must map to `null`
 * ("unknown"), never to `0` ("confirmed empty").
 */
export function accountWorkspaceCountForArchive(data: unknown[] | undefined): number | null {
  return data ? data.length : null;
}

export function SettingsView({ workspaceId }: { workspaceId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);

  const workspaceQuery = useQuery({
    queryKey: qk.workspace.summary(workspaceId),
    queryFn: () => getWorkspace(workspaceId),
    ...contract('config'),
  });

  const workspace = workspaceQuery.data;
  const canManage = workspace?.effective_workspace_role === 'manager';
  // Real per-leaf write cap: a custom role granted workspace.write edits the
  // general controls (name/repo) without being a full manager. Feature flags
  // moved to their own section and gate on workspace.customize.write there.
  // The mutating routes assert workspace.write, so a READ-only role sees the
  // section read-only. Archive/danger-zone stays manager-only below.
  const canWrite = useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_WRITE).allowed === true;
  const canEdit = canManage || canWrite;

  // Same `qk.workspaces.list(accountId)` cache entry the workspace switcher and
  // /new already fetch with, so this is warm (no extra request) for the common
  // case of opening Settings from a workspace the sidebar has already loaded.
  // That sharing is the whole point, and it is what makes the key mandatory
  // rather than cosmetic: a hand-typed key here is a DIFFERENT entry, which
  // silently costs a second request and lets the two counts disagree.
  // Read, not re-derived from `workspace`: this is the account's PROJECT
  // COUNT before the archive commits, which `runWorkspaceArchive` needs to
  // decide whether this was the last one.
  const accountId = workspace?.account_id;
  const accountWorkspacesQuery = useQuery({
    queryKey: qk.workspaces.list(accountId),
    queryFn: () => listWorkspacesForAccount(accountId as string),
    enabled: !!accountId,
    ...contract('inventory'),
  });

  const archiveMutation = useMutation({
    mutationFn: () =>
      runWorkspaceArchive(
        workspaceId,
        accountWorkspaceCountForArchive(accountWorkspacesQuery.data),
        { archiveWorkspace },
        suppressAutoWorkspaceAfterDelete,
      ),
    onSuccess: () => {
      successToast('Workspace archived');
      // qk.workspaces.scope(): for a single-account user the archived
      // workspace's account IS the primary account qk.workspaces.list() (no
      // args) resolves to, so a precise invalidation would leave the
      // marketplace picker showing the archived workspace until gcTime
      // evicts it. Archiving is rare — over-invalidating costs nothing.
      queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() });
      setArchiveOpen(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to archive workspace'),
  });

  return (
    <CustomizeSectionWrapper title="Settings" description="Manage your workspace settings">
      {workspaceQuery.isLoading && (
        <div className="space-y-5">
          <Skeleton className="h-56 rounded-md" />
          <Skeleton className="h-72 rounded-md" />
        </div>
      )}

      {workspaceQuery.isError && (
        <ErrorState
          size="sm"
          title={tHardcodedUi.raw(
            'appProjectsIdCustomizeSettingsPage.line86JsxAttrTitleFailedToLoadProject',
          )}
          description={(workspaceQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => workspaceQuery.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {workspace && (
        <div className="space-y-8">
          <GeneralWorkspaceCard workspace={workspace} canManage={canEdit} />
          <RepositoryCard workspace={workspace} canManage={canEdit} />
          {canManage && (
            <section className="space-y-4">
              <Label>Automation</Label>
              <TriggersActivationCard workspaceId={workspaceId} canManage={canEdit} />
            </section>
          )}
          {canManage && (
            <section className="space-y-4">
              <Label>
                {tHardcodedUi.raw(
                  'appProjectsIdCustomizeSettingsPage.line110JsxAttrTitleDangerZone',
                )}
              </Label>
              <div className="bg-popover rounded-md border px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-medium">
                      {tHardcodedUi.raw(
                        'appProjectsIdCustomizeSettingsPage.line116JsxTextArchiveProject',
                      )}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                      {tHardcodedUi.raw(
                        'appProjectsIdCustomizeSettingsPage.line119JsxTextHideThisProjectFromTheActiveProjectList',
                      )}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    className="shrink-0"
                    size="sm"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <TrashIcon className="size-4" />
                    Archive
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={tHardcodedUi.raw(
          'appProjectsIdCustomizeSettingsPage.line140JsxAttrTitleArchiveProject',
        )}
        description={
          workspace ? `Archive ${workspace.name}? Current sessions remain recoverable.` : ''
        }
        confirmLabel="Archive"
        onConfirm={() => archiveMutation.mutate()}
        isPending={archiveMutation.isPending}
      />
    </CustomizeSectionWrapper>
  );
}

function RepositoryCard({
  workspace,
  canManage,
}: {
  workspace: KortixWorkspace;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const repoUrl = workspace.repo_url;
  const githubUrl = githubRepoWebUrl(repoUrl);
  const repoLabel = githubUrl?.replace('https://github.com/', '') || repoUrl || '-';
  const managed = isManagedGithubWorkspace(workspace);
  const branchesQuery = useQuery({
    queryKey: qk.workspace.branches(workspace.workspace_id),
    queryFn: () => listWorkspaceBranches(workspace.workspace_id),
    ...contract('config'),
  });
  const branchNames = Array.from(
    new Set([
      workspace.default_branch,
      ...(branchesQuery.data?.branches.map((branch) => branch.name) ?? []),
    ]),
  );

  const [defaultBranch, setDefaultBranch] = useState(workspace.default_branch);
  const [manifestPath, setManifestPath] = useState(workspace.manifest_path);
  const { debouncedValue: debouncedBranch, isLoading: isDebouncingBranch } = useDebounce(
    defaultBranch,
    500,
  );
  const { debouncedValue: debouncedManifest, isLoading: isDebouncingManifest } = useDebounce(
    manifestPath,
    500,
  );

  useEffect(() => {
    setDefaultBranch(workspace.default_branch);
    setManifestPath(workspace.manifest_path);
  }, [workspace.default_branch, workspace.manifest_path]);

  const mutation = useMutation({
    mutationFn: (patch: { default_branch: string; manifest_path: string }) =>
      updateWorkspace(workspace.workspace_id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.workspace.summary(workspace.workspace_id), updated);
      // qk.workspaces.scope(): reaches every account's list (and the
      // accountless slot the marketplace picker reads), restoring the reach
      // the old bare workspaces-literal prefix match had. Repo-settings edits
      // are rare — over-invalidating costs nothing.
      queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() });
      queryClient.invalidateQueries({ queryKey: qk.workspace.branches(workspace.workspace_id) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update repository'),
  });

  const { mutate, isPending } = mutation;

  useEffect(() => {
    if (!canManage || isPending) return;

    const branch = debouncedBranch.trim();
    const manifest = debouncedManifest.trim();
    if (!branch) return;
    if (branch === workspace.default_branch && manifest === workspace.manifest_path) return;

    mutate({ default_branch: branch, manifest_path: manifest });
  }, [
    debouncedBranch,
    debouncedManifest,
    canManage,
    workspace.default_branch,
    workspace.manifest_path,
    isPending,
    mutate,
  ]);

  const saving = isDebouncingBranch || isDebouncingManifest || isPending;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Label>Repository</Label>
        {githubUrl ? (
          <Button asChild variant="transparent" size="sm">
            <Link href={githubUrl} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </Link>
          </Button>
        ) : null}
      </div>

      <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="default-branch">
                {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line270JsxTextDefaultBranch')}
              </FieldLabel>
              {saving ? <SaveStatus /> : null}
            </div>
            <Select
              value={defaultBranch}
              onValueChange={setDefaultBranch}
              disabled={!canManage || isPending}
            >
              <SelectTrigger id="default-branch" className="font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branchNames.map((branch) => (
                  <SelectItem key={branch} value={branch} className="font-mono text-xs">
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              New sessions and change requests use this branch as their base.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="manifest-path">
              {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line280JsxTextManifestPath')}
            </FieldLabel>
            <Input
              id="manifest-path"
              value={manifestPath}
              onChange={(e) => setManifestPath(e.target.value)}
              disabled={!canManage || isPending}
              className="font-mono text-xs"
              variant="popover"
            />
          </Field>
        </FieldGroup>

        {managed ? (
          <div className="border-border/60 border-t pt-5">
            <RepoCollaboratorInvite workspaceId={workspace.workspace_id} canManage={canManage} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TriggersActivationCard({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  // Same entity/fetcher `ScheduleView` (components/workspaces/schedule-view.tsx)
  // reads — both must share this key or a pause/resume here goes unseen there.
  const queryKey = qk.workspace.triggers(workspaceId);
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listWorkspaceTriggers(workspaceId),
    ...contract('config'),
  });
  const paused = triggersQuery.data?.triggers_paused ?? false;

  const mutation = useMutation({
    mutationFn: (next: boolean) => setWorkspaceTriggersActivation(workspaceId, next),
    onSuccess: (data, next) => {
      queryClient.setQueryData(queryKey, data);
      successToast(next ? 'All triggers paused for this workspace' : 'Triggers resumed');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update trigger activation'),
  });

  return (
    <Field orientation="horizontal" className="bg-popover rounded-md border px-4 py-3">
      <FieldContent>
        <FieldTitle>
          Pause all triggers
          {paused && <span className="text-muted-foreground font-normal"> · paused</span>}
        </FieldTitle>
        <FieldDescription>
          Dev kill-switch — stop the platform auto-running this workspace&apos;s schedules &amp;
          webhooks (manual test-fires still work). Use it when another environment owns the
          triggers.
        </FieldDescription>
      </FieldContent>
      <Switch
        checked={paused}
        disabled={!canManage || mutation.isPending || triggersQuery.isLoading}
        onCheckedChange={(v) => mutation.mutate(v)}
        aria-label="Pause all triggers for this workspace"
      />
    </Field>
  );
}

function RepoCollaboratorInvite({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');

  const inviteMutation = useMutation({
    mutationFn: () => inviteRepoCollaborator(workspaceId, username.trim(), permission),
    onSuccess: (res) => {
      if (res.alreadyCollaborator) {
        successToast(`@${res.username} already has access to this repo`);
      } else {
        successToast(`Invite sent to @${res.username} — they accept it on GitHub to get access`);
      }
      setUsername('');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    if (username.trim() && !inviteMutation.isPending) inviteMutation.mutate();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextAddPeople18915e9b',
          )}
        </p>
        <p className="text-muted-foreground text-xs text-pretty">
          Invite GitHub collaborators to this repository.
        </p>
      </div>

      {canManage ? (
        <form onSubmit={submit}>
          <FieldGroup className="gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8.5rem_auto] sm:items-end sm:gap-x-3">
              <Field>
                <div className="relative min-w-0">
                  <Github className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                  <Input
                    id="repo-collaborator-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={tI18nHardcoded.raw(
                      'autoComponentsProjectsCustomizeSectionsSettingsViewJsxAttrPlaceholderGitHub84efb7a1',
                    )}
                    variant="popover"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="pl-9"
                  />
                </div>
              </Field>

              <Field>
                <Select
                  value={permission}
                  onValueChange={(v) => setPermission(v as 'read' | 'write')}
                >
                  <SelectTrigger id="repo-collaborator-permission" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="write">
                      {tI18nHardcoded.raw(
                        'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextCanEdit2eb88c1b',
                      )}
                    </SelectItem>
                    <SelectItem value="read">
                      {tI18nHardcoded.raw(
                        'autoComponentsProjectsCustomizeSectionsSettingsViewJsxTextCanView39f4dd36',
                      )}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <Button
                  type="submit"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={!username.trim() || inviteMutation.isPending}
                >
                  {inviteMutation.isPending ? <Loading className="size-3.5" /> : null}
                  Add
                </Button>
              </Field>
            </div>
          </FieldGroup>
        </form>
      ) : null}
    </div>
  );
}

function githubRepoWebUrl(repoUrl: string | null | undefined): string | null {
  const normalized = repoUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!normalized) return null;

  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) {
    return `https://github.com/${ssh[1]}/${ssh[2]}`;
  }

  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) {
    return `https://github.com/${https[1]}/${https[2]}`;
  }

  return null;
}

/**
 * The field's union, seeded from the workspace's two independent stored
 * columns. Glyph wins if — despite the server invariant — a stale row
 * somehow carries both, matching `EntityAvatar`'s own glyph > emoji
 * precedence rather than inventing a different tiebreak here. Ported from
 * the deleted Workspace edit modal, which needed the identical seed.
 */
function toIconValue(icon?: string | null, glyph?: GlyphSelection | null): WorkspaceIconValue {
  if (glyph) return { glyph };
  if (icon) return { emoji: icon };
  return null;
}

/**
 * What `GeneralWorkspaceCard`'s combined name+icon autosave sends to
 * `updateWorkspace`, or `null` when there is nothing to send — pulled out so
 * this exact wiring is under test without mounting the component or mocking
 * `@kortix/sdk` (same DI shape `runWorkspaceArchive` above uses, and for the
 * same reason: `mock.module('@kortix/sdk', ...)` is process-wide in this
 * monorepo and a hazard for sibling suites).
 *
 * Thin wrapper over `buildWorkspaceEditPatch` (`workspace-edit-patch.ts`), which
 * already owns the union-diffing rules — including the invariant this field
 * exists to prove: `icon` and `icon_glyph` are never both present in the same
 * patch, because the API deletes whichever one a write does NOT name. This
 * function only pins what THIS card feeds that shared diff: the live workspace
 * as `subject`, the name input plus the icon field's current value as
 * `draft`.
 */
export function buildWorkspaceSavePatch(
  subject: WorkspaceEditSubject,
  draft: WorkspaceEditDraft,
): Partial<WorkspaceInput> | null {
  const edit = buildWorkspaceEditPatch(subject, draft);
  return edit.status === 'ready' ? edit.patch : null;
}

function GeneralWorkspaceCard({
  workspace,
  canManage,
}: {
  workspace: Awaited<ReturnType<typeof getWorkspace>>;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState<WorkspaceIconValue>(() =>
    toIconValue(workspace.icon, workspace.icon_glyph),
  );
  const { debouncedValue: debouncedName, isLoading: isDebouncing } = useDebounce(name, 500);

  useEffect(() => {
    setName(workspace.name);
    setIcon(toIconValue(workspace.icon, workspace.icon_glyph));
  }, [workspace.name, workspace.icon, workspace.icon_glyph]);

  const mutation = useMutation({
    mutationFn: (patch: Partial<WorkspaceInput>) => updateWorkspace(workspace.workspace_id, patch),
    // Paint the new name in the same frame it's typed, snapshotting what it
    // overwrote so a REJECTED rename can put it back. `renameOnMutate` /
    // `renameOnError` / `renameOnSettled` were shared with
    // `edit-workspace-modal.tsx` so the two rename paths could not drift; that
    // modal is gone and this card is now the only rename path, but the trio
    // stays because it owns the snapshot/restore invariant, not the sharing.
    //
    // `patch.name`, not the whole patch: this mutation carries icon edits too
    // (migrated here from that modal), and `renameOnMutate` returns
    // `undefined` for a patch with no `name` — an icon-only save writes
    // nothing optimistic and so has nothing to roll back.
    onMutate: (patch) => renameOnMutate(queryClient, workspace.workspace_id, patch.name),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.workspace.summary(workspace.workspace_id), updated);
    },
    onError: (error: Error, _patch, context) => {
      renameOnError(queryClient, workspace.workspace_id, context);
      errorToast(error.message || 'Failed to update workspace');
    },
    onSettled: () => renameOnSettled(queryClient, workspace.workspace_id),
  });

  const { mutate, isPending } = mutation;

  // One effect for both fields, same shape as `RepositoryCard`'s combined
  // branch+manifest save above. Name still only fires once its debounce
  // settles; the icon field is a discrete pick (not continuous typing), so
  // it saves the moment `icon` changes — no artificial delay, matching
  // `ExperimentalFeatureRow`'s switch. `buildWorkspaceSavePatch` computes the
  // diff against the LIVE workspace on every run, so an icon pick made mid-name
  // -edit (before the debounce settles) sends only the icon key, never a
  // half-typed name.
  useEffect(() => {
    if (!canManage || isPending) return;

    const patch = buildWorkspaceSavePatch(
      { name: workspace.name, icon: workspace.icon, icon_glyph: workspace.icon_glyph },
      { name: debouncedName, icon },
    );
    if (!patch) return;

    mutate(patch);
  }, [
    debouncedName,
    icon,
    canManage,
    workspace.name,
    workspace.icon,
    workspace.icon_glyph,
    isPending,
    mutate,
  ]);

  const saving = isDebouncing || isPending;

  return (
    <section className="space-y-4">
      <Label htmlFor="workspace-name">General</Label>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="workspace-name">
            {tHardcodedUi.raw('appProjectsIdCustomizeSettingsPage.line259JsxTextProjectName')}
          </FieldLabel>
          {saving ? <SaveStatus /> : null}
        </div>
        {/* Icon trigger as a peer of the name input, not a field of its own —
            same row treatment the deleted create/edit modals and `/new` use
            for the identical pairing (`items-start`: both controls are 9
            units tall today, and it stays correct if the input ever grows a
            second line). `onClear` IS passed here — unlike `/new`'s create
            surface, this workspace's icon is already saved, so removing it is
            a real, undoable-only-by-picking-again action. */}
        <div className="flex items-start gap-2">
          <WorkspaceIconField
            value={icon}
            onChange={(emoji) => setIcon({ emoji })}
            onGlyphChange={(glyph) => setIcon({ glyph })}
            onClear={() => setIcon(null)}
            disabled={!canManage || isPending}
          />
          <div className="min-w-0 flex-1">
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage || isPending}
              maxLength={120}
              variant="popover"
            />
          </div>
        </div>
      </Field>
    </section>
  );
}

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}
