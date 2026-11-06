import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';

/**
 * Navigation Suspense boundary for /projects/[id].
 *
 * Two jobs, the same two as the sibling boundary at files/loading.tsx:
 *  1. Paint feedback the instant the click lands, instead of leaving the
 *     previous page frozen while the RSC payload and route chunk arrive.
 *  2. Give Next.js a prefetch target. This route is dynamic — the project
 *     layout awaits cookies() — and for a dynamic route Next.js prefetches only
 *     as far as the nearest loading boundary. Without this file, prefetching
 *     this route is skipped altogether and every click pays a full server
 *     round-trip.
 *
 * It paints the pulsing Kortix mark — the same frame a hard refresh of this
 * route shows (`ProjectPendingScreen`), sized to the content pane. A skeleton
 * used to stand here: a greeting bar, a composer block and three chips. It
 * flashed on every sidebar click into an existing session, because
 * `sessions/[sessionId]/loading.tsx` falls back to this boundary when there is
 * no first-prompt preview, so grey ProjectHome-shaped bars stood in front of
 * a transcript.
 *
 * Deliberately imports no ProjectHome (composer + SessionWelcome + billing):
 * the prefetched payload must stay small. project-loading-contract.test.ts
 * pins that and renders the boundary to prove it paints no skeleton.
 */
export default function ProjectHomeLoading() {
  return <ProjectPendingScreen fill="pane" />;
}
