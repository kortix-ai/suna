'use client';

import { m, useReducedMotion } from 'motion/react';
import Link from 'next/link';

import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';

const EASE_OUT: [number, number, number, number] = [0, 0, 0.2, 1];

/**
 * The caption lands just after the mark rather than with it. The logo builds
 * ITSELF out of its ASCII grid over 800ms — that dissolve is the entrance, and
 * a label arriving in the same frame competes with it for the first look. One
 * beat behind (the doctrine's 30–80ms stagger, rounded up because the logo's
 * reveal is long) makes the mark the subject and the name its label.
 */
const CAPTION_IN = { duration: 0.24, delay: 0.12, ease: EASE_OUT };

/**
 * The escape hatch waits, because in the normal path it is never seen: the
 * wizard is a fullscreen portal and covers this screen as soon as
 * `getProjectDetail` settles, usually well inside 1.6s. Showing the link
 * immediately would put "Go to workspace" on screen for a moment in every
 * single successful create, which reads as an offer to leave at exactly the
 * point the user is being taken somewhere. Delaying it means it only ever
 * appears when it is actually needed — a detail query that is slow, or one
 * that never settles at all.
 */
const ESCAPE_IN = { duration: 0.24, delay: 1.6, ease: EASE_OUT };

/**
 * The bridge between `/new`'s create form and the onboarding wizard.
 *
 * ONE component covers BOTH waiting windows, and that is the whole point:
 * 1. `create` is in flight (`submitting`) — no project id yet.
 * 2. the project exists and `/new?onboarding=<id>` is set, but the wizard is
 *    still `null` while `getProjectDetail` settles.
 *
 * These used to be two different screens — a phase checklist, then a bare
 * `size-4` spinner with a link — so the moment the create SUCCEEDED was
 * rendered as the UI being torn down and replaced. Nothing about that read as
 * progress. Holding one mark across both means the successful create has no
 * visual event at all: the logo keeps turning over and the wizard arrives on
 * top of it.
 *
 * The logo is doing two jobs and both are honest. Its dissolve-in is the
 * entrance; `loop` then replays it as the "still working" signal, which is
 * what this screen actually knows — the create is a single opaque call, so
 * there is no real progress to report and a determinate bar would be a lie.
 * Same component and same `loop` as `RouteLoadingFallback`
 * (`components/common/route-loading.tsx`), so waiting looks the same here as
 * it does on every route transition in the app.
 *
 * `role="status"` (+ the explicit `aria-live`, for ATs that do not map the
 * role) makes the caption the announced content; the mark is decoration and is
 * hidden.
 */
export function WorkspaceHandoff({
  workspaceName,
  projectId,
}: {
  workspaceName: string;
  /** `null` during window 1 — there is nowhere to link to until the project
   *  exists, so the escape hatch is not rendered at all rather than disabled. */
  projectId: string | null;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col items-center gap-6 text-center"
    >
      <KortixHyperLogo
        aria-hidden
        size={44}
        // `startOnView={false}` — this never scrolls into view, it swaps in
        // where the form was, so an IntersectionObserver would only delay it.
        startOnView={false}
        loop
        className="text-foreground"
      />

      <m.p
        className="text-muted-foreground w-full truncate text-sm"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={CAPTION_IN}
      >
        {/* The name comes from the form's own `useState`, so a RELOAD of
            `/new?onboarding=<id>` arrives with it EMPTY — the workspace exists,
            but this page no longer knows what it is called. That is the only
            route to a nameless handoff (the submit gate requires a valid name),
            and it is always window 2, so the fallback says what is true there
            rather than rendering "Creating " with a hole in it. Refetching the
            name would put a query on the page purely to fill a caption the
            wizard is about to cover. */}
        {workspaceName ? (
          <>
            Creating <span className="text-foreground font-medium">{workspaceName}</span>
          </>
        ) : (
          'Opening your workspace'
        )}
      </m.p>

      {projectId ? (
        // Never conditioned on how long the wizard has taken — a timer would
        // make the page hold state about a component it does not own. The
        // delay lives in the transition, so this is simply "there, later".
        <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ESCAPE_IN}>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}`}
            className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
          >
            Go to workspace
          </Link>
        </m.div>
      ) : null}
    </div>
  );
}
