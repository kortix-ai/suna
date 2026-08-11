/**
 * Navigation Suspense boundary for /workspaces/[id].
 *
 * Two jobs, the same two as the sibling boundary at files/loading.tsx:
 *  1. Paint project chrome the instant the click lands, instead of leaving the
 *     previous page frozen while the RSC payload and route chunk arrive.
 *  2. Give Next.js a prefetch target. This route is dynamic — the workspace layout
 *     awaits cookies() — and for a dynamic route Next.js prefetches only as far
 *     as the nearest loading boundary. Without this file, prefetching this route
 *     is skipped altogether and every click pays a full server round-trip.
 *
 * Deliberately imports nothing: no WorkspaceHome (composer + SessionWelcome +
 * billing), no UI primitives. Plain markup keeps the prefetched payload small,
 * which is the entire point of the boundary.
 *
 * A `loading.tsx` boundary covers its own segment plus every descendant segment
 * that has no `loading.tsx` of its own. `files/` has one, so it is unaffected.
 * `sessions/`, `sessions/[sessionId]`, `customize/`, and `customize/[section]`
 * do not, so this WorkspaceHome-shaped skeleton also paints during navigation
 * into a session or into customize. This is known and deliberate, not an
 * oversight — adding a `sessions/loading.tsx` is an explicit non-goal here. If
 * this skeleton ever reads wrong on session navigation, the fix is a
 * `sessions/loading.tsx` that mirrors the session shell's frame instead of
 * WorkspaceHome's, not a change to this file.
 *
 * The outer container mirrors WorkspaceHome's root so the handover does not shift
 * layout. workspace-loading-contract.test.ts pins both properties.
 */
export default function WorkspaceHomeLoading() {
  return (
    <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="m-auto flex w-full max-w-[52rem] flex-col items-center gap-8 px-2 py-8 sm:px-4">
          {/* Greeting line */}
          <div className="bg-muted-foreground/10 h-9 w-[22rem] max-w-full animate-pulse rounded-md" />

          {/* Composer */}
          <div className="bg-muted-foreground/10 h-28 w-full animate-pulse rounded-xl" />

          {/* Suggestion row */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <div className="bg-muted-foreground/10 h-8 w-32 animate-pulse rounded-md" />
            <div className="bg-muted-foreground/10 h-8 w-40 animate-pulse rounded-md" />
            <div className="bg-muted-foreground/10 h-8 w-28 animate-pulse rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
