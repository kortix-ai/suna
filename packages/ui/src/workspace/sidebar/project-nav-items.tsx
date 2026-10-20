'use client';

import { ProjectAppsNavItem } from './footer/project-apps-nav';
import { ProjectRoomsNavItem } from './footer/project-rooms-nav';
import { ProjectFilesNavItem } from './footer/project-files-nav';
import { ProjectCustomizeNavItem } from '../../internal/layout/project-settings-nav';
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
import { DotsThreeOutlineIcon } from '@phosphor-icons/react';
import { UiLink as Link } from '../../providers/ui-provider';
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';

const subscribeNoop = () => () => {};

/** Time to cross the gap between the More row and its menu before it closes. */
const HOVER_CLOSE_DELAY_MS = 150;

/**
 * The customizable nav rows under New session, in the order and with the
 * visibility chosen in "Customize sidebar" (`customize-sidebar-modal.tsx`).
 * Each row still applies its own flag and permission gate.
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

function NavItem({ entry, projectId }: { entry: SidebarNavEntry; projectId: string }) {
  if (entry.visibility === 'never') return null;
  switch (entry.id) {
    case 'customize':
      return <ProjectCustomizeNavItem projectId={projectId} />;
    case 'apps':
      return <ProjectAppsNavItem projectId={projectId} />;
    case 'files':
      return <ProjectFilesNavItem projectId={projectId} />;
    case 'rooms':
      return <ProjectRoomsNavItem projectId={projectId} />;
  }
}
