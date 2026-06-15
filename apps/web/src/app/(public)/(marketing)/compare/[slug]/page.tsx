'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { COMPETITORS } from '@/features/marketing/marketing-pages';
import { cn } from '@/lib/utils';
import { Check, Minus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HiArrowRight } from 'react-icons/hi2';

export default function ComparePage() {
  const params = useParams();
  const slug = String(params?.slug ?? '');
  const c = COMPETITORS.find((x) => x.slug === slug);

  if (!c) {
    return (
      <main className="bg-background flex min-h-[60vh] flex-col items-center justify-center gap-4 pt-32 text-center">
        <p className="text-muted-foreground">Comparison not found.</p>
        <Button asChild>
          <Link href="/compare">All comparisons</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="bg-background relative pt-32">
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Compare</p>
          <h1 className="text-foreground mt-4 max-w-3xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            {c.headline}
          </h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">{c.sub}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/auth">
                Get started <HiArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href="/compare">All comparisons</Link>
            </Button>
          </div>
        </Reveal>
      </section>

      {/* Definitions */}
      <section className="mx-auto mt-16 max-w-6xl px-6 lg:px-0">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Reveal>
            <div className="border-border bg-card h-full rounded-sm border p-6">
              <span className="text-muted-foreground text-sm font-medium">{c.name}</span>
              <p className="text-foreground mt-2 text-base leading-relaxed">{c.theirOneLiner}</p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="border-kortix-green/30 bg-kortix-green/5 h-full rounded-sm border p-6">
              <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <span className="bg-kortix-green size-2 rounded-full" /> Kortix
              </span>
              <p className="text-foreground mt-2 text-base leading-relaxed">{c.kortixOneLiner}</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Table */}
      <section className="mx-auto mt-16 max-w-6xl px-6 lg:px-0">
        <Reveal>
          <div className="border-border overflow-hidden rounded-sm border">
            <div className="border-border bg-muted/30 grid grid-cols-[1.1fr_1fr_1fr] border-b">
              <div className="px-4 py-3 sm:px-6" />
              <div className="text-muted-foreground px-4 py-3 text-xs font-medium sm:px-6 sm:text-sm">
                {c.name}
              </div>
              <div className="border-kortix-green/20 bg-kortix-green/5 text-foreground flex items-center gap-2 border-l px-4 py-3 text-xs font-semibold sm:px-6 sm:text-sm">
                <span className="bg-kortix-green size-2 rounded-full" /> Kortix
              </div>
            </div>
            {c.rows.map((row, i) => (
              <div
                key={row.dimension}
                className={cn(
                  'grid grid-cols-[1.1fr_1fr_1fr]',
                  i !== c.rows.length - 1 && 'border-border border-b',
                )}
              >
                <div className="text-foreground px-4 py-4 text-xs font-medium sm:px-6 sm:text-sm">
                  {row.dimension}
                </div>
                <div className="text-muted-foreground flex items-start gap-2 px-4 py-4 text-xs sm:px-6 sm:text-sm">
                  <Minus className="mt-0.5 size-3.5 shrink-0 opacity-40" />
                  <span>{row.them}</span>
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

      {/* When to choose */}
      <section className="mx-auto mt-16 max-w-6xl px-6 lg:px-0">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Reveal>
            <div className="border-border bg-card h-full rounded-sm border p-6 sm:p-8">
              <h3 className="text-foreground text-lg font-medium tracking-tight">
                Choose {c.name} if…
              </h3>
              <ul className="mt-4 space-y-2.5">
                {c.chooseThem.map((t) => (
                  <li key={t} className="text-muted-foreground flex gap-2.5 text-sm leading-relaxed">
                    <Minus className="mt-0.5 size-3.5 shrink-0 opacity-40" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="border-kortix-green/30 bg-kortix-green/5 h-full rounded-sm border p-6 sm:p-8">
              <h3 className="text-foreground text-lg font-medium tracking-tight">Choose Kortix if…</h3>
              <ul className="mt-4 space-y-2.5">
                {c.chooseUs.map((t) => (
                  <li key={t} className="text-foreground flex gap-2.5 text-sm leading-relaxed">
                    <Check className="text-kortix-green mt-0.5 size-3.5 shrink-0" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto mt-16 max-w-6xl px-6 pb-28 lg:px-0">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-5 rounded-sm border p-8 sm:p-12">
            <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
              See it on your own work
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              Connect your tools and hand Kortix a real task. Free to start, free to self-host.
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
