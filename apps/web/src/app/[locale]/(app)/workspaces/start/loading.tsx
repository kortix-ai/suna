import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';

/**
 * Navigation Suspense boundary for /projects/start.
 *
 * The same two jobs as the sibling boundary at `projects/[id]/loading.tsx`:
 *  1. Paint the door's chrome the instant the click lands, instead of leaving
 *     the previous page frozen while the RSC payload and route chunk arrive.
 *  2. Give Next.js a prefetch target. This route is dynamic, and for a dynamic
 *     route Next.js prefetches only as far as the nearest loading boundary.
 *     Without this file, prefetching `/projects/start` is skipped altogether
 *     and every arrival pays a full server round-trip — which is what lets a
 *     bad RSC response turn the click into a full document load.
 *
 * A skeleton used to stand here — a header bar, two title bars, a composer
 * block and three chips. It was guessing at a page this route never renders:
 * the door resolves to `/projects/<id>` and the real project chrome replaces
 * it, so the fake layout only ever flashed a shape the user was not about to
 * get. `ProjectPendingScreen` is the one frame every "opening a project"
 * surface shares, so the boundary, the client resolve below it, and a hard
 * refresh of the project itself are now a single unbroken paint.
 */
export default function ProjectStartLoading() {
  return <ProjectPendingScreen />;
}
