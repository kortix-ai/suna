'use client';

import { Config } from '@mynaui/icons-react';
import { FolderOpen } from 'lucide-react';
import { useCallback, useEffect } from 'react';

import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
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

/** Open straight to Files. Files live OUTSIDE customization (accessible to any
 *  member), so this is a top-level entry, not gated behind customize access. */
export function useFilesActivate() {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  return useCallback(() => {
    openCustomize('files');
    if (isMobile) setOpenMobile(false);
  }, [openCustomize, isMobile, setOpenMobile]);
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

/** Top-level Files entry — sits ABOVE Customize and is shown to every member
 *  (files aren't part of customization). Opens the panel straight to Files. */
export function ProjectFilesNavItem() {
  const onClick = useFilesActivate();
  const section = useCustomizeStore((s) => s.section);
  const customizeOpen = useCustomizeStore((s) => s.open);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        isActive={customizeOpen && section === 'files'}
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
