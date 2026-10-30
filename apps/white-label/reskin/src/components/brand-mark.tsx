import { BRAND } from '@/config/brand';
import { BRAND_COLOR } from '@/config/theme';
import type { UiBrand } from '@kortix/ui';
import { cn } from '@kortix/ui/lib/utils';

// Lumen Workspace's mark: a lit aperture. One geometry for the inline mark and the image.
const MARK = (color: string) =>
  `<circle cx="14" cy="14" r="13" fill="${color}" opacity="0.16"/>` +
  `<circle cx="14" cy="14" r="8.5" fill="none" stroke="${color}" stroke-width="1.75"/>` +
  `<circle cx="14" cy="14" r="3.75" fill="${color}"/>`;

const markUrl = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">${MARK(color)}</svg>`)}`;

/**
 * Lumen Workspace's mark for @kortix/ui (`UiProvider useBrand`). Every place the package
 * would draw the Kortix symbol (empty session list, system-started sessions,
 * the agent's author label) draws this instead.
 */
export const LUMEN_UI_BRAND: UiBrand = {
  app_name: BRAND.name,
  icon_url: markUrl(BRAND_COLOR.light),
  icon_dark_url: markUrl(BRAND_COLOR.dark),
};

export function BrandMark({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <svg
        viewBox="0 0 28 28"
        aria-hidden
        className="size-7 shrink-0 text-brand"
        dangerouslySetInnerHTML={{ __html: MARK('currentColor') }}
      />
      {showWordmark && (
        <span className="font-display text-xl leading-none tracking-tight text-foreground">
          {BRAND.name}
        </span>
      )}
    </div>
  );
}
