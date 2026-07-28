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
    window.scrollTo({
      top: el.offsetTop + el.offsetHeight - window.innerHeight,
      behavior: 'smooth',
    });
  }, []);

  return (
    <section id="stack" className="bg-background scroll-mt-24 px-6">
      <div className="mx-auto max-w-6xl">
        <div ref={wrapRef} style={{ height: `${(LAYERS.length + 1) * 100}vh` }} className="relative">
          <div className="sticky top-0 flex h-screen items-center py-8">
            <div
              className="border-border bg-card relative grid w-full overflow-hidden rounded-sm border md:grid-cols-2"
              style={{ minHeight: 'min(44rem, 80vh)' }}
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
                          ? 'border-border bg-background rounded-sm border px-5 py-4 shadow-sm'
                          : 'bg-muted text-muted-foreground w-fit rounded-full px-4 py-1.5',
                      )}
                    >
                      <p
                        className={cn(
                          'text-[0.9375rem] font-medium',
                          isActive ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {layer.name}
                      </p>
                      {isActive && (
                        <p className="text-muted-foreground mt-1.5 max-w-sm text-sm leading-relaxed">
                          {layer.description}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* right: the slabs */}
              <div className="bg-muted/40 relative hidden items-center justify-center md:flex">
                <Slabs active={active} />
              </div>

              {/* footer rail */}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-4 px-8 pb-6 sm:px-10">
                <button
                  type="button"
                  onClick={skip}
                  className="text-muted-foreground hover:text-foreground cursor-pointer text-sm transition-colors"
                >
                  Skip section
                </button>
                <div className="bg-border h-1 w-40 overflow-hidden rounded-full">
                  <div
                    className="bg-foreground h-full rounded-full transition-all duration-300"
                    style={{ width: `${((active + 1) / LAYERS.length) * 100}%` }}
                  />
                </div>
                <span className="text-muted-foreground w-12 text-right text-sm tabular-nums">
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
          return (
            <div
              key={layer.name}
              className={cn(
                'absolute top-1/2 left-1/2 h-52 w-52 rounded-sm border transition-all duration-500 ease-out',
                i === active
                  ? 'border-kortix-blue/50 bg-kortix-blue/20'
                  : 'border-border bg-card',
              )}
              style={{
                marginLeft: '-6.5rem',
                marginTop: '-6.5rem',
                transform: `translateZ(${shown ? i * SLAB_RISE : i * SLAB_RISE - 90}px)`,
                opacity: shown ? 1 : 0,
                boxShadow: '0px 1px 2px rgba(26,31,46,0.04), 0px 8px 10px -1px rgba(26,31,46,0.04)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
