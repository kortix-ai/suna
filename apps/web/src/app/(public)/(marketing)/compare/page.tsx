'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { COMPETITORS } from '@/features/marketing/marketing-pages';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function CompareHub() {
  return (
    <main className="bg-background relative pt-32">
      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <Badge variant="update" className="rounded-full">
            Compare
          </Badge>
          <h1 className="text-foreground mt-5 max-w-3xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            How Kortix compares
          </h1>
          <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
            You’re already using AI. The question is whether it does the work, whether your whole
            team levels up, and whether you own it. Here’s how Kortix stacks up — honestly.
          </p>
        </Reveal>
      </section>

      <section className="mx-auto mt-16 max-w-6xl px-6 pb-28 lg:px-0">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {COMPETITORS.map((c, i) => (
            <Reveal key={c.slug} delay={i * 0.06}>
              <Link
                href={`/compare/${c.slug}`}
                className="border-border bg-card hover:border-foreground/20 group flex h-full flex-col rounded-sm border p-6 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="text-foreground text-lg font-medium tracking-tight">
                    Kortix vs {c.name}
                  </span>
                  <ArrowRight className="text-muted-foreground group-hover:text-foreground size-4 transition-colors" />
                </div>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{c.sub}</p>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>
    </main>
  );
}
