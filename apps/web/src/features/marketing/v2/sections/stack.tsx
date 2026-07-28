'use client';

import { STACK } from '@/features/marketing/v2/content';
import { cn } from '@/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

const LAYERS = STACK.layers;
const SLAB_RISE = 34; // px between stacked slabs

/**
 * The stack: a scroll-pinned section where each layer of the platform stacks up
 * as an isometric slab while its description takes over the left column.
 */
export function StackSection() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const scrollable = rect.height - window.innerHeight;
    if (scrollable <= 0) return;
    const progress = Math.min(Math.max(-rect.top / scrollable, 0), 1);
    setActive(Math.min(LAYERS.length - 1, Math.floor(progress * LAYERS.length)));
  }, []);

  useEffect(() => {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [onScroll]);

  const skip = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    window.scrollTo({ top: el.offsetTop + el.offsetHeight - window.innerHeight, behavior: 'smooth' });
  }, []);

  return (
    <section id="stack" className="bg-background scroll-mt-24">
      <div className="mx-auto max-w-6xl px-6">
        <div
          ref={wrapRef}
          style={{ height: `${(LAYERS.length + 1) * 100}vh` }}
          className="relative"
        >
          <div className="sticky top-0 flex h-screen items-center">
            <div
              className="border-border relative grid w-full overflow-hidden rounded-2xl border md:grid-cols-2"
              style={{
                minHeight: 'min(46rem, 82vh)',
                background:
                  'linear-gradient(160deg, color-mix(in oklab, var(--kortix-blue) 7%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 12%, var(--background)) 100%)',
              }}
            >
              {/* left: the layer list */}
              <div className="relative z-10 flex flex-col justify-center gap-2 p-8 sm:p-10">
                {LAYERS.map((layer, i) => {
                  const isActive = i === active;
                  return (
                    <div
                      key={layer.name}
                      className={cn(
                        'transition-all duration-300 ease-out',
                        isActive
                          ? 'bg-foreground text-background rounded-xl px-5 py-4'
                          : 'text-background/85 bg-foreground/55 w-fit rounded-full px-4 py-1.5',
                      )}
                    >
                      <p
                        className={cn(
                          'text-[0.9375rem] font-medium',
                          isActive ? 'text-background' : 'text-background/90',
                        )}
                      >
                        {layer.name}
                      </p>
                      {isActive && (
                        <p className="text-background/70 mt-1.5 max-w-sm text-sm leading-relaxed">
                          {layer.description}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* right: the slabs */}
              <div className="relative hidden items-center justify-center md:flex">
                <Slabs active={active} />
              </div>

              {/* footer rail */}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between px-8 pb-6 sm:px-10">
                <button
                  type="button"
                  onClick={skip}
                  className="text-muted-foreground hover:text-foreground cursor-pointer text-sm transition-colors"
                >
                  Skip section
                </button>
                <div className="bg-foreground/15 h-1.5 w-40 overflow-hidden rounded-full">
                  <div
                    className="bg-foreground/60 h-full rounded-full transition-all duration-300"
                    style={{ width: `${((active + 1) / LAYERS.length) * 100}%` }}
                  />
                </div>
                <span className="text-muted-foreground w-14 text-right text-sm tabular-nums">
                  {active + 1}/{LAYERS.length}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Slabs({ active }: { active: number }) {
  return (
    <div
      className="relative h-72 w-full max-w-md"
      style={{ perspective: '1400px' }}
      aria-hidden
      data-a11y-decorative
    >
      <div
        className="absolute inset-0"
        style={{ transformStyle: 'preserve-3d', transform: 'rotateX(58deg) rotateZ(-45deg)' }}
      >
        {LAYERS.map((layer, i) => {
          const shown = i <= active;
          const depth = i * SLAB_RISE;
          return (
            <div
              key={layer.name}
              className={cn(
                'absolute top-1/2 left-1/2 h-52 w-52 rounded-lg transition-all duration-500 ease-out',
                i === active
                  ? 'border-kortix-blue/40 bg-kortix-blue/25'
                  : 'border-foreground/10 bg-background/70',
              )}
              style={{
                borderWidth: 1,
                marginLeft: '-6.5rem',
                marginTop: '-6.5rem',
                transform: `translateZ(${shown ? depth : depth - 90}px)`,
                opacity: shown ? 1 : 0,
                boxShadow: '0 1px 2px rgba(26,31,46,0.06), 0 8px 10px -1px rgba(26,31,46,0.04)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
