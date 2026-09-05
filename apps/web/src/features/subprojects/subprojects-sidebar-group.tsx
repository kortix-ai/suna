'use client';

/**
 * The `Subprojects` group in the project sidebar — between the nav group and
 * the session list.
 *
 * Each subproject row is a folder that opens: its sessions nest under it as a
 * sub-menu, and the main `Sessions` list below shows only sessions filed
 * under no subproject (`ProjectSessionList unfiledOnly`). One inventory
 * query feeds both — this group reads the same `qk.project.sessions(id)`
 * entry the list owns and partitions it client-side, so nesting costs no
 * extra request and the two can never disagree about a row.
 *
 * A subproject is a closed IAM object (`object_policies.subproject = closed`),
 * so the list is already the caller's accessible set. The group disappears
 * entirely for a member with none and no `project.customize.write` — an empty
 * header would be chrome advertising a feature they cannot reach.
 */

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { SessionStatusDot } from '@/features/workspace/project-sidebar/project-session-list';
import {
  getSessionDisplayTitle,
  projectSessionsRefetchInterval,
  sortSessionsByLastActivity,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { listProjectSessions, type ProjectSession } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { CaretRightIcon, FolderSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';

import { CreateSubprojectModal } from './create-subproject-modal';
import { useProjectSubprojects } from './subprojects-data';

/** Rows shown under a folder before "View all" takes over. */
const NESTED_LIMIT = 6;

export function SubprojectsSidebarGroup({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  const canCreate = canWrite.allowed === true;
  const [createOpen, setCreateOpen] = useState(false);
  // Folders the person toggled by hand. The active subproject opens itself.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const query = useProjectSubprojects(projectId);
  const subprojects = query.data?.subprojects ?? [];
  const isEmpty = subprojects.length === 0;

  // The SAME entry `ProjectSessionList` polls — never a second request.
  const activeSessionId = pathname?.match(/\/sessions\/([^/?]+)/)?.[1] ?? null;
  const sessionsQuery = useQuery({
    queryKey: qk.project.sessions(projectId, 'visible'),
    queryFn: () => listProjectSessions(projectId),
    refetchInterval: (q) =>
      projectSessionsRefetchInterval({
        sessions: q.state.data as ProjectSession[] | undefined,
        hasOpenSession: Boolean(activeSessionId),
      }),
    refetchOnWindowFocus: true,
    enabled: !isEmpty,
    ...contract('inventory'),
  });
  const sessionsBySlug = useMemo(() => {
    const map = new Map<string, ProjectSession[]>();
    for (const session of sessionsQuery.data ?? []) {
      if (!session.subproject) continue;
      const bucket = map.get(session.subproject);
      if (bucket) bucket.push(session);
      else map.set(session.subproject, [session]);
    }
    for (const [slug, list] of map) map.set(slug, sortSessionsByLastActivity(list));
    return map;
  }, [sessionsQuery.data]);

  // A known deny plus nothing to list: never render, not even the skeleton.
  // Anything else keeps the group while the probe or the list is in flight,
  // so a slow permission check cannot flash the `+` away from someone who
  // does have it.
  if (isEmpty && canWrite.allowed === false) return null;
  if (!query.isLoading && isEmpty && !canCreate) return null;

  return (
    <SidebarGroup className="shrink-0 py-0">
      <div className="flex h-8 w-full shrink-0 flex-row items-center gap-1 px-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm font-medium">
          Subprojects
        </span>
        {canCreate ? (
          <Hint label="New subproject">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="New subproject"
              className="text-muted-foreground hover:text-foreground shrink-0 transition-none"
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4" />
            </Button>
          </Hint>
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="space-y-px" aria-hidden>
          {['w-28', 'w-20'].map((width) => (
            <div key={width} className="flex h-8 items-center gap-2 px-2">
              <Skeleton className="size-4 shrink-0 rounded-sm py-0" />
              <Skeleton className={`h-3 py-0 ${width}`} />
            </div>
          ))}
        </div>
      ) : (
        <SidebarMenu>
          {subprojects.map((subproject) => {
            const href = `/projects/${projectId}/subprojects/${subproject.slug}`;
            const sessions = sessionsBySlug.get(subproject.slug) ?? [];
            const holdsActive =
              activeSessionId !== null &&
              sessions.some((session) => session.session_id === activeSessionId);
            const isActive = pathname === href;
            // Open by hand, or because the person is inside it right now.
            const open = toggled[subproject.slug] ?? (isActive || holdsActive);
            const shown = sessions.slice(0, NESTED_LIMIT);
            const rest = sessions.length - shown.length;
            return (
              <SidebarMenuItem key={subproject.slug}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  tooltip={subproject.name}
                  // `px-2`, not the menu button's `px-3`: the group header above and
                  // the session rows below both sit at `px-2`, so the folder's 16px
                  // box starts on the same line as the "Subprojects" text.
                  className="text-sidebar-foreground px-2"
                >
                  <HoverPrefetchLink href={href}>
                    <span className="shrink-0">
                      <FolderSimpleIcon />
                    </span>
                    <span className="truncate">{subproject.name}</span>
                  </HoverPrefetchLink>
                </SidebarMenuButton>
                {sessions.length > 0 ? (
                  <SidebarMenuAction
                    // 10px from the edge + a 20px box centres the caret under the
                    // header's `+` (a 24px `icon-xs` button inside `px-2`).
                    className="right-2.5"
                    showOnHover={!open}
                    aria-label={open ? `Collapse ${subproject.name}` : `Expand ${subproject.name}`}
                    aria-expanded={open}
                    onClick={() =>
                      setToggled((current) => ({ ...current, [subproject.slug]: !open }))
                    }
                  >
                    <CaretRightIcon
                      className={cn('size-3.5 transition-transform', open && 'rotate-90')}
                    />
                  </SidebarMenuAction>
                ) : null}
                {open && sessions.length > 0 ? (
                  <SidebarMenuSub>
                    {shown.map((session) => {
                      const sessionHref = `/projects/${projectId}/sessions/${session.session_id}`;
                      return (
                        <SidebarMenuSubItem key={session.session_id}>
                          <SidebarMenuSubButton
                            asChild
                            size="sm"
                            isActive={activeSessionId === session.session_id}
                          >
                            <HoverPrefetchLink href={sessionHref}>
                              {/* The same glyph the project-level rows wear. */}
                              <SessionStatusDot session={session} />
                              <span className="truncate">{getSessionDisplayTitle(session)}</span>
                            </HoverPrefetchLink>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}
                    {rest > 0 ? (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild size="sm" className="text-muted-foreground">
                          <HoverPrefetchLink href={href}>
                            <span className="truncate">{rest} more…</span>
                          </HoverPrefetchLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ) : null}
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}

      {canCreate ? (
        <CreateSubprojectModal
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      ) : null}
    </SidebarGroup>
  );
}
