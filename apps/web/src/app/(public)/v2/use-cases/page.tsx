'use client';

import { CtaSection, HeroSection } from '@/features/marketing/v2/page-kit';
import { Display, Lead, MAX_W, SoftCard } from '@/features/marketing/v2/primitives';
import { USE_CASES } from '@/features/marketing/v2/use-cases';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function UseCasesPage() {
  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Three jobs, handed over end to end."
        body="Not demos. Each one starts on a trigger, runs in its own sandbox, reads your own tools, and finishes as something a person approves."
        visual="slabs"
      />

      <section id="index" className="scroll-mt-24 py-20 sm:py-28">
        <div className={MAX_W}>
          <div className="mx-auto max-w-2xl text-center">
            <Display lines="Pick the one your team repeats most." />
            <Lead className="mt-6">
              Each links to the full walkthrough: the trigger, the context it reads, the work it
              does, and what comes back.
            </Lead>
          </div>

          <div className="mt-14 grid gap-4 lg:grid-cols-3">
            {USE_CASES.map((useCase) => (
              <SoftCard key={useCase.slug} className="p-0">
                <Link
                  href={`/v2/use-cases/${useCase.slug}`}
                  className="group flex flex-1 flex-col p-7"
                >
                  <p className="text-foreground text-[1.25rem] font-medium">{useCase.name}</p>
                  <p className="text-muted-foreground mt-2.5 flex-1 text-[0.9375rem] leading-[1.55]">
                    {useCase.teaser}
                  </p>
                  <span className="text-kortix-blue mt-6 flex items-center gap-1.5 text-[0.9375rem] font-medium">
                    Read the walkthrough
                    <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </SoftCard>
            ))}
          </div>
        </div>
      </section>

      <CtaSection
        id="cta"
        heading="Start with the one that repeats."
        body="Install the template, point it at a project, and read the first change request it opens."
      />
    </main>
  );
}
