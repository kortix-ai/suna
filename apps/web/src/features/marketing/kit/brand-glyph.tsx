import { cn } from '@kortix/ui';

import { WORKS_WITH } from '../landing-sections/works-with-logos';

/**
 * An official brand mark (simple-icons, in public/media/landing/logos) in the
 * brand's own colour. Colours come from `works-with-logos.ts`, the one module
 * that holds third-party brand colours; a near-black brand draws in ink.
 */
export function BrandGlyph({ slug, className }: { slug: string; className?: string }) {
  const color = WORKS_WITH.find((logo) => logo.slug === slug)?.color ?? 'var(--foreground)';
  return (
    <span
      aria-hidden
      className={cn('size-5 shrink-0', className)}
      style={{
        backgroundColor: color,
        maskImage: `url(/media/landing/logos/${slug}.svg)`,
        WebkitMaskImage: `url(/media/landing/logos/${slug}.svg)`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  );
}
