import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The one marketing measure (Buio `max-w-340 px-4 lg:px-24`): a 1440px column,
 * a 4-step gutter, 24 from `lg`. The hero, the navbar, its panels, the footer
 * and every rebuilt page share it, so all their left edges line up. The hero
 * repeats the same two gutter values as `--gutter` for its band maths.
 */
export const MARKETING_CONTAINER = 'mx-auto w-full max-w-[1440px] px-4 lg:px-24';

/**
 * One marketing section: the shared measure plus Buio's vertical rhythm
 * (`py-24 md:py-30`, 88 → 110px). Sections stack with no dividers, so two
 * neighbours sit 176–220px apart. `scroll-mt-16` clears the fixed bar when a
 * `#id` link lands here.
 */
export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16">
      <div className={cn(MARKETING_CONTAINER, 'py-24 md:py-30', className)}>{children}</div>
    </section>
  );
}
