'use client';

import { PLUGS } from '@/features/marketing/v2/content';
import { Heading, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useCallback, useRef } from 'react';

export function PlugsSection() {
  const railRef = useRef<HTMLDivElement>(null);

  const scrollBy = useCallback((direction: 1 | -1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * (rail.clientWidth * 0.75), behavior: 'smooth' });
  }, []);

  return (
    <Section id="audit">
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
        <Heading lines={PLUGS.heading} />
        <p className="text-muted-foreground self-center text-[1.0625rem] leading-relaxed">
          {PLUGS.description}
        </p>
      </div>

      <div
        ref={railRef}
        className="mt-14 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {PLUGS.cards.map((card, i) => (
          <article
            key={card.name}
            className={cn(
              'border-border flex w-[19rem] shrink-0 snap-start flex-col rounded-2xl border sm:w-[22rem]',
              'bg-[linear-gradient(150deg,var(--card-a)_0%,var(--card-b)_100%)]',
            )}
            style={
              {
                '--card-a': 'color-mix(in oklab, var(--kortix-blue) 4%, var(--background))',
                '--card-b': 'color-mix(in oklab, var(--kortix-blue) 11%, var(--background))',
              } as React.CSSProperties
            }
          >
            <div className="h-52 p-5">
              {i === 0 ? <TemplateGrid /> : i === 1 ? <EventTrail /> : <RecentList />}
            </div>
            <div className="border-border/60 border-t p-5">
              <h3 className="text-foreground text-[1.0625rem] font-medium">{card.name}</h3>
              <p className="text-muted-foreground mt-2 text-sm leading-snug">{card.description}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          aria-label="Previous"
          className="border-border bg-card hover:bg-accent flex size-10 cursor-pointer items-center justify-center rounded-full border transition-colors"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => scrollBy(1)}
          aria-label="Next"
          className="border-border bg-card hover:bg-accent flex size-10 cursor-pointer items-center justify-center rounded-full border transition-colors"
        >
          <ArrowRight className="size-4" />
        </button>
      </div>
    </Section>
  );
}

function TemplateGrid() {
  return (
    <div className="grid h-full grid-cols-2 gap-2.5">
      {PLUGS.templates.map((template) => (
        <div
          key={template}
          className="border-border bg-background flex flex-col justify-between rounded-lg border p-3"
        >
          <p className="text-foreground text-[11px] leading-snug">{template}</p>
          <span className="border-border text-muted-foreground mt-2 w-fit rounded border px-2 py-0.5 text-[10px]">
            Use template
          </span>
        </div>
      ))}
    </div>
  );
}

function EventTrail() {
  return (
    <div className="border-border bg-background h-full overflow-hidden rounded-lg border p-3.5">
      <span className="border-border text-muted-foreground rounded border px-2 py-0.5 text-[10px]">
        All events
      </span>
      <ul className="mt-3 space-y-2">
        {PLUGS.events.map((event, i) => (
          <li key={event.name}>
            <div className="flex items-center gap-2">
              <span className="bg-kortix-blue/15 size-3.5 shrink-0 rounded-full" />
              <p className="text-foreground truncate text-[11px]">{event.name}</p>
              {event.meta && (
                <span className="text-muted-foreground shrink-0 text-[10px]">{event.meta}</span>
              )}
            </div>
            {i === 1 && (
              <ul className="text-muted-foreground mt-1 ml-5 space-y-0.5 text-[10px]">
                {PLUGS.contextItems.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const RECENT = [
  'Migrate session tokens to the new scheduler',
  'Q3 enterprise pipeline analysis',
  'Backfill missing firmographics',
  'Update lead-routing workflow',
  'Audit API rate limits across services',
  'Generate the weekly revenue digest',
];

function RecentList() {
  return (
    <div className="border-border bg-background h-full overflow-hidden rounded-lg border p-3.5">
      <p className="text-muted-foreground text-[11px]">Recent</p>
      <ul className="mt-2.5 space-y-2.5">
        {RECENT.map((item, i) => (
          <li key={item} style={{ opacity: 1 - i * 0.13 }}>
            <p className="text-foreground truncate text-[11px]">{item}</p>
            <p className="text-muted-foreground text-[10px]">
              {i + 1} {i === 0 ? 'week' : 'weeks'} ago
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
