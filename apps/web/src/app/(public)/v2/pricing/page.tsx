'use client';

import { CtaBand, sectionById, sectionsById } from '@/features/marketing/v2/commercial';
import { PageSection } from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { CheckLine, Display, Lead, Pill, Section } from '@/features/marketing/v2/primitives';

/**
 * The rates below are the ones stated in the compute copy, lifted out of the
 * paragraph so a buyer can scan them. Nothing here is a new number.
 */
const METER = [
  { resource: 'vCPU', rate: '$0.0000168', unit: 'per vCPU, per second' },
  { resource: 'Memory', rate: '$0.0000054', unit: 'per GiB of RAM, per second' },
  { resource: 'Storage', rate: '$0.000000036', unit: 'per GiB of storage, per second' },
];

const PRICING = PAGES.pricing;

function ComputeSection() {
  const section = sectionById(PRICING, 'compute');
  if (!section) return null;

  return (
    <Section id="compute" tone="muted">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <Display lines={section.heading} />
          {section.body && <Lead className="mt-6">{section.body}</Lead>}
        </div>

        <div>
          <div className="border-border overflow-hidden rounded-[1.1rem] border">
            <p className="text-muted-foreground border-border bg-muted/40 border-b px-5 py-3 text-[13px] tracking-wider uppercase">
              Metered per second
            </p>
            <dl>
              {METER.map((row) => (
                <div
                  key={row.resource}
                  className="border-border flex items-baseline justify-between gap-4 border-b px-5 py-4 last:border-b-0"
                >
                  <dt className="text-foreground text-[0.9375rem] font-medium">{row.resource}</dt>
                  <dd className="text-right">
                    <span className="text-foreground font-mono text-[0.9375rem] tabular-nums">
                      {row.rate}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-[0.8125rem]">
                      {row.unit}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {section.bullets && (
            <div className="mt-8 space-y-4">
              {section.bullets.map((bullet) => (
                <CheckLine key={bullet}>{bullet}</CheckLine>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

export default function PricingPage() {
  const closing = sectionById(PRICING, 'cta');

  return (
    <main className="bg-background">
      {sectionsById(PRICING, 'hero', 'plans').map((section) => (
        <PageSection key={section.id} section={section} />
      ))}

      <ComputeSection />

      {sectionsById(PRICING, 'faq').map((section) => (
        <PageSection key={section.id} section={section} />
      ))}

      {closing && (
        <CtaBand id={closing.id} heading={closing.heading} body={closing.body}>
          <Pill as="a" href="/auth">
            Get started
          </Pill>
          <Pill as="a" href="/v2/enterprise" variant="soft">
            Talk to us about Enterprise
          </Pill>
        </CtaBand>
      )}
    </main>
  );
}
