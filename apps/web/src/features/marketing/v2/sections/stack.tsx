'use client';

import { STACK } from '@/features/marketing/v2/content';
import { Iso, Slab, Stage } from '@/features/marketing/v2/illustrations';
import { Eyebrow, Heading, Lead } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import {
  Boxes,
  Brain,
  Cpu,
  GitBranch,
  Layers,
  Radio,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const LAYERS = STACK.layers;
const SLAB_RISE = 30;

const GLYPHS = [Cpu, Workflow, Boxes, Brain, GitBranch, Radio, ShieldCheck, Layers];

/**
 * The stack: a scroll-pinned section where each layer of Kortix stacks up as a
 * frosted isometric slab while its description takes over the left column.
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
    <section id="stack" className="bg-background scroll-mt-24 px-6 pt-16 sm:pt-24">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <Eyebrow>The stack</Eyebrow>
          <Heading lines={STACK.heading} className="mt-6" />
          <Lead className="mt-5">{STACK.subheading}</Lead>
        </div>

        <div ref={wrapRef} style={{ height: `${(LAYERS.length + 1) * 100}vh` }} className="relative mt-10">
          <div className="sticky top-0 flex h-screen items-center py-8">
            <Stage
              className="grid w-full md:grid-cols-2"
              style={{ minHeight: 'min(44rem, 80vh)' }}
            >
              {/* left: the layer list */}
              <div className="relative z-10 flex flex-col justify-center gap-1.5 p-8 pb-20 sm:p-10 sm:pb-20">
                {LAYERS.map((layer, i) => {
                  const isActive = i === active;
                  return (
                    <div
                      key={layer.name}
                      className={cn(
                        'transition-all duration-300 ease-out',
                        isActive
                          ? 'border-border bg-background rounded-sm border px-5 py-4 shadow-sm'
                          : 'bg-foreground/[0.06] text-muted-foreground w-fit rounded-full px-4 py-1.5',
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
                        <>
                          <p className="text-muted-foreground mt-1.5 max-w-sm text-sm leading-relaxed">
                            {layer.description}
                          </p>
                          {layer.chips && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {layer.chips.map((chip) => (
                                <span
                                  key={chip}
                                  className="border-border bg-card text-muted-foreground rounded-sm border px-2 py-0.5 text-[11px]"
                                >
                                  {chip}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* right: the slabs */}
              <div className="relative hidden md:block">
                <Iso className="absolute inset-0" scale={1.15}>
                  {/* keep the growing stack centred instead of drifting up-frame */}
                  <div
                    className="transition-transform duration-500 ease-out"
                    style={{
                      transformStyle: 'preserve-3d',
                      transform: `translateZ(${-(active * SLAB_RISE) / 2}px)`,
                    }}
                  >
                    {LAYERS.map((layer, i) => {
                      const Glyph = GLYPHS[i % GLYPHS.length];
                      const isTop = i === active;
                      return (
                        <Slab
                          key={layer.name}
                          lift={i * SLAB_RISE}
                          dim={i > active}
                          tone={isTop ? 'accent' : 'frost'}
                          thickness={13}
                          glyph={
                            isTop ? <Glyph className="size-16" strokeWidth={1.25} /> : undefined
                          }
                        />
                      );
                    })}
                  </div>
                </Iso>
              </div>

              {/* footer rail */}
              <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-4 px-8 pb-6 sm:px-10">
                <button
                  type="button"
                  onClick={skip}
                  className="text-muted-foreground hover:text-foreground cursor-pointer text-sm transition-colors"
                >
                  Skip section
                </button>
                <div className="bg-foreground/10 h-1 w-40 overflow-hidden rounded-full">
                  <div
                    className="bg-foreground h-full rounded-full transition-all duration-300"
                    style={{ width: `${((active + 1) / LAYERS.length) * 100}%` }}
                  />
                </div>
                <span className="text-muted-foreground w-12 text-right text-sm tabular-nums">
                  {active + 1}/{LAYERS.length}
                </span>
              </div>
            </Stage>
          </div>
        </div>
      </div>
    </section>
  );
}
