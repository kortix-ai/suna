'use client';

import Link from '@/components/site-link';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { BeamsBackdrop } from '@/components/ui/paper-wallpaper-shaders';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { EnterpriseRows } from './closing-sections';
import { useOsContent } from './use-os-content';
import { Lattice } from './os-layer';
import { CardArrow, DemoPill, Heading, PillLink, Section } from './primitives';

function Hero() {
  const { aiOsHero } = useOsContent();
  return (
    <section data-kx-dark-hero="" className="dark bg-background text-foreground relative flex min-h-svh items-center justify-center overflow-hidden px-6 pt-32 pb-20">
      <Lattice />
      <div className="relative z-10 flex max-w-3xl flex-col items-center gap-6 text-center">
        <span className="kx-hero-text flex items-center gap-2 text-lg">
          <KortixLogo size={18} />
          <span className="text-muted-foreground">{aiOsHero.mark}</span>
        </span>
        <h1 className="kx-hero-text text-foreground text-4xl font-normal tracking-tight text-balance [--kx-enter:80ms] sm:text-6xl">
          {aiOsHero.title}
        </h1>
        <p className="kx-hero-text text-muted-foreground max-w-xl text-lg text-pretty [--kx-enter:160ms]">
          {aiOsHero.sub}
        </p>
        <div className="kx-hero-text flex flex-wrap justify-center gap-3 [--kx-enter:240ms]">
          <PillLink href={aiOsHero.primary.href}>{aiOsHero.primary.label}</PillLink>
          <DemoPill source="ai-os-hero">{aiOsHero.secondary.label}</DemoPill>
        </div>
      </div>
    </section>
  );
}

/** The stack as a diagram: pick a layer on the right, read it on the left. */
function Layers() {
  const { aiOsLayers } = useOsContent();
  const [active, setActive] = useState<string>(aiOsLayers.layers[0].id);
  const layer = aiOsLayers.layers.find((l) => l.id === active) ?? aiOsLayers.layers[0];

  return (
    <Section className="grid gap-12 lg:grid-cols-2 lg:items-center">
      <div className="space-y-8">
        <Heading>{aiOsLayers.title}</Heading>
        <div key={layer.id} className="max-w-md space-y-3 motion-safe:animate-[kx-fade_300ms_ease-out_both]">
          <h3 className="text-foreground text-2xl font-normal tracking-tight">{layer.title}</h3>
          <p className="text-muted-foreground text-base leading-relaxed text-pretty">{layer.body}</p>
        </div>
      </div>
      <div className="dark bg-background border-border relative overflow-hidden rounded-xl border p-6 sm:p-10">
        <BeamsBackdrop fade="hero" />
        <div role="tablist" aria-orientation="vertical" className="relative flex flex-col gap-2">
          {aiOsLayers.layers.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={l.id === active}
              onClick={() => setActive(l.id)}
              onMouseEnter={() => setActive(l.id)}
              className={cn(
                'border-border h-12 rounded-md border px-4 text-left text-sm backdrop-blur-md transition-colors',
                l.id === active
                  ? 'bg-foreground text-background'
                  : 'bg-background/50 text-foreground hover:bg-background/80',
              )}
            >
              {l.title}
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Products() {
  const { aiOsProducts } = useOsContent();
  return (
    <Section>
      <Heading className="max-w-2xl">{aiOsProducts.title}</Heading>
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {aiOsProducts.cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group dark bg-background text-foreground border-border relative flex aspect-[3/4] flex-col justify-between overflow-hidden rounded-xl border p-8"
          >
            {card.image === 'beams' ? (
              <BeamsBackdrop fade="card" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.image} alt="" aria-hidden className="absolute inset-0 size-full object-cover object-left-top opacity-40" />
            )}
            <span className="relative flex items-center justify-between">
              <span className="flex items-center gap-2 text-xl">
                <KortixLogo size={16} />
                {card.title}
              </span>
              <CardArrow />
            </span>
            <span className="text-foreground relative max-w-56 text-base text-pretty">{card.body}</span>
          </Link>
        ))}
      </div>
    </Section>
  );
}

function Advantages() {
  const { aiOsAdvantages } = useOsContent();
  return (
    <Section>
      <div className="max-w-3xl space-y-4">
        <Heading>{aiOsAdvantages.title}</Heading>
        <p className="text-muted-foreground text-lg text-pretty">{aiOsAdvantages.sub}</p>
      </div>
      <dl className="mt-16 grid md:grid-cols-2 md:gap-x-16">
        {aiOsAdvantages.items.map((item) => (
          <div key={item.title} className="border-border space-y-2 border-t py-8">
            <dt className="text-foreground text-xl font-normal tracking-tight">{item.title}</dt>
            <dd className="text-muted-foreground max-w-md text-base leading-relaxed text-pretty">{item.body}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function AiOsPage() {
  return (
    <div className="bg-background">
      <Hero />
      <Layers />
      <Products />
      <Advantages />
      <EnterpriseRows />
    </div>
  );
}
