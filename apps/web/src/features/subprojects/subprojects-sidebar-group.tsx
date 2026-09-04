'use client';

/**
 * The `Subprojects` group in the project sidebar — between the nav group and
 * the session list.
 *
 * A subproject is a closed IAM object (`object_policies.subproject = closed`),
 * so this list is already the caller's accessible set: a member with no grant
 * rows gets an empty array from the API, not a filtered-in-the-browser one.
 * That is why the group disappears entirely for a member with none and no
 * `project.customize.write` — there is neither anything to show nor anything
 * to add, and an empty header would be chrome advertising a feature they
 * cannot reach.
 *
 * `HoverPrefetchLink`, not `<Link prefetch>`, for the same reason the session
 * rows use it: a bare Link prefetches every row in the viewport, so opening a
 * project would fetch the RSC payload of every subproject page.
 */

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { FolderSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { CreateSubprojectModal } from './create-subproject-modal';
import { useProjectSubprojects } from './subprojects-data';

export function SubprojectsSidebarGroup({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  const canCreate = canWrite.allowed === true;
  const [createOpen, setCreateOpen] = useState(false);

  const query = useProjectSubprojects(projectId);
  const subprojects = query.data?.subprojects ?? [];
  const isEmpty = subprojects.length === 0;

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
            return (
              <SidebarMenuItem key={subproject.slug}>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === href}
                  tooltip={subproject.name}
                  className="text-sidebar-foreground"
                >
                  <HoverPrefetchLink href={href}>
                    <span className="shrink-0">
                      <FolderSimpleIcon />
                    </span>
                    <span className="truncate">{subproject.name}</span>
                  </HoverPrefetchLink>
                </SidebarMenuButton>
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
