'use client';

/**
 * The Customize group in the sidebar: a quiet label with four plain-text links.
 *
 * The lightness of the sidebar comes from exactly this: the Customize children
 * are unstyled text, not icon rows in boxes. Keep them that way.
 *
 * Visibility reuses the batched capability probe the Customize rail used, so
 * promoting a section to a route changes nothing about who can see it. The
 * probe fails OPEN: an item only disappears on an explicit deny, never while
 * the probe is in flight.
 */

import { ChevronRight } from 'lucide-react';
import { SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  SidebarPlainLink,
  SidebarSectionLabel,
} from '@/features/workspace/project-sidebar/sidebar-chrome';
import { useIsMobile } from '@/hooks/utils';
import { CUSTOMIZE_SECTION_ACCESS } from '@/lib/project-actions';
import { PROJECT_NAV_ITEMS, type ProjectNavItem, projectSettingsHref } from '@/lib/project-nav';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';

export function ProjectNavItems({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const openCustomize = useCustomizeStore((state) => state.openCustomize);

  // ONE row. Customize is a single surface again, so the sidebar names it once
  // instead of listing its sections — those live in the surface's own rail,
  // where every section is reachable rather than the four that were promoted.
  const isActive = !!pathname?.includes(`/projects/${projectId}/customize`);

  return (
    <SidebarGroup className="py-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={isActive}
            tooltip="Customize"
            className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
            onClick={() => {
              openCustomize();
              if (isMobile) setOpenMobile(false);
            }}
          >
            <SlidersHorizontal />
            Customize
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * The Customize group, presentational.
 *
 * Shared with the signed-out homepage, which has no project to gate against
 * and sends every item to the sign-in gate instead of a route. Both surfaces
 * render the same markup so they cannot drift apart.
 */
export function ProjectNavGroup({
  items,
  hrefFor,
  isActive,
  onNavigate,
  onSelect,
  filesHref,
  filesActive,
  onSelectFiles,
  settingsHref,
  settingsActive,
  onSelectSettings,
}: {
  items: readonly ProjectNavItem[];
  hrefFor?: (item: ProjectNavItem) => string;
  isActive?: (item: ProjectNavItem) => boolean;
  onNavigate?: () => void;
  /** Used instead of a link when the surface has nowhere to navigate yet. */
  onSelect?: (item: ProjectNavItem) => void;
  /** Files leads the group. */
  filesHref?: string;
  filesActive?: boolean;
  onSelectFiles?: () => void;
  /** Settings lives INSIDE the group — it is configuration like the rest. */
  settingsHref?: string;
  settingsActive?: boolean;
  onSelectSettings?: () => void;
}) {
  const showFiles = filesHref !== undefined || onSelectFiles !== undefined;
  const showSettings = settingsHref !== undefined || onSelectSettings !== undefined;
  if (items.length === 0 && !showFiles && !showSettings) return null;

  return (
    <SidebarGroup className="py-0">
      {/* The same quiet uppercase label the session list uses. It is a section
          of the sidebar, not a widget — a disclosure chevron here just invited
          people to hide their own configuration and then wonder where it went. */}
      <SidebarSectionLabel>Customize</SidebarSectionLabel>
      <SidebarMenu>
        {showFiles ? (
          <SidebarPlainLink
            href={filesHref}
            isActive={filesActive}
            onClick={() => {
              onSelectFiles?.();
              onNavigate?.();
            }}
          >
            Files
          </SidebarPlainLink>
        ) : null}
        {items.map((item) => (
          <SidebarPlainLink
            key={item.key}
            href={hrefFor?.(item)}
            isActive={isActive?.(item)}
            onClick={() => {
              onSelect?.(item);
              onNavigate?.();
            }}
          >
            {item.label}
          </SidebarPlainLink>
        ))}
        {showSettings ? (
          <SidebarPlainLink
            href={settingsHref}
            isActive={settingsActive}
            onClick={() => {
              onSelectSettings?.();
              onNavigate?.();
            }}
          >
            Settings
          </SidebarPlainLink>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/** Settings sits below the alerts, as its own entry rather than in the group. */
export function ProjectSettingsNavItem({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const href = projectSettingsHref(projectId, 'general');
  const isActive = !!pathname?.startsWith(`/projects/${projectId}/settings`);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip="Settings"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link
          href={href}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          Settings
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
