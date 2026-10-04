'use client';

import { PillLink } from '@/features/marketing/os/primitives';
import { PageHero } from './page-hero';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type Props = {
  eyebrow: string;
  title: string;
  sub: string;
  ctaPrimary: string;
  ctaSecondary: string;
  ctaSecondaryHref: string;
  ctaPrimaryHref?: string;
  onCtaPrimaryClick?: () => void;
  /** The page's own hero scene. Every capability page ships one. */
  visual: ReactNode;
};

const PILL = 'inline-flex h-11 items-center rounded-full px-5 text-base';

/** The capability-page hero: `PageHero` with two pills and the page's scene. */
export function CapabilityHero({
  eyebrow,
  title,
  sub,
  ctaPrimary,
  ctaPrimaryHref,
  onCtaPrimaryClick,
  ctaSecondary,
  ctaSecondaryHref,
  visual,
}: Props): ReactNode {
  const primaryCta = onCtaPrimaryClick ? (
    <button
      type="button"
      onClick={onCtaPrimaryClick}
      className={cn(PILL, 'bg-foreground text-background hover:bg-foreground/90 transition-colors')}
    >
      {ctaPrimary}
    </button>
  ) : (
    <PillLink href={ctaPrimaryHref ?? '/auth'}>{ctaPrimary}</PillLink>
  );

  return (
    <PageHero
      eyebrow={eyebrow}
      title={title}
      sub={sub}
      actions={
        <>
          {primaryCta}
          <PillLink tone="outline" href={ctaSecondaryHref}>
            {ctaSecondary}
          </PillLink>
        </>
      }
    >
      {visual}
    </PageHero>
  );
}
