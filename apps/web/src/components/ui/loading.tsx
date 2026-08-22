import { STATUS_RING } from '@/components/ui/status-ring';
import { cn } from '@/lib/utils';

/**
 * How the spinner is drawn.
 * - `orbit`  — the default: a track with a single arc that orbits and breathes.
 * - `spokes` — the ticking radial spinner. Eight spokes on a fading ramp, the
 *              whole wheel advancing one spoke at a time rather than sweeping
 *              continuously. It holds up better than `orbit` at small sizes and
 *              beside text, because there is no thin arc head to lose track of.
 * - `ring`   — `orbit`'s motion on the shared status geometry (`STATUS_RING`): the
 *              SAME circle the `pending` status icon draws, so a todo starting
 *              work does not swap to a fatter, larger disc. Reach for it
 *              wherever a spinner sits in a column beside static status glyphs;
 *              `orbit` stays the default everywhere else.
 */
type LoadingVariant = 'orbit' | 'spokes' | 'ring';

/**
 * `spinner-dash` is written against the `orbit` circle: its keyframes step
 * `stroke-dashoffset` through 58 → 14 → 58 against a hard-coded
 * `stroke-dasharray: 62.83`, which is 2πr for orbit's r=10.
 *
 * `pathLength` is what lets a DIFFERENT circle reuse those numbers verbatim.
 * It re-scales a path's own length to the value given, so declaring 62.83 on
 * the r=6.3 ring (real circumference 39.58) makes every dash number in the CSS
 * mean the same FRACTION of the ring it meant on orbit. Same breathing arc,
 * same cadence, a third of the stroke weight — and no second keyframe block to
 * keep in sync.
 */
const RING_PATH_LENGTH = 62.83;

const SPOKE_COUNT = 8;
/** Leading spoke is opaque, each one behind it a step fainter — that ramp IS
 *  the direction cue. A uniform wheel would tick without appearing to turn. */
const SPOKE_FADE_STEP = 0.1;

const Loading = ({
  className,
  variant = 'orbit',
}: {
  className?: string;
  variant?: LoadingVariant;
}) => {
  const base =
    'text-foreground in-[button]:text-background in-data-[slot=button]:text-background in-[button.bg-transparent]:text-foreground in-[[data-slot=button].bg-transparent]:text-foreground in-[button.bg-secondary]:text-foreground! in-[[data-slot=button].bg-secondary]:text-foreground! size-4';

  if (variant === 'ring') {
    return (
      <svg
        className={cn(base, 'animate-spinner-orbit', className)}
        viewBox={`0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Track. Held at the same 25% as `orbit`'s, so the arc reads as the
            lit part of a ring rather than as a lone worm on empty space. */}
        <circle
          className="opacity-25"
          cx={STATUS_RING.CENTER}
          cy={STATUS_RING.CENTER}
          r={STATUS_RING.RADIUS}
          stroke="currentColor"
          strokeWidth={STATUS_RING.STROKE}
          pathLength={RING_PATH_LENGTH}
        />
        <circle
          className="animate-spinner-dash"
          cx={STATUS_RING.CENTER}
          cy={STATUS_RING.CENTER}
          r={STATUS_RING.RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STATUS_RING.STROKE}
          strokeLinecap="round"
          pathLength={RING_PATH_LENGTH}
        />
      </svg>
    );
  }

  if (variant === 'spokes') {
    return (
      <svg
        className={cn(base, 'animate-spinner-spokes', className)}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {Array.from({ length: SPOKE_COUNT }, (_, i) => (
          <line
            key={i}
            x1="12"
            y1="2.5"
            x2="12"
            y2="7.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            opacity={1 - i * SPOKE_FADE_STEP}
            transform={`rotate(${(i * 360) / SPOKE_COUNT} 12 12)`}
          />
        ))}
      </svg>
    );
  }

  return (
    <svg
      className={cn(base, 'animate-spinner-orbit', className)}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <circle
        className="animate-spinner-dash"
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default Loading;
