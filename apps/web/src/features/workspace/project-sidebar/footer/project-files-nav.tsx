'use client';

import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';

/**
 * Top-level Files entry. Hidden when the caller lacks `project.file.read`: that
 * leaf is editor-tier (IAM v1 moved the sensitive file/secret reads off the
 * floor `member` role), so showing it to a plain member would just land them on
 * a page whose every read 403s. Optimistic while the probe loads — the entry
 * only disappears on an explicit deny.
 *
 * A real `<Link prefetch>`, not `router.push`. The button form could not be
 * prefetched, so every click paid for the route's RSC payload AND its JS chunk
 * cold — the bulk of a 5-6s open. `prefetch` needs `files/loading.tsx` to have
 * something to cache, because the project layout awaits cookies() and the
 * route is therefore dynamic. Note this is production-only behaviour: Next
 * disables Link prefetching under `next dev`.
 *
 * Connectors / Skills / Commands used to sit beside this entry, one row each,
 * plus a Customize row below them. They are tabs of one `(capabilities)`
 * layout, so four rows bought nothing over one: ProjectCustomizeNavItem
 * replaced them and moved to the top of the panel, under New session.
 */
export function ProjectFilesNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canReadFiles = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_FILE_READ];
  const isActive = !!pathname && /^\/projects\/[^/]+\/files(\/|$)/.test(pathname);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!canReadFiles.allowed && !canReadFiles.isLoading) return null;
  // No project id means no valid href. The old onClick already no-op'd in this
  // case, so rendering a dead button was never useful.
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Files"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={`/projects/${projectId}/files`} prefetch onClick={handleClick}>
          <FolderOpen />
          Files
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
