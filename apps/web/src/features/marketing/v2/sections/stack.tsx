'use client';

import { STACK } from '@/features/marketing/v2/content';
import { Iso, Slab } from '@/features/marketing/v2/illustrations';
import { cn } from '@/lib/utils';
import { Boxes, Brain, Cpu, GitBranch, Layers, Radio, ShieldCheck, Workflow } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const LAYERS = STACK.layers;
const RISE = 32;
const GLYPHS = [Cpu, Workflow, Boxes, Brain, GitBranch, Radio, ShieldCheck, Layers];

/**
 * The stack: a scroll-pinned panel where each layer of the platform stacks up as
 * a frosted glass slab while its description takes over the left column.
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

  /** Scroll to the slice of the pinned range that owns layer `i`. */
  const goTo = useCallback((i: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const scrollable = el.offsetHeight - window.innerHeight;
    if (scrollable <= 0) return;
    // aim at the middle of the slice so the layer stays put once we land
    const target = el.offsetTop + ((i + 0.5) / LAYERS.length) * scrollable;
    window.scrollTo({ top: target, behavior: 'smooth' });
  }, []);

  const skip = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    window.scrollTo({
      top: el.offsetTop + el.offsetHeight - window.innerHeight,
      behavior: 'smooth',
    });
  }, []);

  return (
    <section id="stack" className="bg-background scroll-mt-24 px-6 py-6">
      <div className="mx-auto w-full max-w-[68rem]">
        <div ref={wrapRef} style={{ height: `${(LAYERS.length + 1) * 100}vh` }} className="relative">
          <div className="sticky top-0 flex h-screen items-center py-6">
            <div
              className="relative grid h-[min(50rem,88vh)] w-full overflow-hidden rounded-[1.75rem] md:grid-cols-[1fr_1.05fr]"
              style={{
                background:
                  'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 7%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 12%, var(--background)) 100%)',
              }}
            >
              {/* left: the layer list */}
              <div className="relative z-10 flex flex-col justify-center gap-2 p-8 sm:p-11">
                {LAYERS.map((layer, i) => {
                  const isActive = i === active;
                  return (
                    <button
                      key={layer.name}
                      type="button"
                      onClick={() => goTo(i)}
                      aria-current={isActive}
                      className={cn(
                        // A fixed radius across both states: a collapsed row is
                        // ~2.2rem tall, so 1.1rem still reads as a pill and the
                        // shape never morphs when the row expands. Only colour
                        // and padding animate — never border-radius.
                        'cursor-pointer rounded-[1.1rem] text-left transition-[background-color,padding] duration-300 ease-out',
                        'focus-visible:ring-foreground/40 outline-none focus-visible:ring-2',
                        isActive
                          ? 'bg-foreground/[0.62] px-5 py-4 backdrop-blur-sm'
                          : 'bg-foreground/[0.55] hover:bg-foreground/[0.68] w-fit px-4 py-[0.4rem]',
                      )}
                    >
                      <p className="text-background text-[0.9375rem] font-medium">{layer.name}</p>
                      {isActive && (
                        <>
                          <p className="text-background/75 mt-1.5 max-w-[24rem] text-[0.875rem] leading-[1.55]">
                            {layer.description}
                          </p>
                          {layer.chips && (
                            <div className="mt-3.5 flex flex-wrap gap-2">
                              {layer.chips.map((chip) => (
                                <span
                                  key={chip}
                                  className="bg-background/20 text-background/90 rounded-md px-2 py-0.5 text-[11px]"
                                >
                                  {chip}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* right: the slabs */}
              <div className="relative hidden md:block">
                <Iso className="absolute inset-0" scale={1.1}>
                  <div
                    className="transition-transform duration-[600ms] ease-out"
                    style={{
                      transformStyle: 'preserve-3d',
                      transform: `translateZ(${-(active * RISE) / 2}px)`,
                    }}
                  >
                    {LAYERS.map((layer, i) => {
                      const Glyph = GLYPHS[i % GLYPHS.length];
                      const isTop = i === active;
                      return (
                        <Slab
                          key={layer.name}
                          lift={i * RISE}
                          hidden={i > active}
                          tone={isTop ? 'accent' : 'frost'}
                          thickness={15}
                          glyph={
                            isTop ? <Glyph className="size-20" strokeWidth={1.15} /> : undefined
                          }
                        />
                      );
                    })}
                  </div>
                </Iso>
              </div>

              {/* footer rail */}
              <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-4 px-8 pb-7 sm:px-11">
                <button
                  type="button"
                  onClick={skip}
                  className="text-muted-foreground hover:text-foreground cursor-pointer text-[0.9375rem] transition-colors"
                >
                  Skip section
                </button>
                <div className="bg-foreground/25 h-[0.6rem] w-52 overflow-hidden rounded-full p-[3px]">
                  <div
                    className="bg-background h-full rounded-full transition-all duration-300"
                    style={{ width: `${((active + 1) / LAYERS.length) * 100}%` }}
                  />
                </div>
                <span className="text-muted-foreground w-12 text-right text-[0.9375rem] tabular-nums">
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
