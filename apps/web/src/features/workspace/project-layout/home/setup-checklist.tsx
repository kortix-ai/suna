'use client';

import { CheckCircleIcon, CircleIcon, XIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Progress } from '@/components/ui/progress';
import { useSlackInstall } from '@/hooks/channels/use-channels-installations';
import { cn } from '@/lib/utils';
import { getProjectDetail, listConnectors, listProjectAccess } from '@kortix/sdk';
import { contract, qk, useProjectTriggers } from '@kortix/sdk/react';
import {
  BAND_HEADER_CLASS,
  BAND_LIST_CLASS,
  BAND_PANEL_CLASS,
  BAND_ROW_CLASS,
  BAND_ROW_HOVER_CLASS,
  BAND_TITLE_CLASS,
} from './band';
import {
  CHECKLIST_HIDDEN_UNKNOWN,
  deriveSetupCompletion,
  hideChecklist,
  orderStepsOpenFirst,
  readChecklistHidden,
  subscribeChecklistHidden,
  type ProjectSetupStepKey,
} from './setup-steps';

/**
 * The house ease-out — the strong quintic curve, not the browser's weak
 * built-in. Same value the composer card already animates its border on, so
 * the two surfaces in this column move on one curve.
 */
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** Enter bridges the gap between the composer painting and this band arriving
 *  a tick later, once storage has answered. Exit runs at 80% of it. */
const BAND_ENTER = { duration: 0.2, ease: EASE_OUT } as const;
const BAND_EXIT = { duration: 0.16, ease: EASE_OUT } as const;

/** A step going from open to done, once per step per project, ever. */
const TICK = { type: 'spring', duration: 0.25, bounce: 0 } as const;

/**
 * A row changing rank when its step completes. This is an element already on
 * screen moving to a new place, not one entering or leaving, so it takes the
 * in-out curve — accelerate away, decelerate into the new slot — where every
 * other transition on this surface takes the ease-out.
 */
const REORDER = { duration: 0.2, ease: [0.77, 0, 0.175, 1] } as const;

export interface ProjectSetupStep {
  key: ProjectSetupStepKey;
  title: string;
  /** Already IAM-filtered and resolved by the caller. `undefined` while a
   *  dependency is still loading — the row renders inert rather than linking
   *  to a broken URL. */
  href: string | undefined;
}

/**
 * The project's "Get started" checklist — the setup destinations, each with
 * whether it is actually done.
 *
 * ## Why the completion state is derived, not stored
 *
 * There is no aggregated setup-status endpoint, and adding one would introduce
 * a second source of truth that drifts the moment someone adds a connector
 * outside this flow. Each step instead reads the SAME cache entry its own
 * capability page reads (`qk.project.connectors`, `qk.project.triggers`,
 * `qk.project.detail`, `qk.project.access`), so a step ticks over the instant
 * the user comes back from doing it — no invalidation wiring of our own.
 *
 * ## Why the reads are gated three ways
 *
 * `project-home` deliberately did not fetch counts before this existed. That
 * budget is respected by never firing a read the page cannot use:
 *
 * 1. **Hidden** — dismissed or already finished. `hidden` starts `null` ("the
 *    server cannot know") and every query is disabled until the client
 *    answers, so a hidden checklist costs ZERO requests.
 * 2. **Denied** — a step the caller's IAM filter dropped never has its read
 *    fired. `wants()` is the gate.
 * 3. **Finished** — once every step is complete the flag is written and the
 *    section unmounts, so later visits are back to zero requests.
 *
 * Two of the steps (skills, agent) come out of `qk.project.detail`, which
 * project-home already has in flight, so those two are free. The real cost is
 * at most four new GETs — connectors, triggers, the Slack install probe, and
 * project access — and only while setup is genuinely incomplete.
 *
 * ## Motion
 *
 * Three moments, and nothing else moves:
 *
 * - **The band arriving.** It mounts a tick after the composer. `height: 0 →
 *   auto` on the clipper grows the band into place; the content fades and
 *   rises 8px inside it.
 * - **The band leaving.** Same collapse in reverse at 80% of the duration, so
 *   dismissing recovers the space smoothly instead of snapping.
 *
 *   Both also smooth the COLUMN: `welcome-body.tsx` centres it, so a change in
 *   this band's height moves the composer. That used to be a jump on dismissal
 *   — the band vanished and the column snapped to a new centre. It is a much
 *   smaller move now, because this slot is never empty: the starter prompts
 *   take it over the moment the checklist gives it up (`fallback` below), so
 *   the swap is one band's height for another's rather than a band's height
 *   for nothing.
 * - **A step ticking.** `AnimatePresence initial={false}` — the check springs
 *   in only when a step is COMPLETED while you are looking, never on mount.
 *   Six checks popping on every paint would be noise; one popping when you
 *   come back from connecting Slack is the payoff.
 *
 * There is no row stagger. This is product UI, and a stagger's delay is billed
 * to the reader on every single paint.
 */
export function ProjectSetupChecklist({
  projectId,
  steps,
  fallback,
  className,
}: {
  projectId: string;
  steps: ProjectSetupStep[];
  /**
   * What occupies this slot when the checklist has nothing to say —
   * `StarterPromptBand` in practice.
   *
   * It is rendered HERE rather than chosen by a parent because this component
   * is the only thing that knows the answer: "is the checklist showing" is
   * `settled && !allDone`, and `settled` folds the dismissal store together
   * with five probes that live in this function body. Reporting that upward
   * would mean a callback, parent state and an extra render to say something
   * the slot's own owner already knows.
   *
   * Optional: a host that passes nothing gets an empty slot, which is what the
   * instant session shell wants.
   */
  fallback?: ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  // `null` until the client has read storage. See the gate note above.
  const hidden = useSyncExternalStore<boolean | null>(
    subscribeChecklistHidden,
    () => readChecklistHidden(projectId),
    () => CHECKLIST_HIDDEN_UNKNOWN,
  );

  const dismiss = useCallback(() => hideChecklist(projectId), [projectId]);

  const live = hidden === false;
  const wants = (key: ProjectSetupStepKey) => live && steps.some((s) => s.key === key);

  const connectors = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    enabled: wants('connectors'),
    ...contract('config'),
  });

  // Passing `null` is how these hooks are disabled — each carries its own
  // `enabled: !!projectId`.
  const triggers = useProjectTriggers(wants('triggers') ? projectId : null);
  const slack = useSlackInstall(wants('slack') ? projectId : null);

  // Skills AND agents both live on the project config summary, so the two
  // steps share one read — and it is a read project-home already issues.
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: wants('skills') || wants('agent'),
    ...contract('config'),
  });

  const access = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId),
    enabled: wants('team'),
    ...contract('inventory'),
  });

  const done = deriveSetupCompletion({
    connectorCount: connectors.data?.connectors?.length ?? 0,
    triggerCount: triggers.data?.triggers?.length ?? 0,
    skillCount: detail.data?.config?.skills?.length ?? 0,
    agentCount: detail.data?.config?.agents?.length ?? 0,
    memberCount: access.data?.members?.length ?? 0,
    slackConnected: Boolean(slack.data),
  });

  // Every probe this checklist actually depends on has produced an answer.
  //
  // NOTHING renders before this. The band waits for the full picture and then
  // paints once, already in its final order, with a real count.
  //
  // It used to paint as soon as the step list existed, on the theory that a
  // late band would shove the composer. That theory cost more than it saved:
  // with no answers yet every step reads as open, so the rows came up in
  // declaration order and then RE-RANKED as each probe landed — a shuffle the
  // reader has no way to interpret, right where they are trying to read a
  // list. The band's `height` enter animation already solves the arrival: the
  // column glides rather than jumps, so waiting costs a glide, not a lurch.
  const settled =
    live &&
    (!wants('connectors') || connectors.isSuccess || connectors.isError) &&
    (!wants('triggers') || triggers.isSuccess || triggers.isError) &&
    (!wants('slack') || slack.isSuccess || slack.isError) &&
    (!wants('team') || access.isSuccess || access.isError) &&
    (!(wants('skills') || wants('agent')) || detail.isSuccess || detail.isError);

  const completed = steps.filter((step) => done[step.key]).length;
  const allDone = settled && completed === steps.length;

  // Finished — remember it, so the next visit fires none of the reads above.
  // In an effect, not in render: `hideChecklist` is a side effect, and
  // `allDone` flips during a render pass driven by React Query. It sets no
  // state of its own; the store notifies and `useSyncExternalStore` picks the
  // change up.
  useEffect(() => {
    if (allDone) hideChecklist(projectId);
  }, [allDone, projectId]);

  // `settled`, not `live`: see the note above. `allDone` already implies
  // `settled`, so a finished checklist never flashes on its way to hidden.
  const open = settled && !allDone;

  /**
   * The answer is KNOWN — which is not the same as `!open`.
   *
   * There are two windows where the checklist is not showing and we do not yet
   * know whether it will: before the client has read the dismissal store
   * (`hidden === null`, which is every server render and the first client
   * frame), and while the probes above are still in flight. Treating either as
   * "no checklist" would paint the fallback and then shove it out a beat
   * later — the exact shuffle the `settled` gate above was written to stop.
   *
   * `hidden === true` short-circuits the probes on purpose: a dismissed
   * checklist runs none of them, so waiting on `settled` there would leave the
   * slot empty forever for the users who see the fallback most.
   */
  const resolved = hidden === true || settled;

  return (
    // `mode="wait"`, so the band's height collapse finishes before the
    // fallback lands. Overlapping them would cross-fade one panel through
    // another at two different heights.
    <AnimatePresence mode="wait">
      {open ? (
        // The clipper. It owns the height so the column re-centres smoothly;
        // it owns no padding or background, so a collapsed band is genuinely
        // zero pixels. Under reduced motion the height is left alone entirely
        // — a collapsing container is the movement being opted out of.
        <m.div
          key="project-setup-checklist"
          initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={
            reduceMotion
              ? { opacity: 1, transition: { duration: 0.15 } }
              : { height: 'auto', opacity: 1, transition: BAND_ENTER }
          }
          exit={
            reduceMotion
              ? { opacity: 0, transition: { duration: 0.12 } }
              : { height: 0, opacity: 0, transition: BAND_EXIT }
          }
          className={cn('w-full overflow-hidden', className)}
        >
          <m.section
            aria-label="Get started"
            initial={reduceMotion ? false : { y: 8 }}
            animate={reduceMotion ? undefined : { y: 0, transition: BAND_ENTER }}
            // Flat on the page, the way the reference lays it out — no border,
            // no card. The translucent wash is the one concession: this sits
            // over the animated wallpaper, and legibility outranks flatness.
            className={BAND_PANEL_CLASS}
          >
            <div className={BAND_HEADER_CLASS}>
              <h2 className={BAND_TITLE_CLASS}>Get started</h2>

              {/* No presence gate: the band only exists once `settled` is
                  true, so the count is a fact from the first frame it is
                  visible. It never reads "0 of 6" on its way to the truth. */}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {completed} of {steps.length}
                </span>
                <Progress
                  value={(completed / steps.length) * 100}
                  aria-label={`${completed} of ${steps.length} setup steps complete`}
                  className="bg-muted h-1.5 w-16 shrink-0"
                  indicatorClassName="bg-kortix-green"
                />
              </div>

              <Hint label="Hide this" side="top">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={dismiss}
                  aria-label="Hide the get started checklist"
                  className="text-muted-foreground shrink-0"
                >
                  <XIcon className="size-3.5" />
                </Button>
              </Hint>
            </div>

            {/* Open steps first, done ones after — and correct on the first
                frame, because the band does not exist until every probe has
                answered. The only re-rank left is the rare live one: a step
                completing while the band is open, after a window-focus
                refetch. That one is a `layout` move, so the row slides down
                into the done block instead of teleporting out from under the
                check that just ticked. */}
            <div className={BAND_LIST_CLASS}>
              {orderStepsOpenFirst(steps, done).map((step) => (
                <SetupChecklistRow key={step.key} step={step} done={done[step.key]} />
              ))}
            </div>
          </m.section>
        </m.div>
      ) : resolved && fallback ? (
        // `initial={false}` — never an enter animation, on first paint or on
        // the swap after a dismissal. The fallback is the hero's resting state
        // and is seen on every project open; `StarterPromptBand`'s own header
        // explains why motion there is a cost with no information in it. The
        // exit exists only for the rare return trip, when a completed step is
        // undone and the checklist comes back.
        <m.div
          key="project-home-band-fallback"
          initial={false}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: BAND_EXIT }}
          className={cn('w-full', className)}
        >
          {fallback}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * One step. The indicator lane is a fixed-width slot occupied in both states,
 * so every label starts on the same vertical line whether or not the step is
 * finished.
 */
function SetupChecklistRow({ step, done }: { step: ProjectSetupStep; done: boolean }) {
  const reduceMotion = useReducedMotion();

  const body = (
    <>
      {/*
        ONE lane, and both states draw their circle the SAME way: a Phosphor
        glyph at the same size in the same box. That is the whole alignment
        fix.

        It used to be two mechanisms. Open drew a 1px CSS `border` on a
        `size-4` box — a circle 14.72px across. Done dropped that border and
        centred a `size-4.5` filled `CheckCircle` inside the same box — a
        circle ~16.5px across, overflowing the box by ~0.9px on every side.
        Two diameters on two silhouettes cannot line up in a column no matter
        how they are centred, which is exactly how it read.

        `Circle` and `CheckCircle` share Phosphor's 256 viewBox and render at
        one size here, so the outlined ring and the filled disc are the same
        circle in the same place. Swapping one for the other moves nothing.
      */}
      <span aria-hidden className="relative size-4.5 shrink-0">
        {/*
          Both glyphs stay mounted and cross-fade on `done`, stacked on
          `inset-0` so they share a centre exactly. No `AnimatePresence`: with
          `initial={false}` each span starts AT its target, so an already-done
          step is simply drawn done on mount and only a step that completes
          while you are watching animates.
        */}
        <m.span
          initial={false}
          animate={{ opacity: done ? 0 : 1 }}
          transition={TICK}
          className="absolute inset-0 flex"
        >
          <CircleIcon className="text-border size-4.5" />
        </m.span>
        <m.span
          initial={false}
          animate={{ opacity: done ? 1 : 0, scale: done || reduceMotion ? 1 : 0.8 }}
          transition={TICK}
          className="absolute inset-0 flex"
        >
          <CheckCircleIcon weight="fill" className="text-kortix-blue size-4.5" />
        </m.span>
      </span>
      <span
        className={cn(
          'font-kerning-normal min-w-0 flex-1 truncate text-sm text-inherit',
          done ? 'text-kortix-blue' : 'text-foreground',
        )}
      >
        {step.title}
      </span>
    </>
  );

  // No colour branch here: the indicator and the label each own their own
  // done state above. A `text-muted-foreground` on the row was dead the moment
  // the label started setting `text-kortix-blue` itself.
  const rowClass = BAND_ROW_CLASS;

  // Only "Invite your team" can lack a destination, and only while
  // `account_id` is in flight. The row keeps its place and its height rather
  // than reflowing the list.
  const row = step.href ? (
    <HoverPrefetchLink href={step.href} prefetch className={cn(rowClass, BAND_ROW_HOVER_CLASS)}>
      {body}
    </HoverPrefetchLink>
  ) : (
    <span className={rowClass}>{body}</span>
  );

  // `layout` is what turns a re-rank into a slide. Reduced motion opts out
  // entirely — a row travelling across the list is the movement being
  // declined, and the row still arrives, just without the journey.
  return reduceMotion ? row : (
    <m.div layout transition={REORDER}>
      {row}
    </m.div>
  );
}
