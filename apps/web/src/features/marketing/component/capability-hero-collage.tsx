'use client';

import { MAX_PIXEL_COUNT } from '@/components/ui/paper-wallpaper-shaders';
import { ShaderSafe } from '@/components/ui/shader-safe';
import { cn } from '@/lib/utils';
import { MeshGradient } from '@paper-design/shaders-react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  CAPABILITY_ARTIFACTS,
  CAPABILITY_ARTIFACT_ICONS,
  DEFAULT_VISUALS,
  type CapabilityHeroSpec,
  type CapabilityHeroVisual,
} from './capability-hero-artifacts';

export type { CapabilityHeroSpec, CapabilityHeroVisual };

/** The blessed ease-out — enter and exit both live here. */
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** Exit runs at ~75% of the enter, per the motion doctrine. */
const ENTER_S = 0.34;
const EXIT_S = 0.26;

/**
 * How long a card holds before the next replaces it.
 *
 * Deliberately slow. Each artifact plays once and then rests, so this swap is
 * the only recurring motion on the page — a shorter dwell would turn a calm
 * sequence back into a flicker.
 */
const DWELL_MS = 5200;

function SpecCard({
  spec,
  position,
  total,
  reduceMotion,
}: {
  spec: CapabilityHeroSpec;
  position: number;
  total: number;
  reduceMotion: boolean;
}): ReactNode {
  const visual = spec.visual ?? DEFAULT_VISUALS[position] ?? 'signal';
  const Artifact = CAPABILITY_ARTIFACTS[visual];
  const Icon = CAPABILITY_ARTIFACT_ICONS[visual];

  return (
    <m.article
      // Reduced motion keeps the crossfade — it explains that content replaced
      // content — and drops only the movement.
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: EXIT_S, ease: EASE_OUT } }
          : { opacity: 0, y: -14, transition: { duration: EXIT_S, ease: EASE_OUT } }
      }
      transition={{ duration: ENTER_S, ease: EASE_OUT }}
      className="border-border/70 bg-card/85 absolute inset-0 flex flex-col overflow-hidden rounded-md border shadow-lg backdrop-blur-xl"
    >
      <header className="border-border/60 flex items-center justify-between gap-3 border-b px-6 py-3.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="text-muted-foreground truncate font-mono text-[11px] tracking-widest uppercase">
            {spec.k}
          </span>
        </span>
        <span className="text-muted-foreground/50 font-mono text-[11px] tabular-nums">
          {String(position + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </span>
      </header>

      {/* Statement left, instrument right. The seam between them is what stops
          the middle reading as dead space at this width. */}
      <div className="grid flex-1 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex min-w-0 items-center px-6 py-5">
          <p className="text-foreground text-xl leading-tight font-medium tracking-tight text-balance sm:text-2xl">
            {spec.v}
          </p>
        </div>

        <div
          className="border-border/60 flex min-w-0 items-center border-t px-6 py-5 sm:border-t-0 sm:border-l"
          aria-hidden
        >
          <Artifact spec={spec} reduceMotion={reduceMotion} />
        </div>
      </div>
    </m.article>
  );
}

export function CapabilityHeroCollage({
  specs,
}: {
  specs: readonly CapabilityHeroSpec[];
}): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;
  const total = specs.length;
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || total < 2) return;
    const id = setInterval(() => setActive((n) => (n + 1) % total), DWELL_MS);
    return () => clearInterval(id);
    // `active` is a dep so a manual pick restarts the dwell instead of
    // advancing early.
  }, [paused, total, active]);

  const advance = useCallback(() => setActive((n) => (n + 1) % total), [total]);

  if (total === 0) return null;

  const spec = specs[active] ?? specs[0];
  if (!spec) return null;

  return (
    <div
      className="relative isolate flex w-full flex-col items-center justify-center lg:h-full lg:min-h-[34rem]"
      role="group"
      aria-label="Capability highlights"
    >
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden>
        <ShaderSafe>
          <MeshGradient
            className="absolute inset-0 size-full"
            colors={['#ffffff', '#000000']}
            distortion={1}
            grainMixer={0.12}
            grainOverlay={0.08}
            maxPixelCount={MAX_PIXEL_COUNT}
            rotation={90}
            speed={reduceMotion ? 0 : 0.7}
            swirl={0.2}
          />
        </ShaderSafe>
      </div>

      <div
        className="relative z-10 w-full"
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
      >
        <div
          className="relative h-[15rem] cursor-pointer sm:h-[14rem]"
          onClick={advance}
          aria-hidden
        >
          <AnimatePresence initial={false}>
            <SpecCard
              key={active}
              spec={spec}
              position={active}
              total={total}
              reduceMotion={reduceMotion}
            />
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-center">
          {specs.map((entry, i) => (
            <button
              key={entry.k}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Show ${entry.k}`}
              aria-current={i === active}
              className="group/dot flex h-10 w-10 items-center justify-center"
            >
              <span
                className={cn(
                  'h-0.5 w-6 rounded-full transition-colors duration-200 ease-out',
                  i === active
                    ? 'bg-foreground'
                    : 'bg-border group-hover/dot:bg-muted-foreground/60',
                )}
              />
            </button>
          ))}
        </div>
      </div>

      {/* The full set stays readable to assistive tech no matter which card is
          on screen. */}
      <ul className="sr-only">
        {specs.map((entry) => (
          <li key={entry.k}>
            {entry.k}: {entry.v}
          </li>
        ))}
      </ul>
    </div>
  );
}
