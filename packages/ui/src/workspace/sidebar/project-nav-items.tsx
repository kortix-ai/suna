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
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';
import { useIsMobile } from '../../internal/hooks';
import { useTranslations } from '../../i18n';
import { CaretRightIcon, ListIcon, PlusIcon } from '@phosphor-icons/react';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { useEffect, useState } from 'react';

/**
 * The nav rows under New session, in one fixed order. Each row applies its
 * own flag and permission gate and renders nothing when the project does not
 * offer it. Spaces are the channel sidebar under the `project_channels` flag
 * (project-spaces-nav.tsx).
 */
const NAV_ROWS = ['customize', 'files', 'apps', 'rooms', 'goals', 'artifacts'] as const;
type NavRowId = (typeof NAV_ROWS)[number];

export function ProjectNavItems({ projectId }: { projectId: string }) {
  return (
    <>
      {NAV_ROWS.map((id) => (
        <NavItem key={id} id={id} projectId={projectId} />
      ))}
    </>
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

function NavItem({ id, projectId }: { id: NavRowId; projectId: string }) {
  switch (id) {
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
