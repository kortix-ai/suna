'use client';

import type { ProvisionPhase } from '@kortix/sdk';
import { m, useReducedMotion } from 'motion/react';

import { KortixLogo } from '@/components/ui/kortix-logo';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { TodoStatusIcon } from '@/features/session/tool/shared/todo-helpers';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

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
 * The server's provisioning phases, in the order `runProvision` emits them
 * (`PROVISION_PHASES`, `apps/api/src/projects/provision-core.ts`) — the same
 * order `POST /projects/provision-stream` reports, and the catalog keys under
 * `newWorkspace.handoff.*` (one label per phase id). The SDK's
 * `ProvisionPhase` union mirrors that list; `satisfies` keeps every entry a
 * real phase, and the exhaustive test in `workspace-handoff.test.tsx` fails
 * the moment a phase exists on the wire but has no row here.
 */
export const HANDOFF_STEPS = [
  'validating',
  'creating_repository',
  'registering',
  'seeding',
] as const satisfies readonly ProvisionPhase[];

/**
 * The bridge between `/new`'s create form and the created workspace's page.
 *
 * It holds the page for the ONE waiting window there is: the create is in
 * flight and no project id exists yet. On success the orchestration stamps the
 * project onboarded and navigates straight to `/projects/<id>` (KRTX-1419), so
 * there is no second window to cover and no moment where the successful create
 * is rendered as the UI being torn down and replaced.
 *
 * The managed create reports its progress live — `useCreateWorkspace` holds
 * the latest phase `POST /projects/provision-stream` emits, and when one has
 * arrived this screen renders the four server steps in the server's order:
 * finished steps carry the session todo list's own completed glyph, the step
 * in progress the app's one spinner (`Loading`'s `ring` variant — the same
 * geometry the pending glyph draws, so a step starting work does not swap to
 * a fatter circle), the rest the pending dots. `aria-current="step"` marks
 * the running row. The caption keeps the shimmer; it is still the headline,
 * and the glyphs already carry the per-step state.
 *
 * `phase` null, absent, or not a phase this build knows renders the base
 * screen — the GitHub sources, the plain-POST fallback, and the moment before
 * the first frame have no steps to show, and inventing progress is the one
 * thing this screen must never do.
 *
 * `motion-reduce:animate-none` gates the pulse: Tailwind's `animate-pulse` is
 * an infinite loop, and `globals.css` has no blanket `prefers-reduced-motion`
 * rule that would stop it. (`TextShimmer` has the same gap internally — it is
 * shared with two other surfaces, so it is not fixed from here.)
 *
 * `role="status"` (+ the explicit `aria-live`, for ATs that do not map the
 * role) makes the caption and the step list the announced content; the mark
 * and the glyphs are decoration and are hidden.
 */
export function WorkspaceHandoff({
  workspaceName,
  phase,
}: {
  workspaceName: string;
  /**
   * The latest streamed provisioning phase from `useCreateWorkspace`, or
   * `null`/absent when the create reports none.
   */
  phase?: ProvisionPhase | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('newWorkspace');
  const reduceMotion = useReducedMotion();

  // The wire is JSON, so a newer server CAN report a phase name this build
  // does not know. That is "no phase", not a row to invent: render the base
  // screen exactly as an absent phase would.
  const current = phase && HANDOFF_STEPS.includes(phase) ? HANDOFF_STEPS.indexOf(phase) : -1;

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

      {current !== -1 && (
        <ol className="flex w-fit flex-col gap-2.5 text-left">
          {HANDOFF_STEPS.map((step, index) => (
            <li
              key={step}
              aria-current={index === current ? 'step' : undefined}
              className="flex items-center gap-2.5"
            >
              <TodoStatusIcon
                status={
                  index < current ? 'completed' : index === current ? 'in_progress' : 'pending'
                }
              />
              <span
                className={cn(
                  'text-sm',
                  index === current ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {t(`handoff.${step}`)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
