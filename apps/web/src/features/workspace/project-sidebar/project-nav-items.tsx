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
import { useIsMobile } from '@/hooks/utils';
import { CUSTOMIZE_SECTION_ACCESS } from '@/lib/project-actions';
import { PROJECT_NAV_ITEMS, projectSettingsHref } from '@/lib/project-nav';
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
    <SidebarGroup className="py-0">
      <SidebarGroupLabel className="text-muted-foreground/60 flex h-6 items-center px-2 text-[11px] font-medium tracking-wider uppercase">
        Customize
      </SidebarGroupLabel>
      <SidebarMenu>
        {visible.map((item) => {
          const href = `/projects/${projectId}/${item.segment}`;
          const isActive = !!pathname?.startsWith(href);
          return (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton
                asChild
                size="sm"
                className={cn(
                  'text-muted-foreground hover:text-sidebar-foreground h-7 px-2 text-sm font-normal',
                  isActive && 'text-sidebar-foreground font-medium',
                )}
              >
                <Link href={href} onClick={close}>
                  {item.label}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
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
