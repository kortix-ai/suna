'use client';

import { KortixLogo } from '@/components/ui/kortix-logo';
import { useTranslations } from '@/i18n/use-translations';

/**
 * The full-viewport frame shown while a project is being opened.
 *
 * Four surfaces render it, and together they are the whole "getting into a
 * project" path, so they must not each invent their own frame:
 *  - `(auth)/auth/page.tsx` — the hand-off after a password is accepted,
 *    while the redirect runs.
 *  - `projects/start/loading.tsx` — the navigation Suspense boundary.
 *  - `projects/start/page.tsx` — the client frame, while the landing
 *    destination resolves.
 *  - `project-access-boundary.tsx` — every hard refresh of `/projects/<id>`
 *    and of a session route, while Supabase resolves the session and the
 *    first `getProject` is in flight.
 *
 * They run back to back, so sharing one frame is the point: signing in now
 * paints this mark once and holds it across three navigations instead of
 * flashing a welcome headline, then a legal footer, then a spinner, then a
 * skeleton.
 *
 * It used to be two different things: a skeleton of a page this route never
 * renders, and `AuthPendingScreen`'s spinner on a blank field. The mark says
 * the same thing without guessing at a layout, and it is the same mark the
 * account gets on a branded workspace — `variant="icon"` reads `useBranding()`
 * (see `@/components/ui/kortix-logo`).
 *
 * `AuthPendingScreen` still owns the consent sub-flows (OAuth, CLI, tunnel,
 * GitHub setup, preview). There the spinner sits inside a frame that carries a
 * mark and a legal footer already, so a second mark would be a duplicate.
 *
 * Motion: opacity only, so `prefers-reduced-motion` leaves a static mark
 * rather than no feedback at all. The mark never spins — `Loading` is this
 * app's only spinner.
 */
export function ProjectPendingScreen() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div
      className="bg-background flex min-h-svh items-center justify-center"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">{tI18nComplete.raw('text9498be620d80')}</span>
      <KortixLogo
        size={28}
        variant="icon"
        className="text-foreground motion-safe:animate-pulse"
        aria-hidden="true"
      />
    </div>
  );
}
