'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { USE_CASES } from './narrative';

export function UseCases() {
  const [active, setActive] = useState(USE_CASES.personas[0].id);
  const persona = USE_CASES.personas.find((p) => p.id === active) ?? USE_CASES.personas[0];

  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-10 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {USE_CASES.eyebrow}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {USE_CASES.title}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">{USE_CASES.description}</p>
      </div>

      {/* persona tabs */}
      <div className="mb-8 flex flex-wrap gap-2">
        {USE_CASES.personas.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setActive(p.id)}
            className={cn(
              'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
              p.id === active
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-foreground/5',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <p className="text-foreground mb-6 max-w-2xl text-lg leading-relaxed">{persona.blurb}</p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {persona.features.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.06}>
            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6">
              <KortixAsterisk index={i} variant="solid" />
              <h3 className="text-foreground mt-3 text-base font-semibold tracking-tight">
                {f.title}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{f.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
