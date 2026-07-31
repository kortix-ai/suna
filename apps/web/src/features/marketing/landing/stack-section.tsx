'use client';

import type { ReactNode } from 'react';
import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { stack, type StackLayerId } from './content';

type IconKey = keyof typeof Icon;

function LayerLogos({ logos, chips }: { logos?: readonly string[]; chips?: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {logos?.map((key) => {
        const Glyph = Icon[key as IconKey] as ((p: { className?: string }) => ReactNode) | undefined;
        if (!Glyph) return null;
        return (
          <span
            key={key}
            className="border-border bg-background flex size-11 items-center justify-center rounded-sm border"
            title={key}
          >
            <Glyph className="size-5" />
          </span>
        );
      })}
      {chips?.map((chip) => (
        <span
          key={chip}
          className="border-border text-muted-foreground rounded-sm border px-3 py-2.5 font-mono text-[11px]"
        >
          {chip}
        </span>
      ))}
    </div>
  );
}

/**
 * The seven layers, one open at a time. Tembo pins an isometric stack to the
 * scroll; this keeps the useful half — named layers you can step through — and
 * drops the 3D slabs, showing what each layer actually runs on instead.
 */
export function StackSection() {
  const [open, setOpen] = useState<StackLayerId>('models');

  return (
    <section id="stack" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
      <Reveal>
        <div className="max-w-3xl">
          <Badge variant="kortix" className="rounded">
            {stack.eyebrow}
          </Badge>
          <h2 className="text-foreground mt-6 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            {stack.title}
          </h2>
          <p className="text-muted-foreground mt-4 text-base leading-relaxed">{stack.sub}</p>
        </div>
      </Reveal>

      <Reveal delay={0.06}>
        <div className="border-border mt-10 overflow-hidden rounded-sm border">
          {stack.layers.map((layer, i) => {
            const isOpen = layer.id === open;
            const isLast = layer.id === 'kortix';
            return (
              <div key={layer.id} className={cn(i > 0 && 'border-border border-t')}>
                <h3>
                  <button
                    type="button"
                    onClick={() => setOpen(layer.id)}
                    aria-expanded={isOpen}
                    aria-controls={`layer-${layer.id}`}
                    className={cn(
                      'duration-fast flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors sm:px-7',
                      isOpen ? 'bg-card' : 'hover:bg-foreground/[0.03]',
                      isLast && 'font-medium',
                    )}
                  >
                    <span
                      className={cn(
                        'text-base tracking-tight',
                        isOpen ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {layer.name}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        'text-muted-foreground/50 shrink-0 font-mono text-[11px] tabular-nums',
                        isOpen && 'text-foreground/40',
                      )}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  </button>
                </h3>

                {isOpen && (
                  <div
                    id={`layer-${layer.id}`}
                    className="bg-card grid grid-cols-1 gap-6 px-5 pb-6 sm:grid-cols-12 sm:px-7 sm:pb-7"
                  >
                    <p className="text-muted-foreground text-sm leading-relaxed sm:col-span-7">
                      {layer.body}
                    </p>
                    <div className="sm:col-span-5">
                      <LayerLogos logos={layer.logos} chips={layer.chips} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}
