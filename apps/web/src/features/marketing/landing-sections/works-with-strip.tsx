'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { FULL_COLOR_LOGOS, WORKS_WITH } from './works-with-logos';

type Logo = (typeof WORKS_WITH)[number];

const CELLS = 4;
// Buio's logo roll: every cell turns over on the same beat, 250ms apart, on a
// strong in-out curve (the logo is already on screen, so it moves, not enters).
const ROLL_EVERY_MS = 3500;
const STAGGER_MS = 250;
const ROLL_MS = 700;
const ROLL_EASE = 'cubic-bezier(0.76, 0, 0.24, 1)';

/** Gray at rest; on hover of its cell the name turns ink and the glyph shows
 *  the brand. A brand with a full-colour logo (FULL_COLOR_LOGOS) is that one
 *  SVG in both states: grayscale at rest, full colour on hover, so nothing
 *  swaps and hover-out simply reverses. The rest are a flat glyph that takes
 *  the brand colour (or the theme ink for near-black brands). */
function LogoRow({ logo }: { logo: Logo }) {
  return (
    <span className="text-muted-foreground group-hover/cell:text-foreground duration-moderate flex h-12 items-center justify-center gap-3 transition-colors ease-out">
      {FULL_COLOR_LOGOS.has(logo.slug) ? (
        // eslint-disable-next-line @next/next/no-img-element -- a 28px static SVG; next/image adds nothing here
        <img
          src={`/media/landing/logos/color/${logo.slug}.svg`}
          alt=""
          aria-hidden
          decoding="async"
          className="duration-moderate size-7 shrink-0 object-contain grayscale transition-[filter] ease-out group-hover/cell:grayscale-0"
        />
      ) : (
        <span
          aria-hidden
          className="bg-muted-foreground duration-moderate size-7 shrink-0 transition-colors ease-out group-hover/cell:bg-(--brand)"
          style={{
            ['--brand' as string]: logo.color ?? 'var(--foreground)',
            maskImage: `url(/media/landing/logos/${logo.slug}.svg)`,
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
          }}
        />
      )}
      <span className="text-lg font-medium whitespace-nowrap">{logo.name}</span>
    </span>
  );
}

/**
 * One cell: the current logo, and the next one waiting below it. A roll
 * slides the pair up by one row, then snaps back with the next as current.
 */
function RollCell({
  initial,
  index,
  draw,
  running,
}: {
  initial: Logo;
  index: number;
  draw: (current: Logo) => Logo;
  running: boolean;
}) {
  const current = useRef(initial);
  const [pair, setPair] = useState<[Logo, Logo]>([initial, initial]);
  const [rolling, setRolling] = useState(false);

  useEffect(() => {
    if (!running) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    // Settle on a timer, not transitionend: a background tab skips the
    // transition and would leave the cell half-rolled.
    const roll = () => {
      const next = draw(current.current);
      setPair([current.current, next]);
      setRolling(true);
      later(() => {
        current.current = next;
        setPair([next, next]);
        setRolling(false);
      }, ROLL_MS);
      later(roll, ROLL_EVERY_MS);
    };
    later(roll, ROLL_EVERY_MS + index * STAGGER_MS);
    return () => timers.forEach(clearTimeout);
  }, [running, index, draw]);

  return (
    <li className="group/cell bg-background flex items-center justify-center py-8 lg:py-10">
      <div className="h-12 overflow-hidden">
        <div
          className="flex flex-col"
          style={{
            transform: rolling ? 'translateY(-50%)' : 'none',
            transition: rolling ? `transform ${ROLL_MS}ms ${ROLL_EASE}` : 'none',
          }}
        >
          <LogoRow logo={pair[0]} />
          <span aria-hidden>
            <LogoRow logo={pair[1]} />
          </span>
        </div>
      </div>
      <span className="sr-only">{pair[0].name}</span>
    </li>
  );
}

/**
 * Works-with strip, after Buio's LogoCloud: flush under the hero band (whose
 * foot carries the two-tone line), a bordered row of cells that keep rolling through the models Kortix runs and
 * the apps it connects to (works-with-logos.ts), drawn at random so the row
 * never repeats a logo that is already showing. It rolls only while on screen
 * and holds still under prefers-reduced-motion.
 */
export function WorksWithStrip() {
  const root = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);
  // Logos on screen now, so a draw never shows the same logo twice.
  const showing = useRef(new Set<string>(WORKS_WITH.slice(0, CELLS).map((l) => l.slug)));

  const draw = useCallback((current: Logo): Logo => {
    let next: Logo;
    do {
      next = WORKS_WITH[Math.floor(Math.random() * WORKS_WITH.length)];
    } while (showing.current.has(next.slug));
    showing.current.delete(current.slug);
    showing.current.add(next.slug);
    return next;
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(([entry]) => setRunning(entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={root} id="works-with">
      {/* The visible line sits at the foot of the hero band, right above
          this strip; the strip keeps a heading for assistive tech. */}
      <h2 className="sr-only">Models and apps Kortix works with</h2>
      <div className="kx-rail-fade border-b px-4 lg:px-17">
        <ul className="bg-border grid grid-cols-2 gap-px md:grid-cols-4">
          {WORKS_WITH.slice(0, CELLS).map((logo, i) => (
            <RollCell key={logo.slug} initial={logo} index={i} draw={draw} running={running} />
          ))}
        </ul>
      </div>
    </section>
  );
}
