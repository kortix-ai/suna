import Link from 'next/link';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Section } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';

import { security } from './content';

/**
 * Security: the real controls as a hairline grid, four across from lg. Every
 * line is a sentence from kortix-brand claims.md. No seals: the badge art
 * carries mono capitals and its own colours, which this page does not.
 */
export function SecuritySection() {
  return (
    <Section id="security">
      <SectionHeading
        title={security.title}
        titleMuted={security.titleMuted}
        description={security.description}
        actions={
          <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
            <Link href={security.ctaHref}>{security.ctaLabel}</Link>
          </MarketingButton>
        }
      />
      <dl className="border-border mt-16 grid grid-cols-1 border-t sm:grid-cols-2 lg:grid-cols-4">
        {security.controls.map((control) => (
          <div key={control.id} className="border-border border-b py-8 sm:pr-8">
            <dt className="text-foreground text-base font-medium">{control.title}</dt>
            <dd className="text-muted-foreground mt-2 text-sm text-pretty">
              {control.description}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
