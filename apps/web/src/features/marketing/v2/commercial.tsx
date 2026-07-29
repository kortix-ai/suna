'use client';

import type { SectionSpec } from '@/features/marketing/v2/page-kit';
import { Display, Lead, MAX_W } from '@/features/marketing/v2/primitives';
import { RealVisual, hasVisual } from '@/features/marketing/v2/real-visual';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * Local helpers for the commercial and company routes.
 *
 * The kit's `CtaSection` always closes on "Get started / Request demo", which is
 * the wrong door on the pages where the next step is an email, the repo, or the
 * careers page. `CtaBand` is the same closing surface with the actions left open.
 */

export function CtaBand({
  id,
  heading,
  body,
  visual = 'KortixGrid',
  children,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  visual?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="relative isolate overflow-hidden"
      style={{
        background:
          'linear-gradient(150deg, color-mix(in oklab, var(--kortix-blue) 4%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 13%, var(--background)) 100%)',
      }}
    >
      {hasVisual(visual) && (
        <div className="absolute inset-y-0 right-[-6%] hidden w-[46%] lg:block">
          <RealVisual name={visual} className="h-full" />
        </div>
      )}

      <div className={cn(MAX_W, 'relative py-24 sm:py-32')}>
        <div className="max-w-xl">
          <Display lines={heading} />
          {body && <Lead className="mt-7">{body}</Lead>}
          <div className="mt-9 flex flex-wrap gap-2">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** One section from a page's spec list, by id. */
export function sectionById(page: SectionSpec[], id: string) {
  return page.find((section) => section.id === id);
}

/** Several sections, in the order the ids are given. */
export function sectionsById(page: SectionSpec[], ...ids: string[]) {
  return ids
    .map((id) => sectionById(page, id))
    .filter((section): section is SectionSpec => Boolean(section));
}
