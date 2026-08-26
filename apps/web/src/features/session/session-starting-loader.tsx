'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Progress } from '@/components/ui/progress';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
} from '@/components/ui/stepper';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { restartProjectSession, sessionStartKey, type SessionStartStage } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import {
  CheckCircleIcon as CheckCircleSolid,
  ArrowCounterClockwiseIcon as RotateCcw,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

/**
 * The ONE loader shown while a session's Kortix Computer comes up — full-screen
 * for resumes, and dead-center in the side panel while a fresh session boots.
 * All the heavy lifting (provision / wake / OpenCode readiness + pin) is
 * server-side behind POST /sessions/:id/start; this just reports the real stage.
 *
 * Visual: a single left-aligned block, centered on screen. Two orthogonal
 * signals, because "which step" and "how far along" are different questions and
 * a checklist alone only answers the first — a 20s boot with a stationary
 * spinner reads as wedged. So: a determinate rail carries PROGRESS, the
 * checklist carries IDENTITY. Every state change is blur-bridged (see
 * {@link MORPH}) so nothing hard-cuts.
 *
 * Motion hierarchy — one job each, no two elements saying the same thing:
 * - brand dot     → ambient "app is alive" (opacity-only pulse; never `animate-ping`,
 *                   which scales 2× and dominates a screen this quiet)
 * - rail / ring   → how far along the boot is (determinate, informational)
 * - spinning ring → which step is in flight
 * - label shimmer → which row is the live one
 */
const LOADER_DELAY_MS = 100;
/**
 * How long we sit in the backend `starting` stage before softly advancing from
 * "Preparing your workspace" to "Starting the agent". Both happen within that
 * one backend stage (clone → OpenCode boot), so the advance reflects real order.
 */
const STARTING_SUBSTEP_MS = 5_000;
/** After this long, swap the footer copy to set expectations for a cold start. */
const SLOW_AFTER_MS = 15_000;
/**
 * After this long, offer a manual restart. Sandboxes occasionally wedge (e.g. a
 * stuck provider-side proxy) with no server-side signal that anything is wrong —
 * a stop/start of the sandbox is the known fix, so surface it as a fallback
 * instead of leaving the user staring at "Connecting" indefinitely.
 */
export const STUCK_AFTER_MS = 45_000;

/**
 * The blur-bridged crossfade used for every state swap in this loader (step
 * label, ring → check, footer copy). Blur is the load-bearing property: without
 * it a crossfade reads as two objects overlapping, which is exactly why the old
 * hard-cut swap felt like the label teleported. Blur blends the two states so
 * the eye perceives ONE thing changing. `bounce: 0` keeps it buttery, never
 * playful — this is status reporting, not celebration.
 */
const MORPH = { type: 'spring', duration: 0.3, bounce: 0 } as const;

/**
 * The `compact` variant's message swap — deliberately plainer than {@link MORPH}.
 *
 * It runs sequentially (`mode="wait"`): the old message is fully gone before the
 * new one arrives. With no overlap there are no "two objects" to blend, so the
 * blur bridge earns nothing and is dropped — as are the spring and the layout
 * animation, which resizes the container by scale-correcting its transform and
 * visibly distorts the text while it settles. What's left is two properties,
 * one easing, and a 4px drift. Exit runs at two-thirds of enter so the swap
 * clears briskly and settles gently.
 */
const EASE_OUT: [number, number, number, number] = [0, 0, 0.2, 1];
const MESSAGE_IN = { duration: 0.24, ease: EASE_OUT };
const MESSAGE_OUT = { duration: 0.16, ease: EASE_OUT };

interface Step {
  /** Row label in the checklist, and the headline in the compact variant. */
  label: string;
  /** The compact variant's supporting line. Says what the step actually does. */
  description: string;
}

/**
 * How the boot steps are laid out:
 * - `stepper` — the full vertical checklist with a progress rail (full-screen
 *               resume loader + side action panel). Every step is visible;
 *               earlier ones morph to a green check as the boot advances.
 * - `compact` — spinner + headline + description, and nothing else. One message
 *               at a time, swapped as the boot advances. For surfaces that want
 *               a plain status card rather than a checklist.
 *
 * There was a third, `inline`, which reported the boot inside the chat thread.
 * It is gone on purpose: a user who has just sent a message is waiting on an
 * answer, not on infrastructure, so the thread now shows the same "Thinking" row
 * it shows for every other wait. Boot detail belongs here, in the panel.
 */
type BootStepVariant = 'stepper' | 'compact';

/**
 * Copy is deliberately parallel — four gerund headlines, so the checklist reads
 * as one list rather than four unrelated sentences — and the descriptions map
 * 1:1 onto what the backend is really doing at that stage (see activeStep).
 * The tone warms as the wait lengthens: the last description is the only one
 * that reassures, because that's the point where people start to wonder.
 */
export const STEPS: Step[] = [
  { label: 'Reserving your computer', description: 'Finding you a secure, isolated machine.' },
  { label: 'Loading your workspace', description: 'Copying your project files into place.' },
  { label: 'Waking the agent', description: 'Starting the runtime and loading your tools.' },
  { label: 'Connecting', description: 'Linking you to your session. Almost there.' },
];

/**
 * Resolve which step is CURRENTLY active from the backend stage plus how long
 * we've been in it. The index is the floor we KNOW we're at — earlier steps are
 * genuinely complete, later ones haven't started.
 */
export function activeStep(stage: SessionStartStage, msInStage: number): number {
  if (stage === 'provisioning') return 0;
  if (stage === 'starting') return msInStage >= STARTING_SUBSTEP_MS ? 2 : 1;
  return 3; // ready → the FE active-server switch + health poll ("connecting")
}

/**
 * Overall boot completion, as a percentage, for the progress rail.
 * Deliberately sits at the MIDPOINT of the active step (12.5 / 37.5 / 62.5 /
 * 87.5 for four steps): we have no sub-step telemetry, so any other placement
 * would be a claim we can't back. The midpoint also means the bar is never at 0
 * (reads as dead on arrival) and never at 100 (reads as a lie while we're still
 * connecting) — and each advance is a visible, earned jump.
 */
export function bootProgressPct(active: number): number {
  return ((Math.min(active, STEPS.length - 1) + 0.5) / STEPS.length) * 100;
}

/**
 * The shared boot clock: a 1s tick that resolves the CURRENT active step from
 * the backend stage plus time-in-stage (so the `starting` soft-advance fires),
 * and exposes `now` for any caller-side elapsed/slow/stuck math.
 */
function useBootProgress(stage: SessionStartStage): { active: number; now: number } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Reset the per-stage clock whenever the backend stage changes, so the
  // soft-advance measures time spent in the CURRENT stage (not since mount).
  const [stageEnteredAt, setStageEnteredAt] = useState(now);
  const [prevStage, setPrevStage] = useState(stage);
  if (prevStage !== stage) {
    setPrevStage(stage);
    setStageEnteredAt(now);
  }

  return { active: activeStep(stage, now - stageEnteredAt), now };
}

/**
 * The dotted-ring glyph in two states: `spinning` (kortix-green, rotating, with
 * a solid center) and idle (muted, static). Colour and the centre dot CROSSFADE
 * rather than snap, so a pending row waking up is a settle, not a pop. Shared by
 * the checklist's active/pending rows so the in-progress indicator is
 * pixel-identical wherever it appears.
 */
function StepRing({ spinning }: { spinning: boolean }) {
  return (
    <svg
      height="16"
      viewBox="0 0 16 16"
      width="16"
      strokeLinejoin="round"
      className={cn(
        'relative flex shrink-0 items-center justify-center transition-colors duration-300',
        spinning
          ? 'text-kortix-green animate-spinner-spin'
          : 'text-muted-foreground/60',
      )}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="6.3"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.5"
        strokeDasharray="3 3.4"
      />
      <circle
        cx="8"
        cy="8"
        r="4"
        fill="currentColor"
        className={cn('transition-opacity duration-300', spinning ? 'opacity-100' : 'opacity-0')}
      />
    </svg>
  );
}

/**
 * The in-progress step's label. The kortix shimmer marks WHICH row is live —
 * under reduced motion that job falls back to colour alone, since a looping
 * sweep is exactly the kind of ambient movement to drop.
 */
function StepLabelShimmer({ label }: { label: string }) {
  const reduce = useReducedMotion();
  const className = 'text-[13px] leading-none font-medium tracking-tight';

  if (reduce) return <span className={cn(className, 'text-foreground')}>{label}</span>;

  return (
    <TextShimmer as="span" duration={2.2} spread={1.25} className={className}>
      {label}
    </TextShimmer>
  );
}

/**
 * A checklist row's status glyph: the pending/active ring morphing into a green
 * check on completion. This is the single most meaningful moment in the whole
 * loader — a step genuinely finishing — so it gets the design system's icon-swap
 * treatment (scale 0.25 → 1, blur 4px → 0) instead of one icon replacing
 * another mid-frame. Both glyphs share one fixed box so they overlap and the
 * blur can bridge them.
 */
function StepGlyph({ done, current }: { done: boolean; current: boolean }) {
  return (
    <span className="relative flex size-3.5 items-center justify-center">
      <AnimatePresence initial={false} mode="popLayout">
        <m.span
          key={done ? 'done' : 'pending'}
          initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
          animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
          exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
          transition={MORPH}
          className="absolute inset-0 flex items-center justify-center"
        >
          {done ? (
            <CheckCircleSolid className="text-kortix-green size-3.5" weight="fill" />
          ) : (
            <StepRing spinning={current} />
          )}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * The `compact` layout: a spinner, a headline, and a line of supporting copy —
 * nothing else. No rail, no checklist, no footer hint. Progress is carried
 * entirely by the copy, which is why the four steps needed real descriptions
 * rather than the checklist's bare labels.
 *
 * The spinner is deliberately OUTSIDE the AnimatePresence: it is the one
 * constant ("still working"), so it must never restart mid-boot. Only the
 * message swaps, and it swaps as a single block — headline and description
 * belong to one another, so animating them separately would read as two
 * unrelated things changing at once.
 *
 * The swap itself is deliberately plain — see {@link MESSAGE_IN}. This state
 * changes maybe four times in a boot, and the spinner already carries all the
 * liveness the screen needs; anything more elaborate here is decoration
 * competing with the one element whose job is to move.
 */
function BootCompactMessage({
  active,
  /** Overrides the headline while the wake escalation ladder is working (see
   *  `wakeEscalationNote` in `@kortix/sdk`). The DESCRIPTION stays the step's
   *  own — "Starting the runtime and loading your tools" is still exactly what
   *  is happening; only the headline needs to admit it is a second attempt. */
  note,
  /** Rendered inside the TEXT column, beneath the message. Anything the caller
   *  wants aligned to the copy rather than to the spinner belongs here — the
   *  restart offer used to sit outside this block behind a `md:ml-7` offset
   *  that guessed the spinner's width, overran its own container, and lined up
   *  with nothing at all once the row stacked. */
  footer,
}: {
  active: number;
  note?: string | null;
  footer?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const step = STEPS[Math.min(active, STEPS.length - 1)];
  const headline = note ?? step.label;
  return (
    // Row at EVERY width. Stacking the spinner above the copy on small screens
    // bought nothing — a 20px glyph and a 2-line message coexist happily at
    // 256px — and it cost the one relationship that matters here: the spinner
    // reads as belonging to the message it sits beside.
    <div className="flex flex-row items-start gap-2.5">
      {/* mt-1 optically centres the 20px spinner on the headline's 28px line
          box — geometric top-alignment sits it visibly high against a bold cap. */}
      {/* `spokes` to match the reference: beside a headline the ticking wheel
          reads as steady activity, where the orbit arc's sweeping head pulls
          the eye off the words. */}
      <Loading variant="spokes" className="text-muted-foreground mt-1 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        {/* Height is RESERVED, not animated. `mode="wait"` leaves a beat with no
            message mounted, and without a floor the centred block would collapse
            and rebound on every step — the one jump an animated container was
            papering over. 13 = headline line-box (7) + gap (1) + description (5).
            aria-live lives here, on the node that persists, so the swap is
            actually announced; on the message itself it unmounts before it can be. */}
        <div className="min-h-13" aria-live="polite">
          <AnimatePresence initial={false} mode="wait">
            <m.div
              key={headline}
              initial={{ opacity: 0, y: reduce ? 0 : 4 }}
              animate={{ opacity: 1, y: 0, transition: MESSAGE_IN }}
              exit={{ opacity: 0, y: reduce ? 0 : -4, transition: MESSAGE_OUT }}
            >
              <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">
                {headline}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm text-pretty">{step.description}</p>
            </m.div>
          </AnimatePresence>
        </div>
        {footer}
      </div>
    </div>
  );
}

/**
 * The stepped checklist itself. Pure: the caller owns the clock (see
 * {@link useBootProgress}) and passes the active index.
 */
function BootStepList({ active }: { active: number }) {
  const reduce = useReducedMotion();

  return (
    <Stepper
      value={active}
      orientation="vertical"
      count={STEPS.length - 1}
      className="w-auto"
      aria-live="polite"
    >
      {STEPS.map((step, i) => {
        const done = i < active;
        const current = i === active;
        return (
          <m.div
            key={step.label}
            className="flex items-start gap-2.5"
            initial={{ opacity: 0, y: reduce ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            // Staggered first paint so the list assembles instead of slamming in
            // as one block. Decorative only — 40ms apart, nothing waits on it.
            transition={{ delay: i * 0.04, duration: 0.25, ease: [0, 0, 0.2, 1] }}
          >
            <StepperItem
              step={i}
              className="items-center"
              aria-current={current ? 'step' : undefined}
            >
              <StepperIndicator className="flex size-3.5 shrink-0 items-center justify-center rounded-none bg-transparent text-current data-[state=active]:bg-transparent data-[state=completed]:bg-transparent">
                <StepGlyph done={done} current={current} />
              </StepperIndicator>
              <StepperSeparator className="bg-border group-data-[state=completed]/step:bg-kortix-green/40 m-0 my-0.5 group-data-[orientation=vertical]/stepper:min-h-3" />
            </StepperItem>
            <div className="flex h-4 min-w-0 items-center">
              {current ? (
                <StepLabelShimmer label={step.label} />
              ) : (
                <StepperTitle
                  className={cn(
                    'text-[13px] leading-none tracking-tight transition-colors duration-500',
                    // Completed steps stay legible; steps that haven't started
                    // recede. The old flat /50 made "done" and "not yet" look
                    // identical, which is half the reason the list read as inert.
                    done ? 'text-muted-foreground' : 'text-muted-foreground/45',
                  )}
                >
                  {step.label}
                </StepperTitle>
              )}
            </div>
          </m.div>
        );
      })}
    </Stepper>
  );
}

/**
 * The footer hint, crossfaded on the cold-start copy swap. Same blur bridge as
 * everything else — at 15s the sentence changes under the user's eyes, and a
 * hard cut there looks like a glitch rather than an update.
 */
function BootHint({ slow, note }: { slow: boolean; note?: string | null }) {
  // A note means the wake ladder has intervened. "This usually takes a few
  // seconds" is no longer true at that point, and saying it anyway is the
  // dishonesty this whole surface exists to remove.
  const copy =
    note ??
    (slow ? 'A cold start can take a little longer.' : 'This usually takes a few seconds.');
  return (
    <span className="relative flex min-h-4 items-center">
      <AnimatePresence initial={false} mode="popLayout">
        <m.span
          key={copy}
          initial={{ opacity: 0, filter: 'blur(3px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(3px)' }}
          transition={MORPH}
          className="text-muted-foreground text-[11px] leading-relaxed"
        >
          {copy}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * The stalled-boot escape hatch, shown once STUCK_AFTER_MS has passed. Kept in
 * EVERY variant — including `compact`, which is otherwise just the message —
 * because a wedged sandbox raises no server-side signal, so this is the only way
 * out short of a browser refresh. It stays invisible for the first 45 seconds,
 * so it costs the compact layout nothing visually.
 *
 * Exported because the instant session shell needs the SAME offer inline in the
 * thread (the panel that normally carries it is unreachable on desktop during a
 * first boot — see `StalledBootOffer` in instant-session-shell.tsx). One
 * component, so the copy and the treatment cannot drift between the two places
 * a user can be told the boot has stalled.
 *
 * Rises in rather than popping: it appears under a block that has been
 * perfectly still, and a snap there reads as a layout break rather than an offer.
 */
export function RestartFallback({
  show,
  pending,
  onRestart,
  className,
  buttonClassName,
}: {
  show: boolean;
  pending: boolean;
  onRestart: () => void;
  /** Spacing/width override for the wrapper. */
  className?: string;
  /** Width override for the button — see the `w-full` note on it below. */
  buttonClassName?: string;
}) {
  const reduce = useReducedMotion();
  return (
    // `initial={false}`: `show` is false at mount, so the stall entrance still
    // animates when it flips — this only suppresses a replay if the component
    // remounts already-stalled.
    <AnimatePresence initial={false}>
      {show ? (
        <m.div
          initial={{ opacity: 0, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : 4 }}
          transition={{ duration: 0.25, ease: EASE_OUT }}
          // `mt-5` rides here rather than on a wrapper: this element only exists
          // once the boot has stalled, so the space it needs arrives with it
          // instead of holding open a gap for the first 45 seconds.
          className={cn('mt-5 w-full', className)}
        >
          {/* The framing lives in copy, not in the button label. "Taking too
              long? Restart session" made the control read as a question rather
              than an action, and at 256px — the narrowest this block ever gets —
              it wrapped to two lines inside the button. A muted line above says
              why the offer appeared; the button says what it does. */}
          <p className="text-muted-foreground mb-2 text-xs text-pretty">
            This is taking longer than usual.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            // Full width is for the thumb, not for emphasis: this block is
            // capped at 320px, so a full-bleed target is comfortably tappable
            // on a phone while staying visually quiet at `secondary`. A caller
            // whose column is NOT capped (the 768px chat thread) passes
            // `buttonClassName="w-auto"`, where full-bleed would read as a
            // banner rather than an offer.
            className={cn('w-full active:scale-[0.97]', buttonClassName)}
            disabled={pending}
            onClick={onRestart}
          >
            {pending ? (
              <Loading className="size-3.5 shrink-0 text-current" />
            ) : (
              <RotateCcw className="size-3.5 shrink-0" />
            )}
            {pending ? 'Restarting…' : 'Restart session'}
          </Button>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

export function SessionStartingLoader({
  stage = 'provisioning',
  /** Delay before the content fades in. The full-screen resume loader keeps the
   *  default so a warm open never flashes it; the side panel passes 0 because the
   *  user opened it deliberately and expects to see status immediately. */
  delayMs = LOADER_DELAY_MS,
  /** When both are given, a "Restart session" fallback appears once the boot
   *  has clearly stalled (see STUCK_AFTER_MS). Omit either to hide it — some
   *  embeddings of this loader don't have a project session id in scope. */
  projectId,
  sessionId,
  /** Layout. Defaults to `compact` (spinner + headline + description card);
   *  pass `stepper` for the full checklist + progress rail. */
  variant = 'compact',
  /** Honest one-liner from the wake escalation ladder ("Still waking —
   *  retrying the runtime (attempt 2)"), or null on an ordinary first wake.
   *  Built by `wakeEscalationNote` in `@kortix/sdk`; the host never writes it. */
  note,
}: {
  stage?: SessionStartStage;
  delayMs?: number;
  projectId?: string;
  sessionId?: string;
  variant?: BootStepVariant;
  note?: string | null;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [show, setShow] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) {
      setShow(true);
      return;
    }
    const t = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  // The shared boot clock owns the 1s tick + per-stage soft-advance; `now` also
  // drives the footer copy below.
  const { active, now } = useBootProgress(stage);
  // A manual restart pushes the "stuck" clock back out so the button doesn't
  // reappear immediately while the fresh boot is still in progress.
  const clockStart = useRef(now);
  const slow = now - clockStart.current >= SLOW_AFTER_MS;
  const stuck = now - clockStart.current >= STUCK_AFTER_MS;
  const canRestart = !!projectId && !!sessionId;

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, sessionId!),
    onSuccess: () => {
      clockStart.current = Date.now();
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId!, sessionId!) });
      queryClient.invalidateQueries({
        queryKey: qk.project.sessionSandbox(projectId ?? '', sessionId ?? ''),
      });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  // The compact layout is the message and nothing else — no rail, no checklist,
  // no footer hint — so it gets its own composition rather than hiding three
  // quarters of the stepper's.
  if (variant === 'compact') {
    return (
      <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center px-8">
        <div
          className={cn(
            'flex w-full max-w-xs flex-col items-start transition-opacity duration-500',
            show ? 'opacity-100' : 'opacity-0',
          )}
        >
          {/* The restart offer rides in the message's own text column, so it
              aligns with the copy at every width without an offset that has to
              know how wide the spinner is. Its spacing lives on the element that
              animates in, not on a wrapper — for the first 45 seconds there is
              nothing to show, and a wrapper's margin would hold open a gap under
              a message that has no second child. */}
          <BootCompactMessage
            active={active}
            note={note}
            footer={
              <RestartFallback
                show={stuck && canRestart}
                pending={restartMutation.isPending}
                onRestart={() => restartMutation.mutate()}
              />
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center px-8">
      <div
        className={cn(
          // Left-aligned inside a centered fixed-width block: a rail needs a
          // definite length, and a centered heading over a left-aligned list is
          // what made the old layout read as three unrelated floating pieces.
          'flex w-60 flex-col items-start gap-6 transition-opacity duration-500',
          show ? 'opacity-100' : 'opacity-0',
        )}
      >
        {/* Brand dot + heading + rail: one group, because they answer one
            question together ("we're starting, and this is how far"). */}
        <div className="flex w-full flex-col gap-3">
          <div className="flex items-center gap-2">
            <span
              className="bg-kortix-green size-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
              aria-hidden
            />
            <h2 className="text-foreground text-[13px] font-medium tracking-tight">
              {tI18nHardcoded.raw(
                'autoFeaturesSessionSessionStartingLoaderJsxTextKortixComputerIs7c42f59a',
              )}
            </h2>
          </div>
          <Progress
            value={bootProgressPct(active)}
            className="bg-border/70 h-[3px] w-full"
            // Longer + ease-in-out than the primitive's default: this is an
            // on-screen move between two known points, not an enter, so it
            // should accelerate and settle rather than snap.
            indicatorClassName="bg-kortix-green duration-700 ease-in-out"
            aria-label="Session startup progress"
          />
        </div>

        <BootStepList active={active} />

        <div className="flex w-full flex-col items-start gap-4">
          <BootHint slow={slow} note={note} />
          <RestartFallback
            show={stuck && canRestart}
            pending={restartMutation.isPending}
            onRestart={() => restartMutation.mutate()}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The compact boot banner — status ABOVE the conversation instead of a wall in
 * front of it.
 *
 * Opening a hibernated session used to show {@link SessionStartingLoader}
 * full-screen for the whole wake (measured 5-240 s) with the transcript hidden
 * behind it, although every message existed. Now that the control plane serves
 * a durable transcript mirror the conversation is on screen from the first
 * frame, so covering it is no longer honest — the session is READABLE, only its
 * runtime is not yet reachable. `resolveBootPresentation` picks between the two.
 *
 * One strip, one job: which phase the boot is in. It deliberately does NOT
 * repeat what sending will do — the composer's own readiness notice owns that,
 * and two components saying the same thing is how a calm surface turns noisy.
 *
 * `pointer-events-none` on the strip with an explicit re-enable on the restart
 * offer: the transcript underneath must stay scrollable and selectable through
 * it. That is the entire reason this is a banner.
 */
export function SessionConnectingBanner({
  stage = 'provisioning',
  projectId,
  sessionId,
  className,
  /** See {@link SessionStartingLoader}'s `note`. Replaces the phase label,
   *  because "Waking the agent" stops being the whole truth the moment the
   *  ladder has had to intervene. */
  note,
}: {
  stage?: SessionStartStage;
  projectId?: string;
  sessionId?: string;
  className?: string;
  note?: string | null;
}) {
  const queryClient = useQueryClient();
  const { active, now } = useBootProgress(stage);
  const clockStart = useRef(now);
  const stuck = now - clockStart.current >= STUCK_AFTER_MS;
  const canRestart = !!projectId && !!sessionId;
  const step = STEPS[Math.min(active, STEPS.length - 1)];

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, sessionId!),
    onSuccess: () => {
      clockStart.current = Date.now();
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId!, sessionId!) });
      queryClient.invalidateQueries({
        queryKey: qk.project.sessionSandbox(projectId ?? '', sessionId ?? ''),
      });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  return (
    <div
      // `role="status"` + `aria-live`: this appears without the user doing
      // anything and it explains why the composer is holding their message.
      role="status"
      aria-live="polite"
      data-session-connecting-banner=""
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-3',
        className,
      )}
    >
      <div className="bg-background/85 text-muted-foreground flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-xs backdrop-blur-sm">
        <Loading variant="spokes" className="size-3.5 shrink-0 text-current" />
        <span className="truncate">{note ?? step.label}</span>
        {stuck && canRestart ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-events-auto -mr-2 h-6 px-2 text-xs"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate()}
          >
            {restartMutation.isPending ? 'Restarting…' : 'Restart'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
