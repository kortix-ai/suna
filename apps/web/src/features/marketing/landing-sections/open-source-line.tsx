import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Section } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';

import { openSourceLine } from './content';

/**
 * Open source, as one quiet row between two hairlines: the star count, what
 * open means, and the way to the code. It takes no section padding of its
 * own and sits in the gap between Security and the FAQ. No chart and no live
 * counter: the static "20,000+" is the one sanctioned figure.
 *
 * The two-tone line is SectionHeading at its quieter `small` rung (Buio's
 * logo-cloud line).
 */
export function OpenSourceLine() {
  return (
    <Section id="open-source" className="py-0 md:py-0">
      <div className="border-border flex flex-col gap-8 border-y py-12 md:flex-row md:items-center md:justify-between">
        <SectionHeading
          size="small"
          title={<span className="tabular-nums">{openSourceLine.title}</span>}
          titleMuted={openSourceLine.titleMuted}
        />
        <MarketingButton
          size="md"
          variant="secondary"
          asChild
          className="hit-area-y-1 self-start md:self-auto"
        >
          <a href={openSourceLine.ctaHref} target="_blank" rel="noopener noreferrer">
            {openSourceLine.ctaLabel}
          </a>
        </MarketingButton>
      </div>
    </Section>
  );
}
