import { BRAND } from '@/config/brand';
import { BRAND_COLOR, LAMP } from '@/config/theme';
import { WORDMARK } from '@/config/wordmark';
import { cn, type UiBrand } from '@kortix/ui';

/**
 * Lumen's glyph, the "lamp L": a bracketed serif capital L with a lit window
 * in its open corner. 24-unit grid. The letter takes `ink`, the window takes
 * `light` (the lamp on the brand surface, ink elsewhere).
 */
export const GLYPH_L =
  'M2 2H11V3.1C9.9 3.2 9 3.6 8.8 4.6V19.3H17.4C18.9 19.3 19.9 18.3 20.6 15.8H21.6L21.2 22H2V20.9C3.4 20.8 4.2 20.4 4.2 19.2V4.7C4.2 3.6 3.4 3.2 2 3.1Z';
export const GLYPH_LAMP = { x: 12.4, y: 7.6, size: 4.8, r: 0.6 } as const;

export function glyphSvg(ink: string, light: string = ink): string {
  const l = GLYPH_LAMP;
  return (
    `<path d="${GLYPH_L}" fill="${ink}"/>` +
    `<rect x="${l.x}" y="${l.y}" width="${l.size}" height="${l.size}" rx="${l.r}" fill="${light}"/>`
  );
}

const markUrl = (ink: string, light: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${glyphSvg(ink, light)}</svg>`)}`;

/**
 * Lumen's mark for @kortix/ui (`UiProvider useBrand`). Every place the package
 * would draw the Kortix symbol (empty session list, system-started sessions,
 * the agent's author label) draws this instead.
 */
export const LUMEN_UI_BRAND: UiBrand = {
  app_name: BRAND.name,
  icon_url: markUrl(BRAND_COLOR.light, LAMP.light),
  icon_dark_url: markUrl(BRAND_COLOR.dark, LAMP.dark),
};

/** The glyph alone: favicon, app icon, avatars, the assistant's author mark. */
export function BrandGlyph({ className, lit = true }: { className?: string; lit?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-6 shrink-0', className)}>
      <path d={GLYPH_L} fill="currentColor" />
      <rect
        x={GLYPH_LAMP.x}
        y={GLYPH_LAMP.y}
        width={GLYPH_LAMP.size}
        height={GLYPH_LAMP.size}
        rx={GLYPH_LAMP.r}
        className={lit ? 'fill-lamp' : 'fill-current'}
      />
    </svg>
  );
}

/** The wordmark: LUMEN in the display serif's capitals, as outlines. Its height is the cap height, 0.68em. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      role="img"
      aria-label={BRAND.name}
      className={cn('h-[0.68em] w-auto shrink-0 fill-current', className)}
    >
      <path d={WORDMARK.d} />
    </svg>
  );
}

/**
 * The lockup: the glyph at cap height left of the wordmark, a gap of half the
 * cap height. Size it with the font size (`text-[22px]`).
 * `showWordmark={false}` draws the glyph alone.
 */
export function BrandMark({
  className,
  showWordmark = true,
  lit = true,
}: {
  className?: string;
  showWordmark?: boolean;
  lit?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-[0.34em] text-[22px] text-foreground', className)}>
      <svg viewBox="1.8 2 19.9 20" aria-hidden className="h-[0.68em] w-auto shrink-0">
        <path d={GLYPH_L} fill="currentColor" />
        <rect
          x={GLYPH_LAMP.x}
          y={GLYPH_LAMP.y}
          width={GLYPH_LAMP.size}
          height={GLYPH_LAMP.size}
          rx={GLYPH_LAMP.r}
          className={lit ? 'fill-lamp' : 'fill-current'}
        />
      </svg>
      {showWordmark && <Wordmark />}
    </span>
  );
}
