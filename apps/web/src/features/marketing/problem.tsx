'use client';

import { cn } from '@/lib/utils';
import { ArrowDown, Check, X } from 'lucide-react';
import { Reveal } from '@/components/home/reveal';
import { PROBLEM } from './narrative';

function FrictionCard() {
  return (
    <div className="border-border bg-card relative overflow-hidden rounded-sm border p-6 sm:p-8">
      <p className="text-muted-foreground mb-5 font-mono text-xs tracking-wider uppercase">
        What most people hit
      </p>

      <div className="space-y-2.5">
        {PROBLEM.friction.map((item) => (
          <div
            key={item}
            className="border-border/60 bg-background/60 flex items-center gap-3 rounded-sm border px-3.5 py-2.5"
          >
            <span className="border-destructive/30 bg-destructive/10 text-destructive flex size-5 shrink-0 items-center justify-center rounded-full border">
              <X className="size-3" />
            </span>
            <span className="text-muted-foreground font-mono text-sm line-through decoration-muted-foreground/40">
              {item}
            </span>
          </div>
        ))}
      </div>

      <div className="my-5 flex items-center justify-center">
        <span className="border-border bg-background text-muted-foreground flex size-7 items-center justify-center rounded-full border">
          <ArrowDown className="size-3.5" />
        </span>
      </div>

      <div className="border-kortix-green/30 bg-kortix-green/5 flex items-center gap-3 rounded-sm border px-3.5 py-3">
        <span className="bg-kortix-green text-background flex size-5 shrink-0 items-center justify-center rounded-full">
          <Check className="size-3" />
        </span>
        <span className="text-foreground text-sm font-medium">{PROBLEM.resolution}</span>
      </div>
    </div>
  );
}

export function Problem() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <Reveal>
        <p className="text-muted-foreground mb-4 font-mono text-xs tracking-wider uppercase">
          {PROBLEM.eyebrow}
        </p>
        <h2 className="text-foreground max-w-4xl text-3xl leading-[1.1] font-medium tracking-tight sm:text-4xl md:text-5xl">
          {PROBLEM.title[0]}
          <br />
          <span className="text-muted-foreground">{PROBLEM.title[1]}</span>
        </h2>
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-10 lg:mt-16 lg:grid-cols-12 lg:gap-12">
        <div className="space-y-6 lg:col-span-7">
          {PROBLEM.paragraphs.map((p, i) => (
            <Reveal key={i} delay={i * 0.08}>
              <p
                className={cn(
                  'leading-relaxed',
                  i === 0
                    ? 'text-foreground text-xl sm:text-2xl'
                    : 'text-muted-foreground text-base sm:text-lg',
                )}
              >
                {p}
              </p>
            </Reveal>
          ))}
        </div>

        <div className="lg:col-span-5">
          <Reveal delay={0.12}>
            <FrictionCard />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
