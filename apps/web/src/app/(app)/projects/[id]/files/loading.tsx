import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';

/**
 * Navigation Suspense boundary for /projects/[id]/files.
 *
 * Two jobs:
 *  1. Paint feedback the instant the click lands, instead of leaving the
 *     previous page frozen while the RSC payload and route chunk arrive. The
 *     feedback is the pulsing Kortix mark (`ProjectPendingScreen`), never a
 *     skeleton of the Drive.
 *  2. Give Next.js a cacheable prefetch target. This route is dynamic — the
 *     project layout awaits cookies() — and for a dynamic route Next.js
 *     prefetches only as far as the nearest loading boundary. Without this
 *     file the sidebar's `<Link prefetch>` has nothing to store.
 *
 * `ProjectFilesView` paints the same mark while its ref resolves, so the
 * boundary hands over to the page without a change of frame.
 */
export default function ProjectFilesLoading() {
  return <ProjectPendingScreen fill="pane" />;
}
