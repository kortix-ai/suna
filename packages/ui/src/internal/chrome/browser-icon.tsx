import { Edge } from '../icons/edge';
import { cn } from '../lib/utils';

/** A third-party logo tile is white in both themes (color.md). */
const LOGO_TILE_BACKGROUND = 'bg-white';

type BrowserKey = 'chrome' | 'brave' | 'arc' | 'opera' | 'vivaldi' | 'edge';

/**
 * Official brand colors, from simple-icons (CC0). The SVG files in
 * `public/browser-icons/` are the same set. Edge is not in simple-icons 13:
 * it renders the house full-colour `Edge` mark instead.
 */
const CHROME_BLUE = '#4285F4';
const BRAVE_ORANGE = '#FB542B';
const ARC_PINK = '#FCBFBD';
const OPERA_RED = '#FF1B2D';
const VIVALDI_RED = '#EF3939';

const BROWSER_BRAND_HEX: Record<Exclude<BrowserKey, 'edge'>, string> = {
  chrome: CHROME_BLUE,
  brave: BRAVE_ORANGE,
  arc: ARC_PINK,
  opera: OPERA_RED,
  vivaldi: VIVALDI_RED,
};

const BROWSER_KEYS: readonly BrowserKey[] = ['brave', 'arc', 'opera', 'vivaldi', 'edge', 'chrome'];

/** Maps the API's `brand` string (Chrome, Edge, Brave, Arc, Dia, …) to a mark. Any other Chromium browser gets Chrome. */
export function browserKey(brand: string | null | undefined): BrowserKey {
  const name = (brand ?? '').toLowerCase();
  return BROWSER_KEYS.find((key) => name.includes(key)) ?? 'chrome';
}

/**
 * The browser's mark. `tone="brand"` paints the official color; `tone="current"`
 * paints `currentColor`, for the monochrome sidebar and settings rail.
 */
export function BrowserIcon({
  brand,
  tone = 'brand',
  className,
}: {
  brand?: string | null;
  tone?: 'brand' | 'current';
  className?: string;
}) {
  const key = browserKey(brand);
  if (key === 'edge' && tone === 'brand') return <Edge className={className} />;
  const file = key === 'edge' ? 'chrome' : key;
  const url = `url(/browser-icons/${file}.svg)`;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-4 shrink-0', tone === 'current' && 'bg-current', className)}
      style={{
        backgroundColor: tone === 'brand' && key !== 'edge' ? BROWSER_BRAND_HEX[key] : undefined,
        maskImage: url,
        WebkitMaskImage: url,
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

/** The browser mark on a white tile. `className` sets the tile size and radius. */
export function BrowserLogoTile({
  brand,
  className,
  iconClassName,
}: {
  brand?: string | null;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={cn(
        LOGO_TILE_BACKGROUND,
        'ring-border flex size-9 shrink-0 items-center justify-center rounded-sm ring-1 ring-inset',
        className,
      )}
    >
      <BrowserIcon brand={brand} className={cn('size-5', iconClassName)} />
    </span>
  );
}

/** Monochrome Chrome mark with the `Icon` call shape the settings rail expects. */
export function ChromeRailIcon({ className }: { className?: string }) {
  return <BrowserIcon brand="chrome" tone="current" className={className} />;
}
