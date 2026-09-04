'use client';

/**
 * The plan — its parts, and the chat's presentation of them.
 *
 * `session-chat.tsx` drops every plan-write part before segmentation, so
 * session todos are drawn ONLY by the two surfaces built here and in
 * `action-panel/easy/plan-card.tsx`. Exactly one of them is live at a time:
 *
 *  - **The Easy panel, on every desktop width.** The plan is session state,
 *    not a turn artifact: one live singleton on one query key. The panel is
 *    where the session's other live singletons already are (Outputs, Context,
 *    Preview), and it does not scroll away mid-run. Collapsing the column or
 *    covering it with a detail panel hides the plan rather than moving it —
 *    deliberately, so it is never in two places across a session.
 *  - **The chat, here, on mobile only.** Under 768px there is no panel COLUMN
 *    at all — the cards are a drawer, shut by default — so the transcript is
 *    the only surface always on screen. `usePlanInChat` (`plan-surface.ts`)
 *    makes the call once; `session-chat.tsx` nulls the anchor on desktop, so
 *    `ownsPlan` is false for every turn and this card never mounts there.
 *
 * The two never render together, and they share their ring (`PlanRing`) and
 * their step list (`PlanSteps`) rather than reimplementing either — so the
 * plan looks the same wherever it is drawn.
 *
 * Data is live — the `todo.updated` SSE event writes into the same query cache
 * `useRuntimeSessionTodo` reads, so the card tracks the agent in real time.
 */

import { useRuntimeSessionTodo } from '@kortix/sdk/react';
import { useId, useMemo, useState } from 'react';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { STATUS_RING, STATUS_RING_PITCH } from '@/components/ui/status-ring';
import {
  parseTodos,
  TodoStatusIcon,
  type TodoItem,
} from '@/features/session/tool/shared/todo-helpers';
import { cn } from '@/lib/utils';

// ============================================================================
// Rail
// ============================================================================

/**
 * One rail for every row in this card.
 *
 * `TodoStatusIcon` and `PlanRing` both take `RAIL_SLOT`, so 18px is the rail
 * width and `gap-2.5` (10px) is its gutter — every text column in the card,
 * trigger included, starts at the same 28px. `leading-[1.375rem]` gives each row
 * an identical 22px line box, so the rows are parallel down the card, not merely
 * aligned.
 *
 * The card was grown here from 12px/16px to 14px/18px. The ratio is deliberate:
 * a 16px glyph beside 12px text is 1.33; 18px beside 14px is 1.29 — near enough
 * that the rail keeps the same weight against the copy at the larger size. A
 * `size-5` (20px) rail would have pushed it to 1.43 and made the glyphs shout.
 */
const RAIL_ROW = 'flex gap-2.5';
/** Sizes the glyph itself — every status glyph is a bare `<svg>` with no
 *  intrinsic dimensions, so this class IS its size. No wrapper box needed. */
const RAIL_SLOT = 'size-4 shrink-0';
const ROW_TEXT = 'text-sm leading-[1.375rem]';
/** (22px line box − 18px glyph) / 2 — centres the glyph on the FIRST line of a
 *  todo that wraps, which `items-start` alone cannot do. */
const GLYPH_ON_FIRST_LINE = 'mt-0.5';

/**
 * The two trigger glyphs share one box and cross-fade between them.
 *
 * `scale 0.25 -> 1` with `blur 4px -> 0` is the house icon-swap curve: the blur
 * is what bridges the two shapes so the eye reads a morph instead of a cut.
 * Both layers are absolutely positioned in the same 18px square, so neither
 * reflows the row as it changes.
 *
 * Named properties, never `transition-all` — `all` would sweep the ring's own
 * `stroke-dashoffset` into this 300ms curve and fight the 500ms sweep.
 */
const GLYPH_LAYER = cn(
  'absolute inset-0 size-full',
  'transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)]',
  'motion-reduce:transition-none',
);
const GLYPH_SHOWN = 'scale-100 opacity-100 blur-none';
const GLYPH_HIDDEN = 'pointer-events-none scale-[0.25] opacity-0 blur-[4px]';

// ============================================================================
// Ring geometry
// ============================================================================

/** SVG attributes are strings; unrounded float arithmetic writes its own noise
 *  into them. Two decimals is finer than a single device pixel at this size. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The dial is the `pending` todo glyph — same 16 viewBox, same r=6.3 centreline,
 * same 1.5 stroke, same 3-on/3.4-off dash — turned into a progress indicator.
 * That is the whole point: the summary ring at the top of the card and the
 * pending dots in the list below are now one drawing at two jobs, so a plan that
 * has not started looks exactly like the steps it has not started.
 *
 * It is reproduced as ONE circle plus a dash pattern rather than as literal
 * arcs, because literal arcs cannot express a partial sweep and this card's
 * whole job is to show one.
 *
 * `pathLength={RING_SEGMENTS}` re-scales the circle's own length to 6, so every
 * dash number below is denominated in SEGMENTS instead of user units. A dash of
 * `0.47` is "just under half a segment pitch" at any radius, which keeps the
 * geometry readable and the arithmetic free of circumference constants.
 */
const RING_CENTER = STATUS_RING.CENTER;
const RING_RADIUS = STATUS_RING.RADIUS;
const RING_STROKE = STATUS_RING.STROKE;
/**
 * Six, because that is what the pending glyph draws. Its dash pattern is set in
 * raw user units (3 on, 3.4 off) against a circumference of 2π·6.3 = 39.58,
 * which is 6.19 pitches — so the real icon's last tick overlaps its first and
 * the ring does not quite close. Rounding to 6 whole segments here widens each
 * tick by 0.09 user units (3.09 vs 3.00 — under a tenth of a pixel at this size,
 * invisible) and buys back a ring that closes exactly and divides cleanly for
 * progress. Same texture, honest arithmetic.
 */
const RING_SEGMENTS = 6;
/**
 * Centreline dash, in segment units — the pending glyph's 3-in-6.4 ratio,
 * re-expressed against a pitch of 1.
 *
 * The stencil is cut with BUTT caps, like the glyph it copies. Round caps here
 * would extend every tick by half the stroke width at each end — 1.5 units on a
 * 3-unit tick, so a 50% fatter tick against a 40% narrower gap. That is not a
 * rounding difference, it is a different drawing: side by side the dial read
 * chunky and the glyph read fine. Butt caps keep them the same object.
 */
const RING_DASH = round(STATUS_RING.DASH / STATUS_RING_PITCH);
const RING_GAP = round(1 - RING_DASH);
/** Half a dash. Shifts the pattern back so a segment is CENTRED on the path's
 *  start rather than beginning there. Both the stencil and the sweep start at
 *  12 o'clock, so this centres a tick on the top of the dial and leaves the
 *  pattern symmetric about the vertical axis. */
const RING_DASH_PHASE = RING_DASH / 2;
/** SVG circles start at 3 o'clock. Progress reads from 12. */
const RING_START_AT_TOP = `rotate(-90 ${RING_CENTER} ${RING_CENTER})`;
/**
 * The pie in the middle of the dial.
 *
 * The ring's ink stops at r=5.55 (centreline 6.3 minus half its 1.5 stroke), so
 * the whole budget inside it is 11.1 units of diameter. The pie takes 7.2 of
 * them and leaves 1.95 of clear air on each side — about 2.2px at the shipping
 * 18px, which is where the tuning bottoms out. Rendered at r=3.9 the air falls
 * to 1.65 (1.9px) and a wide slice visibly reaches for the ring.
 *
 * r=3.6 looked crowded on a first pass, but that was against a faint full-disc
 * pie track that has since been removed — the track, not the radius, was what
 * made the core read as a blob. Below r=3.3 the change stops being worth
 * making: a 60° wedge is a few pixels of ink and stops reading as an angle.
 *
 * It replaced a travelling bead. On the old 2-unit ring a bead worked, but at
 * 1.5 units of stroke it has to be ~2x the track's weight to register at all,
 * and a dot that fat hangs off the arc head as a blob — worst when it lands on
 * a tick, where it reads as a wart. A pie states the same fraction from the
 * middle, where nothing else is competing for the pixels.
 */
const PIE_RADIUS = 3.6;
/**
 * How the slice is drawn: a circle at HALF the pie radius, stroked at the FULL
 * pie radius. The stroke then extends PIE_RADIUS/2 inward and outward from that
 * path, covering 0 → PIE_RADIUS — a solid disc, from one circle.
 *
 * The point of the detour is that it makes the slice animatable. A real sector
 * is a `<path>` of arc commands, and `d` is not a CSS-transitionable property,
 * so the pie would jump between renders. As a stroke it is carved by
 * `stroke-dashoffset`, which transitions — on the same curve and duration as
 * the ring, so the two move as one.
 *
 * Butt caps are what make it a pie rather than a blob: a butt cap on a circular
 * stroke is perpendicular to the path, which at this radius is exactly radial.
 * The slice's two straight edges are true radii.
 */
const PIE_PATH_RADIUS = round(PIE_RADIUS / 2);

/**
 * How far the ring has swept, and which state the plan is in. Pure, so the edge
 * cases — an empty plan, nothing started, everything done — are unit-testable
 * without a browser.
 */
export function planRingState(done: number, total: number, running: boolean) {
  const sweep = total === 0 ? 0 : (done / total) * 360;
  if (total > 0 && done === total) return { sweep, state: 'complete' as const };
  if (running) return { sweep, state: 'running' as const };
  return { sweep, state: 'idle' as const };
}

/** Amber while an item runs, green once the plan is done, neutral before it
 *  starts. The same three tokens `TodoStatusIcon` uses in the list below, so the
 *  summary and the list speak one language. */
const RING_TONE = {
  running: 'text-kortix-orange',
  complete: 'text-kortix-green',
  idle: 'text-muted-foreground',
} as const;

/**
 * Progress as a segmented dial with a pie at its heart.
 *
 * The ring is two layers, both cut to the same notch stencil by one `<mask>`,
 * so the ticks line up exactly instead of being drawn twice and hoped over:
 *
 *  1. the full ring, muted — the track;
 *  2. the swept arc, tinted — how far the plan has got.
 *
 * The pie sits inside it, outside the mask, and states the same fraction as an
 * area instead of an angle. That redundancy is the design, not an oversight:
 * ticks are precise but need counting, a pie is instant but coarse. Together
 * the glyph answers "roughly how far?" at a glance and "exactly how far?" on a
 * second look — at 18px, where a single encoding would have to pick one.
 */
export function PlanRing({
  done,
  total,
  running,
  className,
}: {
  done: number;
  total: number;
  running: boolean;
  className?: string;
}) {
  const { state } = planRingState(done, total, running);
  const fraction = total === 0 ? 0 : done / total;
  // `useId` emits colons, which are legal in an HTML id but hostile inside a
  // `url(#…)` reference — strip them rather than discover it in Safari.
  const maskId = `plan-ring-${useId().replace(/:/g, '')}`;

  return (
    <svg
      viewBox={`0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}`}
      fill="none"
      role="img"
      aria-label={`${done} of ${total} steps done`}
      className={cn(RING_TONE[state], className)}
    >
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width={STATUS_RING.BOX}
        height={STATUS_RING.BOX}
      >
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          pathLength={RING_SEGMENTS}
          stroke="#fff"
          strokeWidth={RING_STROKE}
          strokeLinecap="butt"
          strokeDasharray={`${RING_DASH} ${RING_GAP}`}
          strokeDashoffset={RING_DASH_PHASE}
          transform={RING_START_AT_TOP}
        />
      </mask>

      <g mask={`url(#${maskId})`}>
        {/* Track. Always the full ring, so an untouched plan reads as a dial
            with six steps rather than as an empty hole — and at FULL muted
            strength, not a faded 25%, so a plan that has not started is pixel
            for pixel the `pending` glyph of the steps it has not started. The
            sweep separates from it by hue, which is the stronger cue anyway. */}
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          pathLength={RING_SEGMENTS}
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          className="text-muted-foreground"
        />
        {/* Sweep. `strokeLinecap="butt"` so the arc ends exactly on the
            fraction — the stencil already shapes every visible end, and a cap
            here would over-run into the next tick. */}
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          pathLength={RING_SEGMENTS}
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeLinecap="butt"
          strokeDasharray={RING_SEGMENTS}
          strokeDashoffset={round(RING_SEGMENTS * (1 - fraction))}
          transform={RING_START_AT_TOP}
          className="transition-[stroke-dashoffset] duration-500 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
        />
      </g>

      {/* The pie rides OUTSIDE the mask — it is a solid area, not part of the
          notched ring, and cutting ticks into it would turn it back into a
          second dial. */}
      <g>
        {/* No faint full disc behind the slice. It was drawn and dropped: at
            18px the 15%-opacity track and the tinted wedge blurred into one
            smudge, and at 0/6 it put an unexplained grey dot in the middle of
            what is otherwise, exactly, the `pending` glyph. Nothing done means
            nothing to draw. */}
        {/* The slice. `pathLength={1}` denominates the offset directly in the
            completed fraction — no circumference constant, no rounding drift. */}
        {fraction > 0 && (
          <circle
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={PIE_PATH_RADIUS}
            pathLength={1}
            fill="none"
            stroke="currentColor"
            strokeWidth={PIE_RADIUS}
            strokeLinecap="butt"
            strokeDasharray={1}
            strokeDashoffset={round(1 - fraction)}
            transform={RING_START_AT_TOP}
            className="transition-[stroke-dashoffset] duration-500 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
          />
        )}
      </g>
    </svg>
  );
}

// ============================================================================
// Card
// ============================================================================

/**
 * Whether this session has a plan worth showing.
 *
 * `PlanCard` already returns null for an empty plan, but callers need the same
 * answer BEFORE they lay out — the user message sizes its column differently
 * when a plan sits under it, and `ownsPlan` alone is not that answer: the anchor
 * falls back to the last turn when no turn ever wrote todos, so a session with
 * zero todos still nominates an owner.
 */
export function useHasPlan(sessionId: string): boolean {
  const { data } = useRuntimeSessionTodo(sessionId);
  return parseTodos(data).length > 0;
}

export function planSummary(todos: ReadonlyArray<{ status: string; content: string }>) {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress')?.content;
  const complete = total > 0 && done === total;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    current,
    /** Trigger title: the live step, or a calm complete label — never a shouty
     *  "DONE", and never "complete" while steps remain. Undefined before the
     *  plan starts is deliberate: the dial and the count already say "0 of 4",
     *  and a filler title would add a word without adding information. */
    label: current ?? (complete ? 'Plan complete' : undefined),
    complete,
  };
}

/**
 * The list under the trigger, minus the row the trigger is already showing.
 *
 * The running step is the trigger's whole subject, so leaving it in the list
 * printed it twice — the same sentence stacked on itself, once with a pending
 * dot and once with a spinner. Completed and pending rows stay: they are the
 * history and the road ahead, and the trigger says nothing about them.
 *
 * Filtering AFTER `keyTodos` is deliberate. Keying first means the surviving
 * rows keep the keys they had while the running row was present, so React's
 * state stays attached to a row as the agent advances past it.
 */
export function planListTodos(
  keyed: ReadonlyArray<{ todo: TodoItem; key: string }>,
): Array<{ todo: TodoItem; key: string }> {
  return keyed.filter(({ todo }) => todo.status !== 'in_progress');
}

/**
 * Todos carry no id, so content is the only key available — and an agent
 * repeats a line often enough ("Run the tests" twice) that keying on it alone
 * collides. An occurrence counter disambiguates the repeat, which keeps React's
 * state attached to the row rather than to its position.
 */
export function keyTodos(todos: ReadonlyArray<TodoItem>): Array<{ todo: TodoItem; key: string }> {
  const seen = new Map<string, number>();
  return todos.map((todo) => {
    const n = seen.get(todo.content) ?? 0;
    seen.set(todo.content, n + 1);
    return { todo, key: n === 0 ? todo.content : `${todo.content}#${n}` };
  });
}

export function PlanCard({ sessionId }: { sessionId: string }) {
  const { data } = useRuntimeSessionTodo(sessionId);
  const [open, setOpen] = useState(false);

  const todos = useMemo(() => parseTodos(data), [data]);
  const keyedTodos = useMemo(() => planListTodos(keyTodos(todos)), [todos]);

  if (todos.length === 0) return null;

  const { done, total, current, label, complete } = planSummary(todos);
  // Open + running is the only state where the trigger heads the running step.
  const showSpinner = open && Boolean(current);

  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      className="group/plan w-full select-none"
      variant="outline"
      // bounce 0 — a plan opening is a disclosure, not a toy.
      transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
    >
      <DisclosureTrigger>
        <button
          type="button"
          className={cn(
            'w-full cursor-pointer rounded-md px-3 py-1.5 text-left',
            'bg-transparent',
            'hover:bg-primary/[0.04] transition-colors duration-150 select-none',
            'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
          )}
        >
          {/* A <button>'s content model is phrasing content: every descendant
              here is a <span>, never a <div> or <p>. */}
          <span className={cn(RAIL_ROW, 'w-full items-center')}>
            {/* Closed, the slot answers "how far along is the plan?" — the dial.
                Open, the list below answers that, and the trigger's job narrows
                to heading the one row the list no longer carries: the running
                step. So the glyph becomes its spinner.

                Both layers stay mounted and cross-fade in one fixed box. That is
                what makes it read as one glyph changing rather than two swapping
                — and unlike an AnimatePresence swap it is interruptible, so
                spamming the trigger never leaves a half-faded dial behind. */}
            <span className={cn('relative inline-flex', RAIL_SLOT)}>
              <PlanRing
                done={done}
                total={total}
                running={Boolean(current)}
                className={cn(GLYPH_LAYER, showSpinner ? GLYPH_HIDDEN : GLYPH_SHOWN)}
              />
              {/* Only while something is actually running — a complete plan has
                  no spinner to reveal, and mounting one just to keep it at zero
                  opacity would animate on every open. */}
              {current ? (
                <TodoStatusIcon
                  status="in_progress"
                  className={cn(
                    GLYPH_LAYER,
                    // IMPORTANT, and not decoration. `Loading` ships
                    // `in-[button.bg-transparent]:text-foreground` for spinners
                    // on transparent buttons — which this trigger is — and
                    // twMerge cannot collapse a prefixed utility against an
                    // unprefixed one, so both land and the prefixed rule would
                    // repaint the spinner in the body colour.
                    'text-kortix-orange!',
                    showSpinner ? GLYPH_SHOWN : GLYPH_HIDDEN,
                  )}
                />
              ) : null}
            </span>
            {/* items-baseline: title and the count sit on one baseline, which
                tabular figures then keep from shifting as the count climbs. */}
            <span className={cn('flex min-w-0 flex-1 items-baseline gap-2', ROW_TEXT)}>
              {/* truncate alone — line-clamp-1 sets display:-webkit-box, which
                  cancels text-overflow:ellipsis. shrink-0 on the count so the
                  title is the only flex child that may narrow. Complete labels
                  mute so they read as status, not as a fake live step. */}
              <span className={cn('min-w-0 flex-1 truncate', complete && 'text-muted-foreground')}>
                {label}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {done} of {total}
              </span>
            </span>
          </span>
        </button>
      </DisclosureTrigger>

      <DisclosureContent>
        <PlanSteps rows={keyedTodos} className="px-3 py-2" />
      </DisclosureContent>
    </Disclosure>
  );
}

/**
 * The steps themselves — the one list both surfaces draw.
 *
 * Extracted rather than copied into the panel card: the row rail (`RAIL_ROW`,
 * `RAIL_SLOT`) and the four status treatments below are the plan's whole
 * visual grammar, and two copies of it drift the moment either one is tuned.
 * Callers own only the padding, because a disclosure body and a panel body sit
 * in differently-inset containers.
 *
 * Takes rows already keyed and filtered (`planListTodos(keyTodos(todos))`) —
 * the caller decides what the list is; this decides what it looks like.
 */
export function PlanSteps({
  rows,
  className,
}: {
  rows: ReadonlyArray<{ todo: TodoItem; key: string }>;
  className?: string;
}) {
  return (
    // No stepper rail. Each todo carries its own status glyph, so a connecting
    // separator drew a second, weaker reading of the sequence the list already
    // implies.
    <ul className={cn('flex w-full flex-col gap-2', className)}>
      {rows.map(({ todo, key }) => (
        <li key={key} className={cn(RAIL_ROW, 'items-start')}>
          <TodoStatusIcon status={todo.status} className={cn(RAIL_SLOT, GLYPH_ON_FIRST_LINE)} />
          <p
            className={cn(
              'min-w-0 flex-1 text-pretty',
              ROW_TEXT,
              todo.status === 'completed' && 'text-muted-foreground/60 line-through',
              todo.status === 'cancelled' && 'text-muted-foreground/40 line-through',
              todo.status === 'in_progress' && 'text-foreground font-medium',
              todo.status === 'pending' && 'text-foreground/85',
            )}
          >
            {todo.content}
          </p>
        </li>
      ))}
    </ul>
  );
}
