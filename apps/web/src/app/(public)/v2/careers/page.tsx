'use client';

import { CtaBand, sectionById, sectionsById } from '@/features/marketing/v2/commercial';
import { PageSection } from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { Display, Lead, MAX_W, Pill, Section, SoftCard } from '@/features/marketing/v2/primitives';
import { RealVisual, hasVisual } from '@/features/marketing/v2/real-visual';
import { cn } from '@/lib/utils';
import Link from 'next/link';

/**
 * The one listing and the three ways in are the ones already published on
 * /careers — there is no other role data, and none is invented here.
 */
const OPEN_ROLE = {
  title: 'Craftsman',
  description:
    'You are what you are. You drive what you must. Independent, founder-type person who falls under the above definition or not.',
  location: 'San Francisco — or anywhere, but we’ll get you here.',
};

const REACH = [
  { label: 'marko@kortix.com', href: 'mailto:marko@kortix.com' },
  { label: '@markokraemer', href: 'https://x.com/markokraemer' },
  { label: 'linkedin.com/in/markokraemer', href: 'https://linkedin.com/in/markokraemer' },
];

const CAREERS = PAGES.careers;

/** The kit hero closes on "Get started", which is the wrong door for a candidate. */
function CareersHero() {
  const section = sectionById(CAREERS, 'hero');
  if (!section) return null;

  return (
    <section id={section.id} className="scroll-mt-24 pt-32 sm:pt-40">
      <div className={MAX_W}>
        <div className="grid items-end gap-10 lg:grid-cols-2 lg:gap-16">
          <Display lines={section.heading} as="h1" className="sm:text-[3.5rem]" />
          <div className="lg:pb-2">
            {section.body && <Lead>{section.body}</Lead>}
            <div className="mt-8 flex flex-wrap gap-2">
              <Pill as="a" href="#open-role">
                See the open role
              </Pill>
              <Pill as="a" href="mailto:marko@kortix.com" variant="soft">
                Write to Marko
              </Pill>
            </div>
          </div>
        </div>
      </div>

      {hasVisual(section.visual) && (
        <div className={cn(MAX_W, 'mt-16')}>
          <RealVisual name={section.visual} size="lg" priority />
        </div>
      )}
    </section>
  );
}

function OpenRoleSection() {
  return (
    <Section id="open-role" tone="muted">
      <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div>
          <Display lines="One open position." />
          <Lead className="mt-6">
            We do not keep a long list of roles. If this sounds like you, reach out directly.
          </Lead>
        </div>

        <SoftCard>
          <p className="text-foreground text-[1.25rem] font-medium">{OPEN_ROLE.title}</p>
          <p className="text-muted-foreground mt-3 text-[0.9375rem] leading-[1.6]">
            {OPEN_ROLE.description}
          </p>
          <p className="text-muted-foreground/80 mt-4 text-[0.8125rem]">{OPEN_ROLE.location}</p>

          <div className="border-border/60 mt-7 flex flex-col gap-2 border-t pt-6">
            {REACH.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="text-foreground decoration-foreground/40 hover:decoration-foreground w-fit text-[0.9375rem] font-medium underline underline-offset-4 transition-colors"
              >
                {entry.label}
              </Link>
            ))}
          </div>
        </SoftCard>
      </div>
    </Section>
  );
}

export default function CareersPage() {
  const closing = sectionById(CAREERS, 'cta');

  return (
    <main className="bg-background">
      <CareersHero />

      {sectionsById(CAREERS, 'how-we-work').map((section) => (
        <PageSection key={section.id} section={section} />
      ))}

      <OpenRoleSection />

      {sectionsById(CAREERS, 'team').map((section) => (
        <PageSection key={section.id} section={{ ...section, tone: 'plain' }} />
      ))}

      {closing && (
        <CtaBand id={closing.id} heading={closing.heading} body={closing.body}>
          <Pill as="a" href="mailto:marko@kortix.com">
            Write to Marko
          </Pill>
          <Pill as="a" href="/v2/about" variant="soft">
            Read why we are building this
          </Pill>
        </CtaBand>
      )}
    </main>
  );
}
