import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

const SIZES = {
  // Buio displayLG: 30 / 36 / 48px. The page h1.
  page: 'text-3xl md:text-4xl lg:text-5xl',
  // Buio displayMD: 24 / 30 / 36px. A section h2.
  section: 'text-2xl md:text-3xl lg:text-4xl',
  // Buio displaySM: 20 / 24 / 30px. A quiet line between sections.
  small: 'text-xl md:text-2xl lg:text-3xl',
} as const;

export type SectionHeadingProps = {
  /** Line one, in the ink colour. A short sentence ending in a period. */
  title: ReactNode;
  /** Line two, same size and weight, in the muted colour. */
  titleMuted?: ReactNode;
  /** One or two sentences under the title. */
  description?: ReactNode;
  /** Buttons under the description. */
  actions?: ReactNode;
  as?: 'h1' | 'h2' | 'h3';
  size?: keyof typeof SIZES;
  /** `center` centres the lines, the description and the actions (a closing box). */
  align?: 'start' | 'center';
  className?: string;
};

/**
 * The two-tone marketing heading (Buio): title, then description. No eyebrow,
 * no kicker. Both title lines share one size and weight (500); only the colour
 * changes. Capped at a 2xl measure, left aligned unless `align="center"`.
 * A space separates the two lines, so the text and the accessible name read
 * as two sentences, not "company.You own".
 */
export function SectionHeading({
  title,
  titleMuted,
  description,
  actions,
  as: Heading = 'h2',
  size = Heading === 'h1' ? 'page' : 'section',
  align = 'start',
  className,
}: SectionHeadingProps) {
  const center = align === 'center';
  return (
    <div className={cn('max-w-2xl', center && 'mx-auto text-center', className)}>
      <Heading
        className={cn('text-foreground font-medium tracking-tight text-balance', SIZES[size])}
      >
        {title}
        {titleMuted ? (
          <>
            {' '}
            <span className="text-muted-foreground block">{titleMuted}</span>
          </>
        ) : null}
      </Heading>
      {description ? (
        <p
          className={cn(
            'text-muted-foreground mt-6 max-w-xl text-base text-pretty',
            center && 'mx-auto',
          )}
        >
          {description}
        </p>
      ) : null}
      {actions ? (
        <div className={cn('mt-8 flex flex-wrap items-center gap-2', center && 'justify-center')}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
