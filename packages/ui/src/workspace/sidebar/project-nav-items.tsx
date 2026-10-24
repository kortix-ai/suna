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
import { ProjectSpacesNav } from './project-spaces-nav';
import { cn } from '../../lib/utils';
import { SidebarMenuButton, SidebarMenuItem } from '../../primitives/sidebar';
import { useTranslations } from '../../i18n';
import { SIDEBAR_NAV_DEFAULTS, type SidebarNavEntry } from '../../internal/stores/sidebar-nav-store';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useUiPathname } from '../../providers/ui-provider';
import { useEffect, useState } from 'react';

/**
 * Every nav row under New session, always rendered, in `SIDEBAR_NAV_DEFAULTS`
 * order (Marko, 2026-10-24: everything in the sidebar, no More menu, while the
 * arrangement is worked out). Each row still applies its own flag and
 * permission gate, so a row the project does not offer stays absent.
 */
export function ProjectNavItems({ projectId }: { projectId: string }) {
  return (
    <>
      {SIDEBAR_NAV_DEFAULTS.map((entry) => (
        <NavItem key={entry.id} entry={entry} projectId={projectId} />
      ))}
      <ProjectSpacesNav projectId={projectId} />
    </>
  );
}

/**
 * Customize — one collapsible parent that holds every capability point (Agents,
 * Skills, Connectors, Triggers, Reminders, Models, Secrets, Repo, Review,
 * Settings) as nested sub-rows, so the config surfaces live under one row
 * instead of a scatter of standalone menu items. Clicking the row toggles the
 * submenu; the sub-rows navigate. The submenu auto-opens while you are on a
 * capability page so the active point is always visible. Absent when the caller
 * may open no capability page (same gate as the tab bar).
 */
function CustomizeNavEntry({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const access = useCapabilityAccess(projectId);
  // Follow the page: the submenu is open on a Customize page and closed off it,
  // so it does not sit expanded while you are in a session. A manual click
  // overrides that until you cross between those contexts, then it follows the
  // page again. `includes` tolerates the locale prefix the host may not strip.
  // Project admin counts: the group's Settings row opened it, so the row stays
  // in view and lit there.
  const onCustomizePage = !!pathname && (pathname.includes('/customize') || isProjectAdminPath(pathname));
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [onCustomizePage]);
  const open = override ?? onCustomizePage;

  if (!access.settled || access.tabs.length === 0) return null;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setOverride(!open)}
          aria-expanded={open}
          className="group/menu-button text-sidebar-foreground"
        >
          <span className="shrink-0">
            <CustomizeGlyph />
          </span>
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
