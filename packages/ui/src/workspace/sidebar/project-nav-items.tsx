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
import { isProjectAdminPath, ProjectCapabilityNav, useOpenNewAgent } from '../../internal/layout/project-capability-nav';
import { capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import Hint from '../../primitives/hint';
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
import { CaretRightIcon, DotsThreeOutlineIcon, ListIcon, PlusIcon } from '@phosphor-icons/react';
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
 * Customize, for the people who may configure the project. Most configuring
 * happens by asking an agent in a session, so this stays one disclosure: the
 * row toggles the project's agents, Review, Models and Settings
 * (`ProjectCapabilityNav`). On hover, its right edge holds
 * + (New agent) and All agents. Open by itself on an agent or Customize page;
 * a click overrides that until you cross between those contexts. Absent when
 * the caller may open no capability page (same gate as the tab bar).
 */
function CustomizeNavEntry({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const tTabs = useTranslations('agentEditor.tabs');
  const pathname = useUiPathname();
  const access = useCapabilityAccess(projectId);
  const canCreate = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const openNewAgent = useOpenNewAgent();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // `includes` tolerates the locale prefix the host may not strip.
  const onCustomizePage = !!pathname && (pathname.includes('/customize') || isProjectAdminPath(pathname));
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [onCustomizePage]);
  const open = override ?? onCustomizePage;

  if (!access.settled || access.tabs.length === 0) return null;
  const hasAgents = access.tabs.includes('agent');
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <SidebarMenuItem className="group/customize">
        <SidebarMenuButton
          onClick={() => setOverride(!open)}
          aria-expanded={open}
          // The caret is the Sessions header's: 12px (beats the button's
          // `[&_svg]:size-4!`), shown on hover, turned when open.
          className="group/menu-button text-sidebar-foreground pr-14 [&>svg:last-child]:size-3!"
        >
          <span className="shrink-0">
            <CustomizeGlyph />
          </span>
          <span className="truncate">{t('customize')}</span>
          <CaretRightIcon
            aria-hidden
            className={cn(
              'text-muted-foreground duration-normal size-3 shrink-0 opacity-0 transition-transform ease-out group-focus-within/customize:opacity-100 group-hover/customize:opacity-100',
              open && 'rotate-90',
            )}
          />
        </SidebarMenuButton>
        {hasAgents ? (
          <ButtonGroup className="absolute top-1/2 right-1 -translate-y-1/2 opacity-100 transition-opacity group-focus-within/customize:opacity-100 group-hover/customize:opacity-100 md:opacity-0">
            {canCreate && openNewAgent ? (
              <Hint side="top" label={tTabs('newAgent')}>
                <Button
                  variant="secondary"
                  size="icon-xs"
                  type="button"
                  aria-label={tTabs('newAgent')}
                  onClick={() => {
                    close();
                    openNewAgent();
                  }}
                >
                  <PlusIcon className="size-4" />
                </Button>
              </Hint>
            ) : null}
            <Hint side="top" label={tTabs('allAgents')}>
              <Button variant="secondary" size="icon-xs" asChild>
                <Link href={capabilityTabHref(projectId, 'agent')} prefetch={false} aria-label={tTabs('allAgents')} onClick={close}>
                  <ListIcon className="size-4" />
                </Link>
              </Button>
            </Hint>
          </ButtonGroup>
        ) : null}
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
