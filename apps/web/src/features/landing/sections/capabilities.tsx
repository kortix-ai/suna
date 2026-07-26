'use client';

import { capabilities } from '@/features/landing/content';
import { landingIcons } from '@/features/landing/icons';
import { SectionHeader } from '@/features/landing/section-header';
import { cn } from '@/lib/utils';

/**
 * Six-cell capability grid with hairline dividers — the Cowork
 * "Claude Cowork takes on your tasks" section.
 *
 * The dividers are drawn per-cell (left border on non-first columns, top border
 * on non-first rows) so the grid reads as one ruled sheet at every breakpoint
 * instead of a set of boxes.
 */
export function LandingCapabilities() {
  return (
    <section className="px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeader
          eyebrow={capabilities.eyebrow}
          title={capabilities.title}
          intro={capabilities.intro}
        />

        <div className="mt-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.items.map((item, i) => {
            const Icon = landingIcons[item.icon];
            return (
              <div
                key={item.title}
                className={cn(
                  'px-0 py-8 sm:px-7',
                  // First column has no left padding so the text aligns with the heading.
                  i % 2 === 0 && 'sm:pl-0',
                  'lg:pl-7',
                  i % 3 === 0 && 'lg:pl-0',
                  // Hairline rules between cells: every cell draws its own top
                  // and left rule, then the first row / first column suppress
                  // theirs so the grid reads as one ruled sheet.
                  'border-border border-t',
                  i < 2 && 'sm:border-t-0',
                  i < 3 && 'lg:border-t-0',
                  i % 2 !== 0 && 'sm:border-l',
                  i % 3 !== 0 && 'lg:border-l',
                  i % 3 === 0 && 'lg:border-l-0',
                )}
              >
                <Icon className="text-foreground size-6" />
                <h3 className="text-foreground mt-6 text-lg font-medium tracking-tight">
                  {item.title}
                </h3>
                <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">{item.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
