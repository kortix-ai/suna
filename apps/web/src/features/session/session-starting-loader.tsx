'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Progress } from '@/components/ui/progress';
import { ProgressRing } from '@/components/ui/progress-ring';
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
import {
  restartProjectSession,
  sessionStartKey,
  type SessionStartStage,
} from '@kortix/sdk/projects-client';
import { formatDuration } from '@kortix/sdk/turns';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
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
const STUCK_AFTER_MS = 45_000;

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
 * - `inline`  — a single line showing ONLY the current step, led by a
 *               determinate ring instead of a rail (there is no room for one in
 *               a chat thread). Used under the assistant logomark.
 */
type BootStepVariant = 'stepper' | 'compact' | 'inline';

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
 * Overall boot completion, as a percentage, for the rail and the inline ring.
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
 * and exposes `now` for any caller-side elapsed/slow/stuck math. Both the side
 * panel loader and the inline thread checklist consume this, so the two always
 * report the same step.
 */
function useBootProgress(stage: SessionStartStage): { active: number; now: number } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Reset the per-stage clock whenever the backend stage changes, so the
  // soft-advance measures time spent in the CURRENT stage (not since mount).
  const stageEnteredAt = useRef(now);
  const prevStage = useRef(stage);
  if (prevStage.current !== stage) {
    prevStage.current = stage;
    stageEnteredAt.current = now;
  }

  return { active: activeStep(stage, now - stageEnteredAt.current), now };
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
          ? 'text-kortix-green animate-spin motion-reduce:animate-none'
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
 * A step label that swaps in place as the boot advances, blur-bridged so it
 * reads as one line ADVANCING rather than two lines trading places. `popLayout`
 * keeps the outgoing label out of layout flow so the row never reflows
 * mid-swap; `initial={false}` keeps the first paint static.
 */
function AdvancingStepLabel({ label }: { label: string }) {
  const reduce = useReducedMotion();
  return (
    // `layout` is load-bearing, not decoration: the labels differ in length by
    // ~14 characters ("Provisioning your computer" → "Connecting"), and
    // popLayout pulls the outgoing one out of flow — so without it the trailing
    // elapsed timer would snap sideways the instant a step advances. Resizing
    // the container in step with the crossfade keeps the whole row one object.
    <motion.span layout transition={MORPH} className="relative flex h-4 items-center">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={label}
          initial={{ opacity: 0, y: reduce ? 0 : 6, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: reduce ? 0 : -6, filter: 'blur(4px)' }}
          transition={MORPH}
          className="flex items-center whitespace-nowrap"
        >
          <StepLabelShimmer label={label} />
        </motion.span>
      </AnimatePresence>
    </motion.span>
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
        <motion.span
          key={done ? 'done' : 'pending'}
          initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
          animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
          exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
          transition={MORPH}
          className="absolute inset-0 flex items-center justify-center"
        >
          {done ? (
            <CheckCircleSolid
              className="text-kortix-green bg-background size-3.5"
              strokeWidth={2.5}
            />
          ) : (
            <StepRing spinning={current} />
          )}
        </motion.span>
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
function BootCompactMessage({ active }: { active: number }) {
  const reduce = useReducedMotion();
  const step = STEPS[Math.min(active, STEPS.length - 1)];
  return (
    <div className="flex items-start gap-2.5">
      {/* mt-1 optically centres the 20px spinner on the headline's 28px line
          box — geometric top-alignment sits it visibly high against a bold cap. */}
      {/* `spokes` to match the reference: beside a headline the ticking wheel
          reads as steady activity, where the orbit arc's sweeping head pulls
          the eye off the words. */}
      <Loading variant="spokes" className="text-muted-foreground mt-2 size-5 shrink-0" />
      {/* Height is RESERVED, not animated. `mode="wait"` leaves a beat with no
          message mounted, and without a floor the centred block would collapse
          and rebound on every step — the one jump an animated container was
          papering over. 13 = headline line-box (7) + gap (1) + description (5).
          aria-live lives here, on the node that persists, so the swap is
          actually announced; on the message itself it unmounts before it can be. */}
      <div className="min-h-13 min-w-0 flex-1" aria-live="polite">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={step.label}
            initial={{ opacity: 0, y: reduce ? 0 : 4 }}
            animate={{ opacity: 1, y: 0, transition: MESSAGE_IN }}
            exit={{ opacity: 0, y: reduce ? 0 : -4, transition: MESSAGE_OUT }}
          >
            <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">
              {step.label}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm text-pretty">{step.description}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * The stepped checklist itself — one render, shared by the centered panel loader
 * and the inline thread checklist so they can never visually drift. Pure: the
 * caller owns the clock (see {@link useBootProgress}) and passes the active index.
 *
 * `variant` picks the layout (see {@link BootStepVariant}).
 */
function BootStepList({ active, variant }: { active: number; variant: BootStepVariant }) {
  const reduce = useReducedMotion();

  if (variant === 'inline') {
    // Only ever the CURRENT step, led by a determinate ring: in a chat thread
    // there's no room for a rail, but the user still deserves to know how far
    // along the boot is. `active` never exceeds the last index (see activeStep),
    // but clamp defensively so the row is always resolvable.
    const step = STEPS[Math.min(active, STEPS.length - 1)];
    return (
      <div className="flex min-w-0 items-center gap-2">
        <ProgressRing
          className="size-3.5 shrink-0"
          value={bootProgressPct(active)}
          progressClassName="text-kortix-green transition-[stroke-dashoffset] duration-700 ease-in-out"
          trackClassName="text-foreground/10"
        />
        <AdvancingStepLabel label={step.label} />
      </div>
    );
  }

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
          <motion.div
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
              <StepperIndicator className="flex size-3.5 shrink-0 items-center justify-center rounded-none bg-none text-current">
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
          </motion.div>
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
function BootHint({ slow }: { slow: boolean }) {
  const copy = slow
    ? 'A cold start can take a little longer.'
    : 'This usually takes a few seconds.';
  return (
    <span className="relative flex min-h-4 items-center">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={copy}
          initial={{ opacity: 0, filter: 'blur(3px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(3px)' }}
          transition={MORPH}
          className="text-muted-foreground text-[11px] leading-relaxed"
        >
          {copy}
        </motion.span>
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
 * Rises in rather than popping: it appears under a block that has been
 * perfectly still, and a snap there reads as a layout break rather than an offer.
 */
function RestartFallback({
  show,
  pending,
  onRestart,
}: {
  show: boolean;
  pending: boolean;
  onRestart: () => void;
}) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.25, ease: [0, 0, 0.2, 1] }}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            // className="h-7 gap-1.5 rounded-full px-3 text-[11px] transition-transform active:scale-[0.97]"
            disabled={pending}
            onClick={onRestart}
          >
            {pending ? (
              <Loading className="size-3 shrink-0 text-current" />
            ) : (
              <RotateCcw className="h-3 w-3 shrink-0" />
            )}
            {pending ? 'Restarting…' : 'Taking too long? Restart session'}
          </Button>
        </motion.div>
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
  /** Layout. Defaults to the full stepper + progress rail; pass `compact` for
   *  the spinner + headline + description card, or `inline` for the single
   *  advancing line used inside a chat thread. */
  variant = 'compact',
}: {
  stage?: SessionStartStage;
  delayMs?: number;
  projectId?: string;
  sessionId?: string;
  variant?: BootStepVariant;
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
  // drives the footer copy below (and the inline checklist reuses the same hook).
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
        queryKey: ['project', 'session-sandbox', projectId, sessionId],
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
            'flex max-w-sm flex-col items-start gap-5 transition-opacity duration-500',
            show ? 'opacity-100' : 'opacity-0',
          )}
        >
          <BootCompactMessage active={active} />
          <RestartFallback
            show={stuck && canRestart}
            pending={restartMutation.isPending}
            onRestart={() => restartMutation.mutate()}
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

        <BootStepList active={active} variant={variant} />

        <div className="flex w-full flex-col items-start gap-4">
          <BootHint slow={slow} />
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
 * The boot checklist rendered INLINE in the thread (under the assistant
 * logomark) while a freshly-created session's Kortix Computer comes up — the
 * SAME stepped progress as the side panel's {@link SessionStartingLoader}, via
 * the shared {@link BootStepList} + {@link useBootProgress}, so a user who never
 * opens the computer panel still watches the real provisioning state advance
 * instead of one static "Provisioning…" line. Left-aligned to sit under the
 * Kortix logomark; carries its own elapsed timer to match the thread's regular
 * waiting indicator.
 */
export function SessionBootChecklistInline({
  stage = 'provisioning',
  className,
}: {
  stage?: SessionStartStage;
  className?: string;
}) {
  const { active, now } = useBootProgress(stage);
  const startRef = useRef(now);
  const elapsed = formatDuration(now - startRef.current);
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div aria-label="Starting your Kortix Session">
        <BootStepList active={active} variant="inline" />
      </div>
      {elapsed ? (
        <span className="text-muted-foreground text-[13px] tabular-nums">· {elapsed}</span>
      ) : null}
    </div>
  );
}
