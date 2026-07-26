'use client';

import { openSource } from '@/features/landing/content';
import { landingIcons } from '@/features/landing/icons';
import { SectionHeader } from '@/features/landing/section-header';
import { HiArrowRight } from 'react-icons/hi2';

/**
 * The differentiator section — where Cowork puts "You decide what Claude can
 * access", we put open source, bring-your-own-models, and self-hosting.
 *
 * Two-column so it reads slower and heavier than the six-cell grid above; this
 * is the argument the page is actually making.
 */
export function LandingOpenSource() {
  return (
    <section className="border-border border-t px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeader
          eyebrow={openSource.eyebrow}
          title={openSource.title}
          intro={openSource.intro}
        />

        <div className="mt-14 grid gap-x-16 gap-y-12 sm:grid-cols-2">
          {openSource.items.map((item) => {
            const Icon = landingIcons[item.icon];
            const external = item.href.startsWith('http');
            return (
              <div key={item.title}>
                <Icon className="text-foreground size-6" />
                <h3 className="text-foreground mt-5 text-lg font-medium tracking-tight">
                  {item.title}
                </h3>
                <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">{item.body}</p>
                <a
                  href={item.href}
                  {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
                  className="text-foreground hover:text-muted-foreground mt-4 inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
                >
                  {item.linkLabel}
                  <HiArrowRight className="size-3.5" />
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
