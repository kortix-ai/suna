'use client';

import { Reveal } from '@/components/home/reveal';
import { cn } from '@/lib/utils';
import { Check, Minus } from 'lucide-react';
import { COMPARISON } from './narrative';

export function Comparison() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-12 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {COMPARISON.eyebrow}
        </p>
        <h2 className="text-foreground text-3xl leading-[1.1] font-medium tracking-tight sm:text-4xl">
          {COMPARISON.title[0]}
          <br />
          <span className="text-muted-foreground">{COMPARISON.title[1]}</span>
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">{COMPARISON.description}</p>
      </div>

      <Reveal>
        <div className="border-border overflow-hidden rounded-sm border">
          {/* header */}
          <div className="border-border bg-muted/30 grid grid-cols-[1.1fr_1fr_1fr] border-b">
            <div className="px-4 py-3 sm:px-6" />
            <div className="text-muted-foreground px-4 py-3 text-xs font-medium tracking-wide sm:px-6 sm:text-sm">
              {COMPARISON.otherLabel}
            </div>
            <div className="border-kortix-green/20 bg-kortix-green/5 text-foreground flex items-center gap-2 border-l px-4 py-3 text-xs font-semibold tracking-wide sm:px-6 sm:text-sm">
              <span className="bg-kortix-green size-2 rounded-full" />
              {COMPARISON.kortixLabel}
            </div>
          </div>

          {COMPARISON.rows.map((row, i) => (
            <div
              key={row.job}
              className={cn(
                'grid grid-cols-[1.1fr_1fr_1fr]',
                i !== COMPARISON.rows.length - 1 && 'border-border border-b',
              )}
            >
              <div className="text-foreground px-4 py-4 text-xs font-medium sm:px-6 sm:text-sm">
                {row.job}
              </div>
              <div className="text-muted-foreground flex items-start gap-2 px-4 py-4 text-xs sm:px-6 sm:text-sm">
                <Minus className="mt-0.5 size-3.5 shrink-0 opacity-40" />
                <span>{row.others}</span>
              </div>
              <div className="border-kortix-green/20 bg-kortix-green/5 text-foreground flex items-start gap-2 border-l px-4 py-4 text-xs font-medium sm:px-6 sm:text-sm">
                <Check className="text-kortix-green mt-0.5 size-3.5 shrink-0" />
                <span>{row.kortix}</span>
              </div>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
