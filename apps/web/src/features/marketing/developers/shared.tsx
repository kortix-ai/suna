import { cn } from '@/lib/utils';
import type { CSSProperties } from 'react';
import type { TwoTone } from './content';

export { DitherField } from './dither-field';

/** Section heading type: one size for every section heading on /developers (not the hero). */
export const SECTION_HEADING =
  'text-foreground text-[1.75rem]/8 font-medium tracking-[-0.72px] text-balance lg:text-[2.25rem]/[2.5rem]';

/** Two-line headline: first line muted, second line ink. */
export function TwoToneHeading({
  lines,
  as: Tag = 'h2',
  className,
}: {
  lines: TwoTone;
  as?: 'h1' | 'h2';
  className?: string;
}) {
  return (
    <Tag className={cn(SECTION_HEADING, className)}>
      <span className="text-muted-foreground block">{lines.muted}</span>
      <span className="text-foreground block">{lines.ink}</span>
    </Tag>
  );
}

/** Alpha-mask art painted with a token color, so it follows the theme. Pass `bg-*` in className. */
export function HalftoneMask({ src, className }: { src: string; className?: string }) {
  const mask: CSSProperties = {
    maskImage: `url(${src})`,
    WebkitMaskImage: `url(${src})`,
    maskSize: 'contain',
    WebkitMaskSize: 'contain',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
  };
  return <div aria-hidden style={mask} className={cn('bg-foreground', className)} />;
}
