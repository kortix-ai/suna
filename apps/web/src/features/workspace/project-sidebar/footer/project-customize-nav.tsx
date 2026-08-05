'use client';

import {
  CommandIcon as CommandGlyph,
  GearSixIcon as Config,
  FolderOpenIcon as FolderOpen,
  PlugIcon as Plug,
  SparkleIcon as Sparkle,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback, useEffect } from 'react';

import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { activeCapabilityTab, capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useDevice } from '@/hooks/use-device';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useCustomizeStore } from '@/stores/customize-store';

export function useCustomizeActivate() {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  return useCallback(() => {
    openCustomize();
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
        className="group/customize-button flex items-center justify-between text-sm! font-medium [&_svg]:size-4!"
      >
        <span className="flex items-center gap-2">
          <Config />
          Customize
        </span>
        <KbdGroup className="opacity-0 transition-opacity duration-50 group-hover/customize-button:opacity-100">
          <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>,</Kbd>
        </KbdGroup>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Top-level Files entry — sits ABOVE Customize (files aren't part of
 * customization). Hidden when the caller lacks `project.file.read`: that leaf
 * is editor-tier (IAM v1 moved the sensitive file/secret reads off the floor
 * `member` role), so showing it to a plain member would just land them on a
 * page whose every read 403s. Optimistic while the probe loads — the entry
 * only disappears on an explicit deny.
 *
 * A real `<Link prefetch>`, not `router.push`. The button form could not be
 * prefetched, so every click paid for the route's RSC payload AND its JS chunk
 * cold — the bulk of a 5-6s open. `prefetch` needs `files/loading.tsx` to have
 * something to cache, because the project layout awaits cookies() and the
 * route is therefore dynamic. Note this is production-only behaviour: Next
 * disables Link prefetching under `next dev`.
 */
export function ProjectFilesNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canReadFiles = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_FILE_READ);
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

/**
 * Connectors — graduated out of the Customize overlay into its own routed
 * page (see capabilities/tabs.ts). Same pattern as ProjectFilesNavItem: a
 * real `<Link prefetch>` gated on `project.connector.read`, optimistic while
 * the probe loads — the entry only disappears on an explicit deny.
 */
export function ProjectConnectorsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canReadConnectors = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
  const isActive = !!pathname && activeCapabilityTab(pathname) === 'connectors';

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!canReadConnectors.allowed && !canReadConnectors.isLoading) return null;
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Connectors"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={capabilityTabHref(projectId, 'connectors')} prefetch onClick={handleClick}>
          <Plug />
          Connectors
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Skills — graduated out of the Customize overlay into its own routed page
 * (see capabilities/tabs.ts). Same pattern as ProjectFilesNavItem: a real
 * `<Link prefetch>` gated on `project.skill.read`, optimistic while the
 * probe loads — the entry only disappears on an explicit deny.
 */
export function ProjectSkillsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canReadSkills = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SKILL_READ);
  const isActive = !!pathname && activeCapabilityTab(pathname) === 'skills';

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!canReadSkills.allowed && !canReadSkills.isLoading) return null;
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Skills"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={capabilityTabHref(projectId, 'skills')} prefetch onClick={handleClick}>
          <Sparkle />
          Skills
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Commands — graduated out of the Customize overlay into its own routed page
 * (see capabilities/tabs.ts). Same pattern as ProjectFilesNavItem: a real
 * `<Link prefetch>` gated on `project.command.read`, optimistic while the
 * probe loads — the entry only disappears on an explicit deny.
 */
export function ProjectCommandsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canReadCommands = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_COMMAND_READ);
  const isActive = !!pathname && activeCapabilityTab(pathname) === 'commands';

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!canReadCommands.allowed && !canReadCommands.isLoading) return null;
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Commands"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={capabilityTabHref(projectId, 'commands')} prefetch onClick={handleClick}>
          <CommandGlyph />
          Commands
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
