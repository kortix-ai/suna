'use client';

import {
  CtaSection,
  GridSection,
  HeroSection,
  splitBullet,
} from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { Display, Eyebrow, Lead, Section } from '@/features/marketing/v2/primitives';
import { MoreProduct, type SectionCopy, sectionCopy } from '@/features/marketing/v2/product-kit';

const SECTIONS = PAGES.sandboxes;

const hero = sectionCopy(SECTIONS, 'hero');
const runtime = sectionCopy(SECTIONS, 'runtime');
const spec = sectionCopy(SECTIONS, 'spec');
const cta = sectionCopy(SECTIONS, 'cta');

/**
 * "What is in the box" is a machine spec, not a sequence, so it reads as a
 * definition list — term on the left, what it means on the right.
 */
function SpecSheet({ id, heading, body, bullets = [], eyebrow }: SectionCopy) {
  return (
    <Section id={id} tone="muted">
      <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div>
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <Display lines={heading} />
          {body && <Lead className="mt-6">{body}</Lead>}
        </div>
        <dl>
          {bullets.map((bullet) => {
            const { lede, rest } = splitBullet(bullet);
            return (
              <div
                key={bullet}
                className="border-border grid gap-1 border-t py-5 sm:grid-cols-[7.5rem_1fr] sm:gap-6"
              >
                <dt className="text-foreground text-[0.9375rem] font-medium">{lede}</dt>
                <dd className="text-muted-foreground text-[0.9375rem] leading-[1.6]">{rest}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    </Section>
  );
}

export default function Page() {
  return (
    <main className="bg-background">
      {hero && <HeroSection {...hero} eyebrow="Sandboxes" />}
      {runtime && <GridSection {...runtime} columns={4} />}
      {spec && <SpecSheet {...spec} />}
      <MoreProduct current="/v2/sandboxes" />
      {cta && <CtaSection {...cta} />}
    </main>
  );
}
