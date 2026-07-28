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

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

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

/** Remembers whether the Customize group is expanded. */
const CUSTOMIZE_OPEN_KEY = 'kortix.sidebar.customizeOpen';

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
      settingsHref={projectSettingsHref(projectId, 'general')}
      settingsActive={!!pathname?.startsWith(`/projects/${projectId}/settings`)}
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
  /** Settings lives INSIDE the group — it is configuration like the rest. */
  settingsHref?: string;
  settingsActive?: boolean;
  onSelectSettings?: () => void;
}) {
  // Expanded by default, and the choice is remembered. Collapsing is for people
  // who never touch configuration; forgetting it every navigation would make
  // the control useless to exactly them.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CUSTOMIZE_OPEN_KEY);
      if (stored !== null) setOpen(stored === '1');
    } catch {
      /* private mode — the default stands */
    }
  }, []);
  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(CUSTOMIZE_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* not worth failing a navigation over */
    }
  };

  const showSettings = settingsHref !== undefined || onSelectSettings !== undefined;
  if (items.length === 0 && !showSettings) return null;

  return (
    <SidebarGroup className="py-0">
      <Collapsible open={open} onOpenChange={toggle}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground/60 hover:text-sidebar-foreground flex h-6 w-full items-center gap-1 px-2 text-[11px] font-medium tracking-wider uppercase transition-colors"
          >
            <ChevronRight
              className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
              aria-hidden
            />
            Customize
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu>
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
        </CollapsibleContent>
      </Collapsible>
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
