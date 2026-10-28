'use client';

import { cn } from '@kortix/ui';

import { DitherField } from './dither-field';

/**
 * Hero art: a large glyph drawn in the footer call to action's dither shader
 * (`DitherField`), clipped to the glyph's solid silhouette with a CSS mask.
 * `src` is a one-colour SVG cropped to its own bounds; `className` sets the
 * size and the glyph's aspect ratio. The field animates as it does in the
 * footer: paused off screen, one still frame under reduced motion.
 */
export function DitherGlyph({ src, className }: { src: string; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('text-foreground', className)}
      style={{
        maskImage: `url(${src})`,
        WebkitMaskImage: `url(${src})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    >
      <DitherField />
    </div>
  );
}
