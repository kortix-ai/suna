/**
 * Navigation Suspense boundary for `/new` — the "Create a project" entry in the
 * sidebar workspace switcher and the landing chooser.
 *
 * Present for the same reason as `settings/loading.tsx`: every route here is
 * dynamic, and a dynamic route without a loading boundary is not prefetched at
 * all, so the switcher's link would still pay a cold RSC fetch on click.
 *
 * A blank canvas, not `RouteLoadingFallback`. That 72px looping logo flashed
 * for a few hundred ms between the landing door's own pending frame and a
 * form that paints right after it — three different loaders on one short
 * navigation. The form is the next frame; nothing needs to announce it.
 */
export default function NewWorkspaceLoading() {
  return <div className="bg-background min-h-svh" aria-busy="true" />;
}
