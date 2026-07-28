'use client';

import { Visual } from '@/features/marketing/v2/marketing-page';
import { PageCta, Showcase, SplitHero } from '@/features/marketing/v2/page-kit';
import { CheckLine, Display, MAX_W } from '@/features/marketing/v2/primitives';
import { bySlug } from '@/features/marketing/v2/use-cases';
import { notFound, useParams } from 'next/navigation';

export default function UseCaseDetailPage() {
  const params = useParams<{ slug: string }>();
  const useCase = bySlug(params.slug);
  if (!useCase) notFound();

  return (
    <main className="bg-background">
      <SplitHero heading={useCase.heading} body={useCase.body}>
        <Showcase height="h-[28rem]">
          <div className="flex h-full items-center justify-center">
            <Visual kind="diff" />
          </div>
        </Showcase>
      </SplitHero>

      <section className="py-20 sm:py-28">
        <div className={MAX_W}>
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
            <Display lines={['How the session', 'actually runs.']} />
            <ol>
              {useCase.steps.map((step, i) => (
                <li key={step.name} className="border-border border-t py-6">
                  <p className="text-foreground flex items-center gap-2.5 text-[1.0625rem] font-medium">
                    <span className="text-muted-foreground/60 font-mono text-xs tabular-nums">
                      0{i + 1}
                    </span>
                    {step.name}
                  </p>
                  <p className="text-muted-foreground mt-2 pl-8 text-[0.9375rem] leading-[1.6]">
                    {step.description}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="bg-muted/40 border-border border-y py-20 sm:py-28">
        <div className={MAX_W}>
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
            <Display lines={['What changes', 'for your team.']} />
            <div className="space-y-5">
              {useCase.outcomes.map((o) => (
                <CheckLine key={o}>{o}</CheckLine>
              ))}
            </div>
          </div>
        </div>
      </section>

      <PageCta
        heading={['Run this one', 'in your company.']}
        body="Install the agent, point it at a project, and review the first change request it opens."
      />
    </main>
  );
}
