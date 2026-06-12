'use client';

import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { ForDevelopersPanel } from './for-developers-panel';
import { ForYouPanel } from './for-you-panel';
import { FOR_DEVELOPERS, FOR_YOU, SECTION3 } from './section3-content';

function FlowCue({ label, direction }: { label: string; direction: 'in' | 'out' }) {
  return (
    <span className="text-muted-foreground/70 inline-flex items-center gap-1.5 font-mono text-[11px] tracking-wide">
      {direction === 'out' && <ArrowLeft className="size-3.5" />}
      {label}
      {direction === 'in' && <ArrowRight className="size-3.5" />}
    </span>
  );
}

function HalfHeader({
  eyebrow,
  flow,
  title,
  description,
  direction,
  align,
}: {
  eyebrow: string;
  flow: string;
  title: string;
  description: string;
  direction: 'in' | 'out';
  align: 'start' | 'end';
}) {
  return (
    <div
      className={cn('mb-5 flex flex-col gap-2', align === 'end' && 'lg:items-end lg:text-right')}
    >
      <h3 className="text-foreground text-2xl font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground max-w-xl text-base leading-relaxed">{description}</p>
    </div>
  );
}

export function USP() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-12 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {SECTION3.label}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {SECTION3.title}
        </h2>
        {/* <p className="text-muted-foreground text-base leading-relaxed">{SECTION3.description}</p> */}
      </div>

      <div className="border-border overflow-hidden rounded-sm border">
        <ForYouPanel title={FOR_YOU.title} description={FOR_YOU.description} />

        <ForDevelopersPanel title={FOR_DEVELOPERS.title} description={FOR_DEVELOPERS.description} />
      </div>
    </section>
  );
}
