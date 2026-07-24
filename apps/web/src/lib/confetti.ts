import confetti from 'canvas-confetti';

/** Kortix accent family (hex approximations of the `--kortix-*` oklch tokens —
 *  canvas-confetti parses hex, not oklch). Celebration reads as the brand's
 *  accent set rather than a generic rainbow. */
const KORTIX_CONFETTI_COLORS = ['#4C8DFF', '#21A366', '#E5B93C', '#E8850C', '#A66DEE'];

/**
 * Fire a short, tasteful confetti burst — the "realistic" multi-layer recipe
 * from canvas-confetti, tinted to the brand. Used on genuine wins: a credit
 * top-up landing or a subscription activating. No-op on the server and for
 * users who prefer reduced motion.
 */
export function fireConfetti() {
  if (typeof window === 'undefined') return;

  const count = 200;
  const defaults = {
    origin: { y: 0.7 },
    colors: KORTIX_CONFETTI_COLORS,
    disableForReducedMotion: true,
    zIndex: 9999,
  } satisfies confetti.Options;

  const fire = (particleRatio: number, opts: confetti.Options) => {
    confetti({ ...defaults, ...opts, particleCount: Math.floor(count * particleRatio) });
  };

  fire(0.25, { spread: 26, startVelocity: 55 });
  fire(0.2, { spread: 60 });
  fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
  fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
  fire(0.1, { spread: 120, startVelocity: 45 });
}
