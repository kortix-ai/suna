import { cn } from '@kortix/ui';
import { PROMO_GRADIENT } from '@kortix/ui/internal/lib/promo-art';
import Image from 'next/image';

const SLOT = 'aspect-[16/10] w-full overflow-hidden border-b bg-muted';

const DESKTOP_SHOTS = {
  light: '/images/desktop-app/session-top-light.webp',
  dark: '/images/desktop-app/session-top-dark.webp',
};

/**
 * The desktop app's art: the mobile-app promo's gradient (`promo-art.ts`),
 * with a real session page laid on it (1440x900, shot in both themes on
 * a local stack with a demo project; the page shows the visitor's theme).
 *
 * The shot is inset from the top and left only and runs off the right and
 * bottom edges, so it reads as the app window continuing past the card. It
 * shows at 150% from its top-left corner: the session sidebar and the chat read
 * at card size, the whole page shrunk to fit did not.
 *
 * The gradient is art, the same in both themes.
 */
export function DesktopCardImage() {
  return (
    <div style={{ backgroundImage: PROMO_GRADIENT }} className={cn(SLOT, 'relative')}>
      <div className="border-border absolute top-8 right-0 bottom-0 left-8 overflow-hidden rounded-tl-md border-t border-l">
        <Image
          src={DESKTOP_SHOTS.light}
          alt=""
          width={1440}
          height={900}
          sizes="(min-width: 768px) 720px, 150vw"
          className="absolute top-0 left-0 h-auto w-[150%] max-w-none dark:hidden"
        />
        <Image
          src={DESKTOP_SHOTS.dark}
          alt=""
          width={1440}
          height={900}
          sizes="(min-width: 768px) 720px, 150vw"
          className="absolute top-0 left-0 h-auto w-[150%] max-w-none hidden dark:block"
        />
      </div>
    </div>
  );
}

/**
 * The App Store listing art (640x1385, exported from the store-listing frames
 * in the design file): "Kortix in your pocket", "Connect your tools",
 * "Preview what's built". `store-01..06.webp` hold all six frames. The landing
 * page's mobile surface reads this same list, so every three-phone strip on the
 * site shows the current app.
 */
export const MOBILE_SHOTS = [
  '/images/mobile-app/store-01.webp',
  '/images/mobile-app/store-04.webp',
  '/images/mobile-app/store-05.webp',
];

/**
 * Three phones in the same 16:10 box the desktop poster occupies, so both cards'
 * headers are the same height and their first row seams line up.
 *
 * Each phone is HEIGHT-bound (`h-full w-auto` against the 640x1385 ratio), not
 * width-bound. Width-bound was the first attempt and it was wrong: at a third of
 * the card's width each phone computes taller than the slot, so the bottoms
 * clipped at an arbitrary point mid-screenshot. That reads as a mistake rather
 * than a crop. Height-bound shows every phone whole, which also matches the
 * desktop card — that poster is shown complete too.
 *
 * Borders, never shadows. The `MobileSurface` treatment in `hero-surfaces.tsx`
 * frames these same shots with `shadow-md`; that part is deliberately not
 * carried over.
 */
export function MobileCardImage() {
  return (
    <div className={cn(SLOT, 'flex items-center justify-center gap-3 px-6 py-6')}>
      {MOBILE_SHOTS.map((src, i) => (
        <div
          key={src}
          className={cn(
            'border-border bg-background relative aspect-[640/1385] h-full w-auto',
            'overflow-hidden rounded-md border',
            // The middle phone lifts, the outer two drop. Enough to read as a
            // deliberate arrangement, not enough to look scattered.
            i === 1 ? '-translate-y-2' : 'translate-y-2',
          )}
        >
          <Image
            src={src}
            alt=""
            fill
            sizes="(min-width: 768px) 12vw, 25vw"
            className="object-cover"
          />
        </div>
      ))}
    </div>
  );
}
