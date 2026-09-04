'use client';

/**
 * /projects/[id]/subprojects/[slug] — one subproject, as a working surface.
 *
 * The shape is the agent page's, one level down: a header carrying the
 * breadcrumb, the name, and the sharing controls; a body whose main column is
 * the project composer and whose rail is the four things a subproject owns —
 * Instructions, Context, Scheduled, and who may use it. Its sessions sit under
 * the composer, rendered by the SAME list component the sidebar uses.
 *
 * The composer is the real `ProjectHome`, not a copy of it: same agent picker,
 * same sandbox picker, same drafts, same billing gate, same create path. The
 * only thing this page adds is two values — the subproject slug, and its
 * default agent — handed to `useProjectHomeSend`.
 */

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { AgentPeopleSection } from '@/features/workspace/capabilities/agents/agent-people-section';
import { EditorSectionStyleProvider } from '@/features/workspace/customize/sections/view/agent-editor-primitives';
import { ProjectHome } from '@/features/workspace/project-layout/project-home';
import { useProjectHomeSend } from '@/features/workspace/project-layout/use-project-home-send';
import { ProjectSessionList } from '@/features/workspace/project-sidebar/project-session-list';
import { AccessDialog } from '@/features/workspace/shared/access/access-dialog';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
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
  CaretRightIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  ShareNetworkIcon,
  TrashIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  SubprojectContextCard,
  SubprojectInstructionsCard,
  SubprojectScheduledCard,
  useInvalidateSubproject,
} from './subproject-sections';

/** How many avatars the share stack shows before it folds the rest into "+N". */
const STACK_LIMIT = 4;

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
      <CenteredState>
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
      </CenteredState>
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
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <SubprojectHeader projectId={projectId} subproject={subproject} canManage={canManage} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-4 pb-12">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            {/* The composer keeps its own hero proportions, so the cell needs a
                real height rather than collapsing to the content's. */}
            <div className="flex min-h-[26rem] min-w-0 flex-col overflow-hidden rounded-md border">
              <ProjectHome projectId={projectId} onSend={handleSend} busy={sending} />
            </div>

            <aside className="min-w-0 space-y-4">
              <EditorSectionStyleProvider value="panel">
                <SubprojectInstructionsCard
                  projectId={projectId}
                  subproject={subproject}
                  canManage={canManage}
                />
                <SubprojectContextCard
                  projectId={projectId}
                  subproject={subproject}
                  canManage={canManage}
                />
                <SubprojectScheduledCard projectId={projectId} slug={subproject.slug} />
                <AgentPeopleSection
                  projectId={projectId}
                  agentName={subproject.slug}
                  resourceType="subproject"
                />
              </EditorSectionStyleProvider>
            </aside>
          </div>

          {/* The sidebar's own list, filtered to this subproject — the same
              rows, the same `⋯` actions, the same grouping menu, so a session
              looks and behaves identically wherever it is listed. */}
          <section className="flex h-80 min-h-0 flex-col">
            <ProjectSessionList projectId={projectId} subproject={subproject.slug} />
          </section>
        </div>
      </div>
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

function SubprojectHeader({
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
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(subproject.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    <header className="border-border/60 shrink-0 border-b px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <HoverPrefetchLink
            href="/projects"
            className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          >
            Projects
          </HoverPrefetchLink>
          <CaretRightIcon aria-hidden className="text-muted-foreground/50 size-3.5 shrink-0" />
          {renaming ? (
            <Input
              aria-label="Subproject name"
              value={draftName}
              autoFocus
              maxLength={64}
              disabled={rename.isPending}
              className="h-7 max-w-56 text-sm"
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
          ) : (
            <h1 className="text-foreground truncate text-sm font-semibold">{subproject.name}</h1>
          )}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <SubprojectShareControl projectId={projectId} subproject={subproject} />
          {canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Subproject actions">
                  <DotsThreeIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setDraftName(subproject.name);
                    // After the menu closes, or the input mounts into a tree
                    // Radix is still returning focus through and loses it.
                    requestAnimationFrame(() => setRenaming(true));
                  }}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
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
        </div>
      </div>

      {subproject.description ? (
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm text-pretty">
          {subproject.description}
        </p>
      ) : null}

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
    </header>
  );
}

/**
 * Who has this subproject, the way to give it to someone else, and who may
 * read the sessions started in it.
 *
 * Same shape as `AgentShareControl` — an avatar stack of the grants, a Share
 * button opening the shared `AccessDialog` narrowed to this subproject — plus
 * the one control an agent has no equivalent of: the session-visibility mode
 * (spec §2), which is a manifest field and so PATCHes the subproject.
 *
 * Gated on `project.members.manage`, the leaf the grants endpoint asserts.
 */
function SubprojectShareControl({
  projectId,
  subproject,
}: {
  projectId: string;
  subproject: Subproject;
}) {
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const invalidate = useInvalidateSubproject(projectId, subproject.slug);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

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

  if (!canManageMembers || !accountId) return null;

  const shown = assigned.slice(0, STACK_LIMIT);
  const rest = assigned.length - shown.length;

  return (
    <div className="flex items-center gap-2">
      <Hint label="Who may read the sessions started in this subproject">
        <Tabs
          value={subproject.sessions}
          onValueChange={(next) => setMode.mutate(next as SubprojectSessionsMode)}
        >
          <TabsListCompact aria-label="Session visibility">
            <TabsTriggerCompact value="private" disabled={setMode.isPending}>
              Only their own
            </TabsTriggerCompact>
            <TabsTriggerCompact value="shared" disabled={setMode.isPending}>
              Everyone granted
            </TabsTriggerCompact>
          </TabsListCompact>
        </Tabs>
      </Hint>

      {assigned.length > 0 ? (
        <Hint
          label={`${assigned.length} ${assigned.length === 1 ? 'grant' : 'grants'} on this subproject`}
        >
          {/* Overlapping stack: each bubble sits 6px into the one before, with
              a ring in the page background so the overlap reads as depth. */}
          <span className={cn('flex items-center pl-1')}>
            {shown.map((grant) => (
              <span
                key={grant.grant_id}
                className="ring-background -ml-1.5 inline-flex rounded-full ring-2 first:ml-0"
              >
                {grant.principal_type === 'group' ? (
                  <EntityAvatar icon={UsersIcon} size="sm" className="rounded-full" />
                ) : (
                  <UserAvatar email={grant.principal_label} size="sm" />
                )}
              </span>
            ))}
            {rest > 0 ? (
              <span className="bg-muted text-muted-foreground ring-background -ml-1.5 inline-flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums ring-2">
                +{rest}
              </span>
            ) : null}
          </span>
        </Hint>
      ) : null}

      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <ShareNetworkIcon className="size-3.5 shrink-0" />
        Share
      </Button>

      <AccessDialog
        open={open}
        onOpenChange={setOpen}
        accountId={accountId}
        scope={{ kind: 'project', projectId, projectName }}
        mode={{ kind: 'grant' }}
        initialSubprojectIds={[subproject.slug]}
      />
    </div>
  );
}

// ─── States ────────────────────────────────────────────────────────────────

function CenteredState({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-16">{children}</div>
    </div>
  );
}

function SubprojectPageSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border/60 shrink-0 border-b px-5 py-3">
        <Skeleton className="h-5 w-48 rounded-sm" />
      </div>
      <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="h-[26rem] w-full rounded-md" />
        <div className="space-y-4">
          <Skeleton className="h-48 w-full rounded-md" />
          <Skeleton className="h-40 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
