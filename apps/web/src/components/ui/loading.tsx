import { cn } from '@/lib/utils';

/**
 * How the spinner is drawn.
 * - `orbit`  — the default: a track with a single arc that orbits and breathes.
 * - `spokes` — the ticking radial spinner. Eight spokes on a fading ramp, the
 *              whole wheel advancing one spoke at a time rather than sweeping
 *              continuously. It holds up better than `orbit` at small sizes and
 *              beside text, because there is no thin arc head to lose track of.
 */
type LoadingVariant = 'orbit' | 'spokes';

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
    'text-foreground in-[button]:text-background in-data-[slot=button]:text-background size-4';

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
