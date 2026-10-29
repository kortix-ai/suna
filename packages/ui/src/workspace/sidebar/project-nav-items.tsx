'use client';

import { ProjectAppsNavItem } from './footer/project-apps-nav';
import { ProjectGoalsNavItem } from './footer/project-goals-nav';
import { ProjectArtifactsNavItem } from './footer/project-artifacts-nav';
import { ProjectRoomsNavItem } from './footer/project-rooms-nav';
import { ProjectFilesNavItem } from './footer/project-files-nav';
import {
  CustomizeGlyph,
  useCapabilityAccess,
} from '../../internal/layout/project-settings-nav';
import { isProjectAdminPath, ProjectCapabilityNav } from '../../internal/layout/project-capability-nav';
import { NavHoverCardContent, useNavHoverCard } from '../../internal/layout/nav-hover-card';
import { ProjectNavRow } from '../../internal/layout/project-nav-row';
import { capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { Popover, PopoverAnchor } from '../../primitives/popover';
import { cn } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';
import { SidebarGlyph } from '../../icons/sidebar-toggle';
import { useNavRowMeta } from './nav-row-meta';
import { useIsMobile } from '../../internal/hooks';
import { useTranslations } from '../../i18n';
import {
  SIDEBAR_NAV_DEFAULTS,
  openCustomizeSidebar,
  useSidebarNavStore,
  type SidebarNavEntry,
} from '../../internal/stores/sidebar-nav-store';
import { CaretRightIcon, DotsThreeOutlineIcon } from '@phosphor-icons/react';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';

const subscribeNoop = () => () => {};

/** Time to cross the gap between the More row and its menu before it closes. */
const HOVER_CLOSE_DELAY_MS = 150;

/**
 * The customizable nav rows under New session, in the order and with the
 * visibility chosen in "Customize sidebar" (`customize-sidebar-modal.tsx`).
 * Each row still applies its own flag and permission gate. More (rows set to
 * "Show in More", plus Customize sidebar) is last. Spaces are the channel
 * sidebar under the `project_channels` flag (project-spaces-nav.tsx).
 *
 * The layout lives in localStorage, which the server cannot read. The first
 * client render therefore uses the defaults, the same as the server HTML, and
 * the saved layout applies right after hydration.
 */
export function ProjectNavItems({ projectId }: { projectId: string }) {
  const saved = useSidebarNavStore((s) => s.items);
  const hydrated = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const items = hydrated ? saved : SIDEBAR_NAV_DEFAULTS;
  return (
    <>
      {items.map((entry) => (
        <NavItem key={entry.id} entry={entry} projectId={projectId} />
      ))}
      <MoreNavItem projectId={projectId} items={items} />
    </>
  );
}

/**
 * The last nav row. Its menu holds every row set to "Show in More", so hiding
 * a row never makes its page unreachable, and then the one pointer path into
 * "Customize sidebar". Absent when the project offers the caller no row.
 */
function MoreNavItem({
  projectId,
  items,
}: {
  projectId: string;
  items: readonly SidebarNavEntry[];
}) {
  const t = useTranslations('sidebar');
  const meta = useNavRowMeta(projectId);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hidden = items.filter((e) => e.visibility === 'never' && meta[e.id]);

  const closeSheet = () => {
    if (isMobile) setOpenMobile(false);
  };

  // A mouse opens the menu on hover. Touch and keyboard keep the click and
  // Enter/Space toggle from Radix.
  const cancelClose = () => clearTimeout(closeTimer.current);
  const hoverOpen = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    cancelClose();
    setOpen(true);
  };
  const hoverClose = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);

  // No row this project offers the caller: nothing to arrange and nothing
  // hidden to reach, so the row would open a menu with nothing in it.
  if (Object.keys(meta).length === 0) return null;

  return (
    <SidebarMenuItem>
      {/* Non-modal: a modal menu sets pointer-events: none on the body, which
          fires pointerleave on the row and closes the menu it just opened. */}
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={t('more')}
            className="group/menu-button text-sidebar-foreground relative"
            onPointerEnter={hoverOpen}
            onPointerLeave={hoverClose}
            // Hover already opened it: stop the Radix pointerdown toggle from
            // closing the menu when the mouse then clicks the row.
            onPointerDown={(e) => {
              if (e.pointerType === 'mouse' && open) e.preventDefault();
            }}
          >
            <span className="shrink-0">
              <DotsThreeOutlineIcon weight="fill" />
            </span>
            <span className="truncate">{t('more')}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="right"
          sideOffset={8}
          className="w-[15rem]"
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
        >
          {hidden.map((entry) => {
            const row = meta[entry.id]!;
            return (
              <DropdownMenuItem key={entry.id} asChild size="sm">
                <Link href={row.href} prefetch={false} onClick={closeSheet}>
                  {row.icon}
                  {row.label}
                </Link>
              </DropdownMenuItem>
            );
          })}
          {hidden.length > 0 ? <DropdownMenuSeparator /> : null}
          {/* Opens a modal from a menu: let the menu close and return focus
              first, the same deferral as the workspace menu rows. */}
          <DropdownMenuItem
            size="sm"
            onSelect={() => {
              setOpen(false);
              requestAnimationFrame(openCustomizeSidebar);
            }}
          >
            <SidebarGlyph />
            {t('customizeSidebar')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

/**
 * Customize: every capability point (the agents, All agents, New agent,
 * Review, Members, Models, Settings) behind one row. Where hover exists the
 * row works like Apps: it links to All agents, and a mouse on it opens the
 * hover card with every point at once, with no delay (`useNavHoverCard`). On a
 * touch screen or the collapsed rail there is no hover, so the row toggles
 * the same points as a submenu, open by itself on a Customize page. Absent
 * when the caller may open no capability page (same gate as the tab bar).
 */
function CustomizeNavEntry({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const access = useCapabilityAccess(projectId);
  // No delay: the card opens as the pointer reaches the row.
  const card = useNavHoverCard({ enabled: true, openDelay: 0 });
  // `includes` tolerates the locale prefix the host may not strip. Project
  // admin counts: the group's Settings row leads there.
  const onCustomizePage = !!pathname && (pathname.includes('/customize') || isProjectAdminPath(pathname));
  // Submenu only: open on a Customize page, closed off it; a click overrides
  // that until you cross between those contexts.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [onCustomizePage]);
  const open = override ?? onCustomizePage;

  if (!access.settled || access.tabs.length === 0) return null;

  const glyph = (
    <span className="shrink-0">
      <CustomizeGlyph />
    </span>
  );

  if (card.available) {
    return (
      <Popover open={card.open} onOpenChange={card.setOpen}>
        <PopoverAnchor virtualRef={card.anchorRef} />
        <ProjectNavRow
          active={onCustomizePage}
          label={t('customize')}
          href={capabilityTabHref(projectId, 'agent')}
          prefetch
          {...card.rowProps}
        >
          {glyph}
          {t('customize')}
        </ProjectNavRow>
        <NavHoverCardContent {...card.contentProps}>
          <ProjectCapabilityNav projectId={projectId} card onNavigate={() => card.setOpen(false)} />
        </NavHoverCardContent>
      </Popover>
    );
  }

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setOverride(!open)}
          aria-expanded={open}
          className="group/menu-button text-sidebar-foreground"
        >
          {glyph}
          <span className="truncate">{t('customize')}</span>
          <CaretRightIcon
            weight="bold"
            className={cn(
              'text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
        </SidebarMenuButton>
      </SidebarMenuItem>
      {open ? <ProjectCapabilityNav projectId={projectId} /> : null}
    </>
  );
}

function NavItem({ entry, projectId }: { entry: SidebarNavEntry; projectId: string }) {
  if (entry.visibility === 'never') return null;
  switch (entry.id) {
    case 'customize':
      return <CustomizeNavEntry projectId={projectId} />;
    case 'apps':
      return <ProjectAppsNavItem projectId={projectId} />;
    case 'files':
      return <ProjectFilesNavItem projectId={projectId} />;
    case 'rooms':
      return <ProjectRoomsNavItem projectId={projectId} />;
    case 'goals':
      return <ProjectGoalsNavItem projectId={projectId} />;
    case 'artifacts':
      return <ProjectArtifactsNavItem projectId={projectId} />;
  }
}
