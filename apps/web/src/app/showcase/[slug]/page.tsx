import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ComponentType } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  AuroraMark,
  Currents,
  KortixCurrents,
  Liquid,
  MagneticField,
} from '@/features/mark-effects';

import { getEffect, SHOWCASE_EFFECTS, type ShowcaseEffect } from '../effects';
import { ParticleLogo } from '../particle-logo';

// The one place client/canvas/WebGL components are wired to their slug. Add a
// registry entry in ../effects.ts and its component here — nothing else changes.
const EFFECT_COMPONENTS: Record<string, ComponentType> = {
  'particle-assembly': ParticleLogo,
  'magnetic-field': MagneticField,
  'aurora-mark': AuroraMark,
  currents: Currents,
  'kortix-currents': KortixCurrents,
  liquid: Liquid,
};

const ENTER_STYLE = `
  @media (prefers-reduced-motion: no-preference) {
    .showcase-enter { opacity: 0; transform: translateY(10px); animation: showcase-enter 0.5s cubic-bezier(0.23,1,0.32,1) forwards; }
    @keyframes showcase-enter { to { opacity: 1; transform: translateY(0); } }
  }
`;

export function generateStaticParams() {
  return SHOWCASE_EFFECTS.map((effect) => ({ slug: effect.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const effect = getEffect(slug);
  if (!effect) return { title: 'Showcase — Kortix', robots: { index: false, follow: false } };
  return {
    title: `${effect.name} — Kortix`,
    description: effect.description,
    robots: { index: false, follow: false },
  };
}

export default async function ShowcaseEffectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const effect = getEffect(slug);
  const Component = effect ? EFFECT_COMPONENTS[effect.slug] : undefined;
  if (!effect || !Component) notFound();

  return effect.layout === 'fullscreen' ? (
    <FullscreenStage effect={effect} Component={Component} />
  ) : (
    <FramedStage effect={effect} Component={Component} />
  );
}

function BackLink({ className }: { className?: string }) {
  return (
    <Link
      href="/showcase"
      className={`text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm font-medium transition-colors ${className ?? ''}`}
    >
      <ArrowLeft className="size-3.5" />
      Showcase
    </Link>
  );
}

function FullscreenStage({
  effect,
  Component,
}: {
  effect: ShowcaseEffect;
  Component: ComponentType;
}) {
  return (
    <main className="bg-background relative h-screen w-screen overflow-hidden antialiased">
      <Component />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-5">
        <BackLink className="bg-background/70 pointer-events-auto rounded-full px-3 py-1.5 ring-1 ring-black/10 backdrop-blur dark:ring-white/10" />
        <div className="text-right">
          <p className="text-foreground text-sm font-medium">{effect.name}</p>
          <p className="text-muted-foreground text-xs">{effect.hint}</p>
        </div>
      </div>
    </main>
  );
}

function FramedStage({ effect, Component }: { effect: ShowcaseEffect; Component: ComponentType }) {
  return (
    <main className="bg-background min-h-screen px-6 py-16 antialiased sm:py-24">
      <style dangerouslySetInnerHTML={{ __html: ENTER_STYLE }} />
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        <div className="showcase-enter flex flex-col gap-4">
          <BackLink />
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-foreground text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                {effect.name}
              </h1>
              <Badge variant="outline" size="sm" className="text-muted-foreground">
                {effect.tech}
              </Badge>
            </div>
            <p className="text-muted-foreground text-pretty text-base">{effect.description}</p>
          </header>
        </div>

        <section className="showcase-enter flex flex-col gap-4" style={{ animationDelay: '80ms' }}>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-foreground text-sm font-medium tracking-tight">Live</h2>
            <p className="text-muted-foreground text-sm">{effect.hint}</p>
          </div>
          <Component />
        </section>
      </div>
    </main>
  );
}
