/**
 * `/projects/[id]/account` — the Account page inside the project, opened from
 * the drawer avatar. Same page as the Account tab, with a hamburger header
 * that opens the project drawer, so the current project, the active account,
 * and Log out are reachable without leaving the project.
 */
import * as React from 'react';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { AccountPage } from '@/components/settings/AccountPage';
import { useProject } from '@/lib/projects/hooks';

export default function ProjectAccountScreen() {
  const { openDrawer, projectId, openSubPage } = useProjectRoute();
  // A session opened from the drawer replaces this page with the view.
  useCoveringRoute();

  const { data: project } = useProject(projectId);

  // Opens the project Settings page — the only entry point now that the
  // drawer's gear button is gone (COR-124/COR-157 Task 4). A sub-page pushed
  // over this one: back returns here, with the scroll position intact.
  const openProjectSettings = React.useCallback(() => {
    openSubPage('page:settings');
  }, [openSubPage]);

  return (
    <AccountPage
      presentation="project"
      onOpenMenu={openDrawer}
      projectName={project?.name}
      onOpenProjectSettings={openProjectSettings}
    />
  );
}
