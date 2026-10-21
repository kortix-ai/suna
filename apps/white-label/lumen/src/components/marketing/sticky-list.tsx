'use client';

import { cn } from '@kortix/ui';
import { useEffect, useRef, useState } from 'react';
import type { MockName } from './content';
import { MediaCard } from './parts';

/**
 * The sticky feature list: media pinned on the left, items scroll on the
 * right. The item in the middle of the viewport is ink, the rest are faded,
 * and the media crossfades to it. Media is passed pre-rendered (server
 * components) by name.
 */
export function StickyList({ items, media }: { items: { title: string; body: string; mock: MockName }[]; media: Record<string, React.ReactNode> }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const el of refs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="grid gap-10 md:grid-cols-2 md:gap-6">
      <div className="hidden md:block">
        <div className="sticky top-[calc(50vh-280px)]">
          <MediaCard className="md:aspect-[628/650]">
            <div className="grid">
              {items.map((it, i) => (
                <div
                  key={it.title}
                  className={cn(
                    '[grid-area:1/1] transition-[opacity,filter] duration-500',
                    i === active ? 'opacity-100 blur-0' : 'pointer-events-none opacity-0 blur-sm',
                  )}
                >
                  {media[it.mock]}
                </div>
              ))}
            </div>
          </MediaCard>
        </div>
      </div>
      <div className="md:px-16 lg:px-24">
        {items.map((it, i) => (
          <div
            key={it.title}
            data-i={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="flex flex-col justify-center border-b border-hairline py-12 md:min-h-[350px] md:py-0"
          >
            <div className="mb-8 md:hidden">
              <MediaCard>{media[it.mock]}</MediaCard>
            </div>
            <h3
              className={cn(
                'text-[30px] leading-[1.08] font-[470] tracking-[-0.035em] transition-colors duration-300 md:text-[40px]',
                i === active ? 'text-foreground' : 'md:text-foreground/25',
              )}
            >
              {it.title}
            </h3>
            <p className={cn('mt-4 max-w-md text-[17px] leading-[1.4] text-muted-foreground transition-opacity duration-300', i !== active && 'md:opacity-40')}>
              {it.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
