'use client';

import { PageSection, type SectionSpec } from '@/features/marketing/v2/page-kit';
import { CheckLine, Display, Lead, Section } from '@/features/marketing/v2/primitives';
import { bySlug } from '@/features/marketing/v2/use-cases';
import { notFound, useParams } from 'next/navigation';

/**
 * Only company-digest has a real artifact to show. The other two produce a
 * comment and an inbox, and there is no honest screenshot of either — so they
 * render no product visual rather than a fabricated one.
 */
const EXAMPLE_OUTPUT: Record<string, string> = {
  'company-digest': '/images/landing-showcase/data.png',
};

function OutcomesSection({ outcomes }: { outcomes: string[] }) {
  return (
    <Section id="outcomes" tone="muted">
      <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div>
          <Display lines="What changes for the team." />
          <Lead className="mt-6">
            What the team stops doing by hand once this one is handed over.
          </Lead>
        </div>
        <div className="self-center">
          {outcomes.map((outcome) => (
            <div key={outcome} className="border-border border-t py-5 last:pb-0">
              <CheckLine>{outcome}</CheckLine>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

export default function UseCaseDetailPage() {
  const params = useParams<{ slug: string }>();
  const useCase = bySlug(params.slug);
  if (!useCase) notFound();

  const example = EXAMPLE_OUTPUT[useCase.slug];

  const opening: SectionSpec[] = [
    {
      id: 'hero',
      kind: 'hero',
      heading: useCase.heading,
      body: useCase.body,
      visual: 'slabs',
    },
    {
      id: 'steps',
      kind: 'list',
      heading: 'How the session runs.',
      body: 'Four steps, the same four every time: what starts it, what it reads, what it does, and where the output lands.',
      bullets: useCase.steps.map((step) => `${step.name} — ${step.description}`),
      visual: 'none',
    },
  ];

  const closing: SectionSpec[] = [
    ...(example
      ? [
          {
            id: 'example',
            kind: 'showcase' as const,
            heading: 'What comes back.',
            body: 'An example output from a session, written for a fictional company.',
            visual: example,
          },
        ]
      : []),
    {
      id: 'cta',
      kind: 'cta',
      heading: 'Hand this one over first.',
      body: 'Install the template, scope its connectors, and read the first change request it opens.',
      visual: 'KortixGrid',
    },
  ];

  return (
    <main className="bg-background">
      {opening.map((section) => (
        <PageSection key={section.id} section={section} />
      ))}

      <OutcomesSection outcomes={useCase.outcomes} />

      {closing.map((section) => (
        <PageSection key={section.id} section={section} />
      ))}
    </main>
  );
}
