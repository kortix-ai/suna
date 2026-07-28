'use client';

import { SlabMark } from '@/features/marketing/v2/illustrations';
import { CenterHero, PageCta } from '@/features/marketing/v2/page-kit';
import { MAX_W } from '@/features/marketing/v2/primitives';
import { USE_CASES } from '@/features/marketing/v2/use-cases';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function UseCasesPage() {
  return (
    <main className="bg-background">
      <CenterHero
        heading={['Work your company', 'already repeats.']}
        body="Start where the work is predictable and someone is doing it by hand. These are the three places teams usually hand over first."
        cta={false}
      />

      <section className="py-16 sm:py-20">
        <div className={MAX_W}>
          <div className="grid gap-4 lg:grid-cols-3">
            {USE_CASES.map((uc, i) => (
              <Link
                key={uc.slug}
                href={`/v2/use-cases/${uc.slug}`}
                className="group flex flex-col rounded-[1.35rem] p-7 transition-shadow hover:shadow-[0_18px_50px_-18px_rgba(26,31,46,0.25)]"
                style={{
                  background:
                    'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 3%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 12%, var(--background)) 100%)',
                  border: '1px solid color-mix(in oklab, var(--kortix-blue) 11%, transparent)',
                }}
              >
                <SlabMark count={(i % 3) + 1} tone="accent" className="mb-5" />
                <p className="text-foreground text-[1.25rem] font-medium">{uc.name}</p>
                <p className="text-muted-foreground mt-2.5 flex-1 text-[0.9375rem] leading-[1.55]">
                  {uc.teaser}
                </p>
                <span className="text-kortix-blue mt-6 flex items-center gap-1.5 text-[0.9375rem] font-medium">
                  Read more
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <PageCta
        heading={['Pick one and', 'hand it over.']}
        body="Most teams start with the report someone rewrites every week, then never take it back."
      />
    </main>
  );
}
