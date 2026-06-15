'use client';

import { Reveal } from '@/components/home/reveal';
import { cn } from '@/lib/utils';
import { PRINCIPLES } from './narrative';

const ACCENTS = ['bg-kortix-green', 'bg-kortix-blue', 'bg-kortix-purple'] as const;

export function Principles() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-12 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {PRINCIPLES.eyebrow}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {PRINCIPLES.title}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">{PRINCIPLES.description}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {PRINCIPLES.cards.map((card, i) => (
          <Reveal key={card.n} delay={i * 0.1}>
            <div className="border-border bg-card group relative flex h-full flex-col overflow-hidden rounded-sm border p-6 transition-colors sm:p-7">
              <span className={cn('absolute inset-x-0 top-0 h-0.5', ACCENTS[i % ACCENTS.length])} />
              <div className="text-muted-foreground/50 font-mono text-sm tracking-widest">
                {card.n}
              </div>
              <h3 className="text-foreground mt-4 text-xl font-medium tracking-tight">
                {card.title}
              </h3>
              <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">{card.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
