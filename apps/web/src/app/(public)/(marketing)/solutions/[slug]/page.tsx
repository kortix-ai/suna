'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import { LogoMarqueeRows } from '@/components/home/logo-marquee';
import { SOLUTION_HERO } from '@/features/marketing/marketing-pages';
import { USE_CASES } from '@/features/marketing/narrative';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HiArrowRight } from 'react-icons/hi2';

export default function SolutionPage() {
  const params = useParams();
  const slug = String(params?.slug ?? '');
  const persona = USE_CASES.personas.find((p) => p.id === slug);
  const hero = SOLUTION_HERO[slug];

  if (!persona || !hero) {
    return (
      <main className="bg-background flex min-h-[60vh] flex-col items-center justify-center gap-4 pt-32 text-center">
        <p className="text-muted-foreground">Solution not found.</p>
        <Button asChild>
          <Link href="/solutions">All solutions</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="bg-background relative pt-32">
      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
            Solutions · {persona.label}
          </p>
          <h1 className="text-foreground mt-4 max-w-3xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            {hero.headline}
          </h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">{hero.sub}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/auth">
                Get started <HiArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href="/enterprise">Talk to sales</Link>
            </Button>
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-16 max-w-6xl px-6 lg:px-0">
        <h2 className="text-foreground mb-8 text-2xl font-medium tracking-tight sm:text-3xl">
          What Kortix owns for {persona.label.toLowerCase()}
        </h2>
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

      <section className="mt-20 overflow-hidden sm:mt-28">
        <p className="text-muted-foreground mb-8 text-center font-mono text-xs tracking-wider uppercase">
          Plugs into the tools {persona.label.toLowerCase()} already use
        </p>
        <Reveal>
          <LogoMarqueeRows />
        </Reveal>
      </section>

      <section className="mx-auto mt-20 max-w-6xl px-6 pb-28 sm:mt-28 lg:px-0">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-5 rounded-sm border p-8 sm:p-12">
            <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
              Give {persona.label.toLowerCase()} their AI coworkers
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              Connect your stack and put Kortix on a real task today. Free to start, yours to own.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/auth">
                  Get started <HiArrowRight className="size-4" />
                </Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="/solutions">All solutions</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
