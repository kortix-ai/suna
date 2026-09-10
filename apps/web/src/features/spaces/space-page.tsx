'use client';

/**
 * /projects/[id]/spaces/[slug] — a space IS the project-home surface
 * wearing a different name.
 *
 * Same wallpaper, same greeting shape, same composer, same create path
 * (`useProjectHomeSend` with the slug and the default agent). What the page
 * adds is quiet: a breadcrumb floated top-left, a ghost toolbar top-right
 * (share, `⋯`), and the space's recent sessions under the composer.
 *
 * ONE COLUMN, deliberately (user, 2026-09-07). What a space is
 * configured with now lives in its `spaces.<slug>` block of `kortix.yaml`, written by a person
 * or an agent, not in a settings panel beside the composer. The page is
 * heading + composer + a list, which is also the shape a Slack-style tab strip
 * (Chat / a dashboard / another dashboard) drops into later, under the
 * breadcrumb: the body below it is already a single scrolling column.
 */

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ProjectHome } from '@/features/workspace/project-layout/project-home';
import { useProjectHomeSend } from '@/features/workspace/project-layout/use-project-home-send';
import { AccessDialog } from '@/features/workspace/shared/access/access-dialog';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { useProjectCan } from '@/lib/use-project-can';
import {
  deleteProjectSpace,
  getProjectDetail,
  getProjectSpace,
  listProjectResourceGrants,
  updateProjectSpace,
  type ProjectResourceGrant,
  type Space,
  type SpaceSessionsMode,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag, useProjectAccountId } from '@kortix/sdk/react';
import {
  DotsThreeIcon,
  FolderSimpleIcon,
  ShareNetworkIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { SpaceRecents } from './space-recents';
import { useInvalidateSpace } from './spaces-data';

const SHARED_SESSIONS_MODE: SpaceSessionsMode = 'shared';

/** The grants naming this space. Orphaned rows (the block was deleted)
 *  are kept — they are inert, and hiding them hides the thing to clean up. */
export function grantsForSpace(
  grants: readonly ProjectResourceGrant[],
  slug: string,
): ProjectResourceGrant[] {
  return grants.filter((g) => g.resource_type === 'space' && g.resource_id === slug);
}

export function SpacePage({ projectId, slug }: { projectId: string; slug: string }) {
  const tSpaces = useI18nTranslations('spaces');
  const spacesFlag = useFeatureFlag(projectId, 'spaces');
  const query = useQuery({
    queryKey: qk.project.space(projectId, slug),
    queryFn: () => getProjectSpace(projectId, slug),
    // Off ⇒ the route 403s. Don't ask, and don't let the 404 copy below claim
    // the space was removed or ungranted when the truth is the feature is off.
    enabled: spacesFlag.enabled,
    retry: false,
    ...contract('config'),
  });

  if (spacesFlag.isLoading) return <SpacePageSkeleton />;
  if (!spacesFlag.enabled) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-16">
          <EmptyState
            icon={FolderSimpleIcon}
            size="sm"
            title={tSpaces('page.offTitle')}
            description={tSpaces('page.offDescription')}
            action={
              <Button asChild variant="outline" size="sm">
                <HoverPrefetchLink href={`/projects/${projectId}`}>
                  {tSpaces('page.backToProject')}
                </HoverPrefetchLink>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  if (query.isLoading) return <SpacePageSkeleton />;

  if (query.isError || !query.data) {
    // A `404` here is the authorization answer as much as the existence one:
    // an undeclared space and one this caller is not granted look the
    // same on purpose (spec §5.4), so the copy names both.
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-16">
          <EmptyState
            icon={FolderSimpleIcon}
            size="sm"
            title={tSpaces('page.notFoundTitle', { slug })}
            description={tSpaces('page.notFoundDescription')}
            action={
              <Button asChild variant="outline" size="sm">
                <HoverPrefetchLink href={`/projects/${projectId}`}>
                  {tSpaces('page.backToProject')}
                </HoverPrefetchLink>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return <SpaceBody projectId={projectId} space={query.data} />;
}

function SpaceBody({
  projectId,
  space,
}: {
  projectId: string;
  space: Space;
}) {
  const canManage = space.can_manage;
  const accountId = useProjectAccountId(projectId);
  const { handleSend, sending } = useProjectHomeSend(projectId, {
    accountId: accountId ?? undefined,
  });

  return (
    <ProjectHome
      projectId={projectId}
      onSend={handleSend}
      busy={sending}
      // The composer's space picker starts on THIS one; the send carries
      // whatever the picker says (`use-project-home-send.ts`).
      space={space}
      hero={{ name: space.name, description: space.description }}
      breadcrumb={<SpaceBreadcrumb projectId={projectId} space={space} />}
      toolbar={
        <SpaceToolbar projectId={projectId} space={space} canManage={canManage} />
      }
      // One column (user, 2026-09-07): the composer, then the space's
      // recent sessions. The right-hand panel that used to carry instructions,
      // context files, triggers and access is gone with them.
      below={<SpaceRecents projectId={projectId} slug={space.slug} />}
    />
  );
}

// ─── Breadcrumb ────────────────────────────────────────────────────────────

function SpaceBreadcrumb({
  projectId,
  space,
}: {
  projectId: string;
  space: Space;
}) {
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = detailQuery.data?.project?.name ?? 'Project';
  return (
    <Breadcrumb>
      <BreadcrumbList className="text-xs sm:gap-1.5">
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <HoverPrefetchLink href={`/projects/${projectId}`} className="truncate">
              {projectName}
            </HoverPrefetchLink>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage className="truncate">{space.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

// ─── Toolbar ───────────────────────────────────────────────────────────────

/**
 * Who has this space, the way to give it to someone else, and the `⋯`.
 *
 * Two ghost controls, no fills — this floats over the hero, and anything
 * heavier reads as a second header. Share carries the grant count; the
 * people themselves are one press away in the Access row. Session visibility
 * (spec §2: `sessions: private | shared`) lives in the menu as a radio pair —
 * a manifest field, PATCHed like the others.
 */
function SpaceToolbar({
  projectId,
  space,
  canManage,
}: {
  projectId: string;
  space: Space;
  canManage: boolean;
}) {
  const tSpaces = useI18nTranslations('spaces');
  const router = useRouter();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSpace(projectId, space.slug);
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const [shareOpen, setShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(space.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const grantsQuery = useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManageMembers,
    retry: false,
    ...contract('inventory'),
  });
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = detailQuery.data?.project?.name ?? '';
  const assigned = useMemo(
    () => grantsForSpace(grantsQuery.data?.grants ?? [], space.slug),
    [grantsQuery.data, space.slug],
  );

  const setMode = useMutation({
    mutationFn: (sessions: SpaceSessionsMode) =>
      updateProjectSpace(projectId, space.slug, { sessions }),
    onSuccess: async (updated) => {
      successToast(
        updated.sessions === SHARED_SESSIONS_MODE
          ? tSpaces('toolbar.sharedToast')
          : tSpaces('toolbar.privateToast'),
      );
      await invalidate();
      // Visibility changed for rows already in the cache.
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
    onError: (error: Error) =>
      errorToast(error.message || tSpaces('toolbar.visibilityFailed')),
  });

  const rename = useMutation({
    mutationFn: (name: string) => updateProjectSpace(projectId, space.slug, { name }),
    onSuccess: async (updated) => {
      successToast(tSpaces('toolbar.renamed', { name: updated.name }));
      setRenaming(false);
      await invalidate();
    },
    onError: (error: Error) => errorToast(error.message || tSpaces('toolbar.renameFailed')),
  });

  const remove = useMutation({
    mutationFn: () => deleteProjectSpace(projectId, space.slug),
    onSuccess: async () => {
      successToast(tSpaces('toolbar.deleted', { name: space.name }));
      setConfirmDelete(false);
      // Drop this space's own query BEFORE the list invalidation: the
      // single-item key nests under the list key, so invalidating the list
      // would refetch a row the server just deleted and toast its 404 while
      // the page is still mounted.
      queryClient.removeQueries({ queryKey: qk.project.space(projectId, space.slug) });
      // The sessions kept their column and the triggers lost theirs, so both
      // lists move — not just the space list.
      await queryClient.invalidateQueries({ queryKey: qk.project.spaces(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.triggers(projectId) });
      router.push(`/projects/${projectId}`);
    },
    onError: (error: Error) => errorToast(error.message || tSpaces('toolbar.deleteFailed')),
  });

  const commitRename = () => {
    const next = draftName.trim();
    if (!next || next === space.name) {
      setRenaming(false);
      setDraftName(space.name);
      return;
    }
    rename.mutate(next);
  };

  return (
    <div className="flex items-center gap-1">
      {renaming ? (
        <Input
          aria-label={tSpaces('toolbar.nameAria')}
          value={draftName}
          autoFocus
          maxLength={64}
          disabled={rename.isPending}
          className="h-8 w-56 text-sm"
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraftName(space.name);
              setRenaming(false);
            }
          }}
        />
      ) : null}

      {canManageMembers && accountId ? (
        <Hint
          label={
            assigned.length === 0
              ? tSpaces('toolbar.grantHint')
              : tSpaces('toolbar.grantedHint', { count: assigned.length })
          }
        >
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground gap-1.5"
            onClick={() => setShareOpen(true)}
          >
            <ShareNetworkIcon className="size-4 shrink-0" />
            {tSpaces('toolbar.share')}
            {assigned.length > 0 ? (
              <span className="text-muted-foreground/70 tabular-nums">{assigned.length}</span>
            ) : null}
          </Button>
        </Hint>
      ) : null}

      {canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tSpaces('toolbar.actionsAria')}
              className="text-muted-foreground hover:text-foreground"
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              {tSpaces('toolbar.visibilityLabel')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={space.sessions}
              onValueChange={(next) => setMode.mutate(next as SpaceSessionsMode)}
            >
              <DropdownMenuRadioItem value="private" disabled={setMode.isPending}>
                {tSpaces('toolbar.privateOption')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="shared" disabled={setMode.isPending}>
                {tSpaces('toolbar.sharedOption')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setDraftName(space.name);
                // After the menu closes, or the input mounts into a tree Radix
                // is still returning focus through and loses it. A timer, not
                // requestAnimationFrame: rAF never fires in a tab that is not
                // painting (background tab, automation), so the open landed on
                // the NEXT interaction instead of this one (2026-09-04).
                setTimeout(() => setRenaming(true), 0);
              }}
            >
              {tSpaces('toolbar.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setTimeout(() => setConfirmDelete(true), 0)}
            >
              <TrashIcon />
              {tSpaces('toolbar.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canManageMembers && accountId ? (
        <AccessDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          accountId={accountId}
          scope={{ kind: 'project', projectId, projectName }}
          mode={{ kind: 'grant' }}
          initialSpaceIds={[space.slug]}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tSpaces('toolbar.deleteTitle', { name: space.name })}
        description={tSpaces('toolbar.deleteDescription', { slug: space.slug })}
        confirmLabel={tSpaces('toolbar.delete')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

// ─── States ────────────────────────────────────────────────────────────────

function SpacePageSkeleton() {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="m-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <Skeleton className="h-9 w-2/3 rounded-md" />
        <Skeleton className="h-28 w-full rounded-md" />
        <div className="space-y-1 pt-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
