'use client';

import { Reveal } from '@/components/home/reveal';
import { GitFork, ShieldCheck, Zap } from 'lucide-react';
import { MOAT } from './narrative';

const ICONS = [
  <ShieldCheck key="shield" className="size-5" aria-hidden />,
  <GitFork key="fork" className="size-5" aria-hidden />,
  <Zap key="zap" className="size-5" aria-hidden />,
];

export function Moat() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-12 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {MOAT.eyebrow}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {MOAT.title}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">{MOAT.description}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {MOAT.reasons.map((reason, i) => (
          <Reveal key={reason.title} delay={i * 0.1}>
            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-7">
              <span className="border-border bg-background text-foreground flex size-11 items-center justify-center rounded-lg border">
                {ICONS[i % ICONS.length]}
              </span>
              <h3 className="text-foreground mt-5 text-xl font-medium tracking-tight">
                {reason.title}
              </h3>
              <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">{reason.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
