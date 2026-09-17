/**
 * `/projects/[id]/files` — the project's files, opened from the drawer.
 * Renders the same FilesNavPage the dock's `page:files-nav` entry uses. Its
 * PageHeader shows the hamburger, which opens the project drawer. The project
 * comes from ProjectRouteProvider: a drawer push carries no route params.
 */
import { FilesNavPage } from '@/components/pages/FilesNavPage';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { PAGE_TABS } from '@/stores/tab-store';

export default function ProjectFilesScreen() {
  const { projectId, openDrawer, isDrawerOpen } = useProjectRoute();
  // A session opened from the drawer replaces this page with the view.
  useCoveringRoute();

  return (
    <FilesNavPage
      page={PAGE_TABS['page:files-nav']}
      projectId={projectId}
      onOpenDrawer={openDrawer}
      isDrawerOpen={isDrawerOpen}
    />
  );
}
