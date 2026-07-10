'use client';

import { Config } from '@mynaui/icons-react';
import { FolderOpen } from 'lucide-react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';

import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useIsMobile } from '@/hooks/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { useDevice } from '@/hooks/use-device';

export function useCustomizeActivate() {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  return useCallback(() => {
    openCustomize();
    if (isMobile) setOpenMobile(false);
  }, [openCustomize, isMobile, setOpenMobile]);
}

/** Navigate to the standalone Files page. Files live OUTSIDE customization
 *  (accessible to any member), so this is a top-level route, not a section of
 *  the Customize overlay. */
export function useFilesActivate() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  return useCallback(() => {
    if (!projectId) return;
    router.push(`/projects/${projectId}/files`);
    if (isMobile) setOpenMobile(false);
  }, [router, projectId, isMobile, setOpenMobile]);
}

/** Mod+, — open the customize overlay (same as the sidebar button). */
export function useCustomizeKeyboardShortcut() {
  const activate = useCustomizeActivate();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === ','
      ) {
        event.preventDefault();
        activate();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activate]);
}

export function ProjectCustomizeNavItem() {
  const onClick = useCustomizeActivate();
  const customizeOpen = useCustomizeStore((s) => s.open);
  const isMac = useDevice();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        isActive={customizeOpen}
        tooltip="Customize"
        className="text-sm! font-medium [&_svg]:size-4! flex items-center justify-between group/customize-button"
      >
        <span className="flex items-center gap-2">
          <Config />
          Customize
        </span>
        <KbdGroup className='opacity-0 group-hover/customize-button:opacity-100 transition-opacity duration-50'>
          <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>,</Kbd>
        </KbdGroup>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectCustomizeRailItem() {
  const onClick = useCustomizeActivate();

  return (
    <Hint label="Customize">
      <SidebarMenuButton type="button" aria-label="Customize" onClick={onClick}>
        <Config className="size-4.5!" />
      </SidebarMenuButton>
    </Hint>
  );
}

/** Top-level Files entry — sits ABOVE Customize (files aren't part of
 *  customization). Hidden when the caller lacks `project.file.read`: that leaf
 *  is editor-tier (IAM v1 moved the sensitive file/secret reads off the floor
 *  `member` role), so showing it to a plain member would just land them on a
 *  page whose every read 403s. Optimistic while the probe loads — the entry
 *  only disappears on an explicit deny. */
export function ProjectFilesNavItem() {
  const onClick = useFilesActivate();
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const canReadFiles = useProjectCan(params?.id, PROJECT_ACTIONS.PROJECT_FILE_READ);
  const isActive = !!pathname && /^\/projects\/[^/]+\/files(\/|$)/.test(pathname);

  if (!canReadFiles.allowed && !canReadFiles.isLoading) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        isActive={isActive}
        tooltip="Files"
        className="text-sm! font-medium [&_svg]:size-4! flex items-center gap-2"
      >
        <FolderOpen />
        Files
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectFilesRailItem() {
  const onClick = useFilesActivate();

  return (
    <Hint label="Files">
      <SidebarMenuButton type="button" aria-label="Files" onClick={onClick}>
        <FolderOpen className="size-4.5!" />
      </SidebarMenuButton>
    </Hint>
  );
}
