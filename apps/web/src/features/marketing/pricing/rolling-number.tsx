import { cn } from '@kortix/ui';

/**
 * A number whose digits roll to their new value (after Number Flow, without
 * the package). Each digit is a 0–9 column in a one-line window; a change
 * moves the column by `transform`, so the digit travels up when it grows and
 * down when it shrinks. One CSS transition per column: a fast drag retargets
 * it mid-flight instead of queueing. The window's top and bottom edges fade,
 * so a digit rolls out softly rather than being cut.
 *
 * Kept quiet on purpose: 260ms ease-out-expo, no bounce, no width animation,
 * and under reduced motion the digits change in place.
 *
 * Slots are keyed from the right, so the ones digit stays the ones digit when
 * the string grows ("7.5K" → "10K"). Non-digits ("$", ",", "K") sit still.
 */
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

// Fades a rolling digit at the window's edges. Mask luminance only: the colour is irrelevant.
const EDGE_FADE = 'linear-gradient(to bottom, transparent, white 20%, white 80%, transparent)';

function Digit({ digit }: { digit: number }) {
  return (
    <span className="inline-block h-lh overflow-hidden" style={{ maskImage: EDGE_FADE }}>
      <span
        className="flex flex-col transition-transform ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateY(-${digit * 10}%)`, transitionDuration: '260ms' }}
      >
        {DIGITS.map((n) => (
          <span key={n} className="h-lh">
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}

export function RollingNumber({ value, className }: { value: string; className?: string }) {
  const chars = [...value];
  return (
    <span className={cn('inline-flex tabular-nums', className)}>
      <span className="sr-only">{value}</span>
      <span aria-hidden className="inline-flex">
        {chars.map((char, i) => {
          const slot = chars.length - i;
          return /\d/.test(char) ? (
            <Digit key={`d${slot}`} digit={Number(char)} />
          ) : (
            <span key={`c${slot}${char}`}>{char}</span>
          );
        })}
      </span>
    </span>
  );
}
