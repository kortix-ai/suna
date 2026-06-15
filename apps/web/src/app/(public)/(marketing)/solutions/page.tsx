'use client';

import { Reveal } from '@/components/home/reveal';
import { LogoMarqueeRows } from '@/components/home/logo-marquee';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { USE_CASES } from '@/features/marketing/narrative';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { HiArrowRight } from 'react-icons/hi2';

export default function SolutionsHub() {
  return (
    <main className="bg-background relative pt-32">
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <Badge variant="update" className="rounded-full">
            Solutions
          </Badge>
          <h1 className="text-foreground mt-5 max-w-3xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            One workforce. Every team.
          </h1>
          <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
            {USE_CASES.description} Same Kortix, same context, same security — across every
            department. Here’s exactly what it owns for each.
          </p>
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

      {/* Per-team, with the actual workflows shown */}
      <section className="mx-auto mt-20 max-w-6xl space-y-16 px-6 sm:mt-24 lg:px-0">
        {USE_CASES.personas.map((p) => (
          <Reveal key={p.id}>
            <div className="border-border border-t pt-10">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="max-w-2xl">
                  <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
                    {p.label}
                  </h2>
                  <p className="text-muted-foreground mt-2 text-base leading-relaxed">{p.blurb}</p>
                </div>
                <Link
                  href={`/solutions/${p.id}`}
                  className="text-foreground hover:text-muted-foreground group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium"
                >
                  View solution
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
                {p.features.map((f, i) => (
                  <div
                    key={f.title}
                    className="border-border bg-card flex h-full flex-col rounded-sm border p-5"
                  >
                    <KortixAsterisk index={i} variant="solid" />
                    <h3 className="text-foreground mt-3 text-sm font-semibold tracking-tight">
                      {f.title}
                    </h3>
                    <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{f.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        ))}
      </section>

      {/* Tools */}
      <section className="mt-24 overflow-hidden">
        <p className="text-muted-foreground mb-8 text-center font-mono text-xs tracking-wider uppercase">
          Plugs into the tools every team already uses
        </p>
        <Reveal>
          <LogoMarqueeRows />
        </Reveal>
      </section>

      {/* CTA */}
      <section className="mx-auto mt-20 max-w-6xl px-6 pb-28 sm:mt-24 lg:px-0">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-5 rounded-sm border p-8 sm:p-12">
            <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
              Give every team their AI coworkers
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              One platform, every department — connected to your stack, owned by you. Free to start,
              free to self-host.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/auth">
                  Get started <HiArrowRight className="size-4" />
                </Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="/enterprise">Talk to sales</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
