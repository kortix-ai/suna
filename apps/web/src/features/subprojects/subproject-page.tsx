'use client';

/**
 * /projects/[id]/subprojects/[slug] — a subproject IS the project-home surface
 * wearing a different name.
 *
 * Same wallpaper, same greeting shape, same composer, same create path
 * (`useProjectHomeSend` with the slug and the default agent). What the page
 * adds is quiet: a breadcrumb floated top-left and a ghost toolbar top-right
 * (share, `⋯`). What the subproject owns — instructions, context, schedules,
 * access — opens from the `⋯` menu in a side sheet; its sessions are in the
 * sidebar, nested under its folder. Nothing under the composer —
 * the home has nothing under its composer, so everything here has to read as
 * part of that page, not as a settings form parked next to it.
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
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ProjectHome } from '@/features/workspace/project-layout/project-home';
import { useProjectHomeSend } from '@/features/workspace/project-layout/use-project-home-send';
import { AccessDialog } from '@/features/workspace/shared/access/access-dialog';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  deleteProjectSubproject,
  getProjectDetail,
  getProjectSubproject,
  listProjectResourceGrants,
  updateProjectSubproject,
  type ProjectResourceGrant,
  type Subproject,
  type SubprojectSessionsMode,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import {
  DotsThreeIcon,
  FolderSimpleIcon,
  NotePencilIcon,
  ShareNetworkIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { SubprojectMeta, useInvalidateSubproject } from './subproject-sections';

/** The grants naming this subproject. Orphaned rows (the block was deleted)
 *  are kept — they are inert, and hiding them hides the thing to clean up. */
export function grantsForSubproject(
  grants: readonly ProjectResourceGrant[],
  slug: string,
): ProjectResourceGrant[] {
  return grants.filter((g) => g.resource_type === 'subproject' && g.resource_id === slug);
}

export function SubprojectPage({ projectId, slug }: { projectId: string; slug: string }) {
  const query = useQuery({
    queryKey: qk.project.subproject(projectId, slug),
    queryFn: () => getProjectSubproject(projectId, slug),
    retry: false,
    ...contract('config'),
  });

  if (query.isLoading) return <SubprojectPageSkeleton />;

  if (query.isError || !query.data) {
    // A `404` here is the authorization answer as much as the existence one:
    // an undeclared subproject and one this caller is not granted look the
    // same on purpose (spec §5.4), so the copy names both.
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-16">
          <EmptyState
            icon={FolderSimpleIcon}
            size="sm"
            title={`No subproject named ${slug}`}
            description="It may have been removed from the project's configuration, or you may not be granted it."
            action={
              <Button asChild variant="outline" size="sm">
                <HoverPrefetchLink href={`/projects/${projectId}`}>Back to the project</HoverPrefetchLink>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return <SubprojectBody projectId={projectId} subproject={query.data} />;
}

function SubprojectBody({
  projectId,
  subproject,
}: {
  projectId: string;
  subproject: Subproject;
}) {
  const canManage = subproject.can_manage;
  const accountId = useProjectAccountId(projectId);
  const { handleSend, sending } = useProjectHomeSend(projectId, {
    accountId: accountId ?? undefined,
    subproject: subproject.slug,
    defaultAgent: subproject.agent,
  });

  return (
    <ProjectHome
      projectId={projectId}
      onSend={handleSend}
      busy={sending}
      hero={{ name: subproject.name, description: subproject.description }}
      breadcrumb={<SubprojectBreadcrumb projectId={projectId} subproject={subproject} />}
      toolbar={
        <SubprojectToolbar projectId={projectId} subproject={subproject} canManage={canManage} />
      }
      // Nothing under the composer — the same rule the project home follows
      // (Marko, 2026-09-02: "just have the chat input there & that's it").
      // Sessions are in the sidebar under the folder; instructions, context,
      // schedules and access are one press away in the `⋯` menu (user,
      // 2026-09-04).
    />
  );
}

// ─── Breadcrumb ────────────────────────────────────────────────────────────

function SubprojectBreadcrumb({
  projectId,
  subproject,
}: {
  projectId: string;
  subproject: Subproject;
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
          <BreadcrumbPage className="truncate">{subproject.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

// ─── Toolbar ───────────────────────────────────────────────────────────────

/**
 * Who has this subproject, the way to give it to someone else, and the `⋯`.
 *
 * Two ghost controls, no fills — this floats over the hero, and anything
 * heavier reads as a second header. Share carries the grant count; the
 * people themselves are one press away in the Access row. Session visibility
 * (spec §2: `sessions: private | shared`) lives in the menu as a radio pair —
 * a manifest field, PATCHed like the others.
 */
function SubprojectToolbar({
  projectId,
  subproject,
  canManage,
}: {
  projectId: string;
  subproject: Subproject;
  canManage: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSubproject(projectId, subproject.slug);
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(subproject.name);
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
    () => grantsForSubproject(grantsQuery.data?.grants ?? [], subproject.slug),
    [grantsQuery.data, subproject.slug],
  );

  const setMode = useMutation({
    mutationFn: (sessions: SubprojectSessionsMode) =>
      updateProjectSubproject(projectId, subproject.slug, { sessions }),
    onSuccess: async (updated) => {
      successToast(
        updated.sessions === 'shared'
          ? 'Everyone granted this subproject can read its sessions'
          : 'Sessions here are private to whoever starts them',
      );
      await invalidate();
      // Visibility changed for rows already in the cache.
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Could not change session visibility'),
  });

  const rename = useMutation({
    mutationFn: (name: string) => updateProjectSubproject(projectId, subproject.slug, { name }),
    onSuccess: async (updated) => {
      successToast(`Renamed to ${updated.name}`);
      setRenaming(false);
      await invalidate();
    },
    onError: (error: Error) => errorToast(error.message || 'Could not rename it'),
  });

  const remove = useMutation({
    mutationFn: () => deleteProjectSubproject(projectId, subproject.slug),
    onSuccess: async () => {
      successToast(`${subproject.name} deleted`);
      setConfirmDelete(false);
      // Drop this subproject's own query BEFORE the list invalidation: the
      // single-item key nests under the list key, so invalidating the list
      // would refetch a row the server just deleted and toast its 404 while
      // the page is still mounted.
      queryClient.removeQueries({ queryKey: qk.project.subproject(projectId, subproject.slug) });
      // The sessions kept their column and the triggers lost theirs, so both
      // lists move — not just the subproject list.
      await queryClient.invalidateQueries({ queryKey: qk.project.subprojects(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.triggers(projectId) });
      router.push(`/projects/${projectId}`);
    },
    onError: (error: Error) => errorToast(error.message || 'Could not delete it'),
  });

  const commitRename = () => {
    const next = draftName.trim();
    if (!next || next === subproject.name) {
      setRenaming(false);
      setDraftName(subproject.name);
      return;
    }
    rename.mutate(next);
  };

  return (
    <div className="flex items-center gap-1">
      {renaming ? (
        <Input
          aria-label="Subproject name"
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
              setDraftName(subproject.name);
              setRenaming(false);
            }
          }}
        />
      ) : null}

      {canManageMembers && accountId ? (
        <Hint
          label={
            assigned.length === 0
              ? 'Grant this subproject to people or groups'
              : `Granted to ${assigned.length} ${assigned.length === 1 ? 'person or group' : 'people and groups'}`
          }
        >
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground gap-1.5"
            onClick={() => setShareOpen(true)}
          >
            <ShareNetworkIcon className="size-4 shrink-0" />
            Share
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
              aria-label="Subproject actions"
              className="text-muted-foreground hover:text-foreground"
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={() => requestAnimationFrame(() => setEditOpen(true))}>
              <NotePencilIcon />
              Instructions, context & schedules…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Sessions here are readable by
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={subproject.sessions}
              onValueChange={(next) => setMode.mutate(next as SubprojectSessionsMode)}
            >
              <DropdownMenuRadioItem value="private" disabled={setMode.isPending}>
                Only whoever started them
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="shared" disabled={setMode.isPending}>
                Everyone granted this subproject
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setDraftName(subproject.name);
                // After the menu closes, or the input mounts into a tree Radix
                // is still returning focus through and loses it.
                requestAnimationFrame(() => setRenaming(true));
              }}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => requestAnimationFrame(() => setConfirmDelete(true))}
            >
              <TrashIcon />
              Delete
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
          initialSubprojectIds={[subproject.slug]}
        />
      ) : null}

      {/* What the subproject owns, edited off the page: the home surface stays
          bare, and the rows keep their editors exactly as they were. */}
      <Sheet open={editOpen} onOpenChange={setEditOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-border shrink-0 space-y-1 border-b px-5 py-4 pr-12 text-left">
            <SheetTitle className="text-base font-medium">{subproject.name}</SheetTitle>
            <SheetDescription className="text-xs text-pretty">
              What the agent is told, what it reads first, what runs on its own, and who may use it.
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="min-h-0 gap-0 px-3 py-3">
            <SubprojectMeta
              projectId={projectId}
              subproject={subproject}
              canManage={canManage}
              className="px-0"
            />
          </SheetBody>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${subproject.name}?`}
        description="The block is removed from kortix.yaml and its triggers lose the back-reference. Its sessions are kept, but members granted only this subproject stop seeing them."
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

// ─── States ────────────────────────────────────────────────────────────────

function SubprojectPageSkeleton() {
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
