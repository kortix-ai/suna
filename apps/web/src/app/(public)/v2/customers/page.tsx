'use client';

import { sectionById, sectionsById } from '@/features/marketing/v2/commercial';
import { PageSection, splitBullet } from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { Display, Lead, MAX_W, SoftCard } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

/**
 * There are no customers to name, so each starting point links to the page that
 * shows the work itself rather than to a story that does not exist.
 */
const WHERE_IT_GOES: Record<string, { href: string; label: string }> = {
  Engineering: { href: '/v2/use-cases/change-review', label: 'See change review' },
  'Go-to-market': { href: '/v2/use-cases/company-digest', label: 'See the company digest' },
  Support: { href: '/v2/use-cases/support-triage', label: 'See support triage' },
  Operations: { href: '/v2/automations', label: 'See automations' },
};

const CUSTOMERS = PAGES.customers;

function ByTeamSection() {
  const section = sectionById(CUSTOMERS, 'by-team');
  if (!section?.bullets) return null;

  return (
    <section id={section.id} className="scroll-mt-24 py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="mx-auto max-w-2xl text-center">
          <Display lines={section.heading} />
          {section.body && <Lead className="mt-6">{section.body}</Lead>}
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {section.bullets.map((bullet) => {
            const { lede, rest } = splitBullet(bullet);
            const team = lede.replace(/[.:]$/, '');
            const link = WHERE_IT_GOES[team];

            return (
              <SoftCard key={bullet} className={cn('p-0', !link && 'p-6')}>
                {link ? (
                  <Link href={link.href} className="group flex flex-1 flex-col p-6">
                    <p className="text-foreground text-[1.125rem] font-medium">{team}</p>
                    {rest && (
                      <p className="text-muted-foreground mt-2 flex-1 text-[0.9375rem] leading-[1.55]">
                        {rest}
                      </p>
                    )}
                    <span className="text-kortix-blue mt-6 flex items-center gap-1.5 text-[0.875rem] font-medium">
                      {link.label}
                      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                ) : (
                  <>
                    <p className="text-foreground text-[1.125rem] font-medium">{team}</p>
                    {rest && (
                      <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">
                        {rest}
                      </p>
                    )}
                  </>
                )}
              </SoftCard>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default function CustomersPage() {
  return (
    <main className="bg-background">
      {sectionsById(CUSTOMERS, 'hero').map((section) => (
        <PageSection key={section.id} section={section} />
      ))}

      <ByTeamSection />

      {sectionsById(CUSTOMERS, 'no-logo-wall', 'cta').map((section) => (
        <PageSection key={section.id} section={section} />
      ))}
    </main>
  );
}
