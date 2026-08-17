'use client';

import { Reveal } from '@/components/home/reveal';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The shared shell both interludes are built on.
 *
 * WHY ONE SHELL. The two sections only do their job — restoring rhythm to the
 * back half of the page — if a reader recognises them as the same species the
 * second time round. Identical measure, identical column split, identical
 * spacing; the single difference is which side the graphic sits on. Two
 * bespoke layouts would have read as two more one-off surfaces, which is the
 * problem, not the fix.
 *
 * WHY 5 / 7. The text column is capped near a 60-character measure at this
 * width, which is where prose stays readable; the panel takes the wider half
 * because a file tree and a set of quoted sentences both need horizontal room
 * before they start wrapping into mush.
 *
 * WHY IT IS SO PLAIN. It sits between a pinned card wheel, a bordered slab, a
 * dark card and a gridded CTA. Anything with its own personality here competes
 * with four surfaces that already have one. There is no shadow, no fill on the
 * section, no accent colour and nothing to interact with — on purpose.
 */
export function Interlude({
  id,
  eyebrow,
  title,
  paragraphs,
  panel,
  /** Puts the panel on the LEFT and the prose on the right. */
  flip = false,
}: {
  id: string;
  eyebrow: string;
  title: string;
  paragraphs: readonly string[];
  panel: ReactNode;
  flip?: boolean;
}): ReactNode {
  return (
    <section id={id} className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
      <div className="grid items-center gap-x-16 gap-y-10 lg:grid-cols-12">
        {/* prose */}
        <div
          className={cn(
            'min-w-0 lg:col-span-5',
            flip ? 'lg:order-2' : 'lg:order-1',
          )}
        >
          <SectionHeader eyebrow={eyebrow} title={title} />
          <Reveal>
            <div className="mt-5 space-y-4">
              {paragraphs.map((paragraph) => (
                <p
                  key={paragraph.slice(0, 32)}
                  className="text-muted-foreground text-base leading-[1.7] text-pretty"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </Reveal>
        </div>

        {/* graphic */}
        <Reveal
          className={cn(
            'min-w-0 lg:col-span-7',
            flip ? 'lg:order-1' : 'lg:order-2',
          )}
        >
          {panel}
        </Reveal>
      </div>
    </section>
  );
}

/**
 * The panel frame shared by both graphics: a title bar, the content, and one
 * line of footnote. `rounded-sm` and a hairline border, flat — it is in the
 * page flow, so it gets an edge rather than elevation.
 */
export function Panel({
  title,
  label,
  footer,
  children,
}: {
  title: string;
  label: string;
  footer: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      <div className="border-border/70 bg-muted/30 flex items-baseline justify-between gap-3 border-b px-4 py-2.5 sm:px-5">
        <span className="text-foreground min-w-0 truncate font-mono text-[11px]">{title}</span>
        <span className="text-muted-foreground/50 shrink-0 font-mono text-[9px] tracking-widest uppercase">
          {label}
        </span>
      </div>

      {children}

      <p className="border-border/70 text-muted-foreground border-t px-4 py-3 text-[11.5px] leading-relaxed text-pretty sm:px-5">
        {footer}
      </p>
    </div>
  );
}
