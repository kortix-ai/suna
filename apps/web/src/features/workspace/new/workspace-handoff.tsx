'use client';

import { m, useReducedMotion } from 'motion/react';
import { useTranslations } from '@/i18n/use-translations';

import { KortixLogo } from '@/components/ui/kortix-logo';
import { TextShimmer } from '@/components/ui/text-shimmer';

const EASE_OUT: [number, number, number, number] = [0, 0, 0.2, 1];

/**
 * The caption lands a beat after the mark rather than with it. Both arrive
 * inside the page's own 180ms fade, so with no offset they read as one block
 * appearing; with it, the mark is the subject and the name is its label.
 * Stretched past the doctrine's 30–80ms stagger because there are only two
 * elements here — too short a gap between exactly two things reads as a
 * stutter rather than a sequence.
 */
const CAPTION_IN = { duration: 0.24, delay: 0.12, ease: EASE_OUT };

/**
 * The bridge between `/new`'s create form and the created workspace's page.
 *
 * It holds the page for the ONE waiting window there is: the create is in
 * flight and no project id exists yet. On success the orchestration stamps the
 * project onboarded and navigates straight to `/projects/<id>` (KRTX-1419), so
 * there is no second window to cover and no moment where the successful create
 * is rendered as the UI being torn down and replaced.
 *
 * Two ambient loops, and neither claims to know more than it does. The mark
 * pulses; the caption shimmers. That is the whole signal, because it is all
 * this screen actually knows — the create is one opaque call with no phase
 * reporting left, so a determinate bar or a step list would be inventing
 * progress. `TextShimmer` is the same treatment the session transcript's busy
 * line uses (`session-starting-loader.tsx`), so "working on it" reads the same
 * here as it does mid-session.
 *
 * `motion-reduce:animate-none` gates the pulse: Tailwind's `animate-pulse` is
 * an infinite loop, and `globals.css` has no blanket `prefers-reduced-motion`
 * rule that would stop it. (`TextShimmer` has the same gap internally — it is
 * shared with two other surfaces, so it is not fixed from here.)
 *
 * `role="status"` (+ the explicit `aria-live`, for ATs that do not map the
 * role) makes the caption the announced content; the mark is decoration and is
 * hidden.
 */
export function WorkspaceHandoff({ workspaceName }: { workspaceName: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const reduceMotion = useReducedMotion();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col items-center gap-6 text-center"
    >
      <KortixLogo
        aria-hidden
        size={44}
        variant="icon"
        className="text-foreground animate-pulse motion-reduce:animate-none"
      />

      <m.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={CAPTION_IN}
      >
        <TextShimmer>
          {workspaceName ? `Creating ${workspaceName}` : tI18nComplete.raw('textbc3528a9d83c')}
        </TextShimmer>
      </m.div>
    </div>
  );
}
