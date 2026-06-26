import { brand } from '@/config/brand';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';

/**
 * The white-label brand mark. Renders the brand glyph on the accent color
 * defined in `src/config/brand.ts`. Swap the glyph in `Icon.Brand` or the
 * colors in the brand config to re-skin every surface that shows it.
 */
export function BrandMark({
  className,
  glyphClassName,
}: {
  className?: string;
  glyphClassName?: string;
}) {
  return (
    <span
      className={cn('grid size-7 shrink-0 place-items-center rounded-md', className)}
      style={{ background: brand.accent, color: brand.accentForeground }}
    >
      <Icon.Brand className={cn('size-4', glyphClassName)} />
    </span>
  );
}
