'use client';

/**
 * The Customize group in the sidebar: a quiet label with four plain-text links.
 *
 * The lightness of Perplexity's sidebar comes from exactly this — the
 * Customize children are unstyled text, not icon rows in boxes (see
 * ux-references/perplexity/01-home-search.png). Keep them that way.
 *
 * Visibility reuses the batched capability probe the Customize rail used, so
 * promoting a section to a route changes nothing about who can see it. The
 * probe fails OPEN: an item only disappears on an explicit deny, never while
 * the probe is in flight.
 */

import { Config } from '@mynaui/icons-react';
import { Settings as LucideSettings } from 'lucide-react';
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
  SidebarNavRow,
  SidebarPlainLink,
} from '@/features/workspace/project-sidebar/sidebar-chrome';
import { useIsMobile } from '@/hooks/utils';
import { CUSTOMIZE_SECTION_ACCESS } from '@/lib/project-actions';
import { PROJECT_NAV_ITEMS, type ProjectNavItem, projectSettingsHref } from '@/lib/project-nav';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';

export function ProjectNavItems({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  // The hook keys its queries on this array — memoize it or every render
  // remounts the probes.
  const gateActions = useMemo(
    () =>
      Array.from(
        new Set(PROJECT_NAV_ITEMS.map((item) => CUSTOMIZE_SECTION_ACCESS[item.gateSection].read)),
      ),
    [],
  );
  const cans = useProjectCans(projectId, gateActions);

  const visible = PROJECT_NAV_ITEMS.filter((item) => {
    const probe = cans[CUSTOMIZE_SECTION_ACCESS[item.gateSection].read];
    // Fail open while loading or on error — a slow probe must not blank the nav.
    return probe?.allowed !== false;
  });

  if (visible.length === 0) return null;

  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <ProjectNavGroup
      items={visible}
      hrefFor={(item) => `/projects/${projectId}/${item.segment}`}
      isActive={(item) => !!pathname?.startsWith(`/projects/${projectId}/${item.segment}`)}
      onNavigate={close}
    />
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
}: {
  items: readonly ProjectNavItem[];
  hrefFor?: (item: ProjectNavItem) => string;
  isActive?: (item: ProjectNavItem) => boolean;
  onNavigate?: () => void;
  /** Used instead of a link when the surface has nowhere to navigate yet. */
  onSelect?: (item: ProjectNavItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <SidebarGroup className="py-0">
      <SidebarMenu>
        {/* A real row, not a caption — same family as Files and Settings. */}
        <SidebarNavRow
          icon={Config}
          label="Customize"
          isActive={items.some((i) => isActive?.(i))}
        />
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
    <SidebarNavRow
      icon={LucideSettings}
      label="Settings"
      href={href}
      isActive={isActive}
      onClick={() => {
        if (isMobile) setOpenMobile(false);
      }}
    />
  );
}
