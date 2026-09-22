/**
 * `/projects/[id]/files` — the project's files, opened from the drawer's
 * Files nav pill (the project dock, which had its own `page:files-nav`
 * entry to the same page, was removed). Its PageHeader shows the hamburger,
 * which opens the project drawer. The project comes from
 * ProjectRouteProvider: a drawer push carries no route params.
 */
import { FilesNavPage } from '@/components/pages/FilesNavPage';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { PAGE_TABS } from '@/stores/tab-store';

export default function ProjectFilesScreen() {
  const { projectId, openDrawer, isDrawerOpen, openCustomizeSheet } = useProjectRoute();
  // A session opened from the drawer replaces this page with the view.
  useCoveringRoute();

  return (
    <FilesNavPage
      page={PAGE_TABS['page:files-nav']}
      projectId={projectId}
      onOpenDrawer={openDrawer}
      isDrawerOpen={isDrawerOpen}
      onOpenRightDrawer={openCustomizeSheet}
    />
  );
}
