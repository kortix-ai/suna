import { cn } from '@/lib/utils';
import Image from 'next/image';

/**
 * Card header artwork. Both images already ship in `public/` — nothing here is
 * captured or generated.
 *
 * `next/image` rather than a raw <img>, because the source files are far larger
 * than the slot they land in: the three phone shots are 1.9 MB, 1.6 MB and
 * 1.8 MB of PNG for a box about 490px wide. Next resizes and re-encodes to
 * AVIF/WebP per `next.config.ts`, which turns 5.3 MB of PNG into tens of KB.
 * `sizes` is what tells it which width to actually generate; without it every
 * visitor is served the largest candidate and the optimisation is wasted.
 *
 * `alt=""` on every image: each sits directly under its own card heading, so
 * announcing it again is duplication, not information.
 */

const SLOT = 'aspect-[16/10] w-full overflow-hidden border-b bg-muted';

/**
 * The desktop poster is a THEME PAIR toggled by `dark:hidden` / `hidden
 * dark:block` — deliberately not `<picture media="(prefers-color-scheme: dark)">`.
 *
 * A `media` attribute resolves once, when the browser picks a source. It is
 * therefore correct on first paint and permanently wrong the moment the visitor
 * uses the app's own theme toggle, because the element never re-runs resource
 * selection. (`hero-surfaces.tsx` hits exactly this with its <video>, and pays
 * for it with a `useTheme()` hook and a keyed remount.)
 *
 * Class toggling costs both files and follows the toggle forever — and needs no
 * hook, which is what keeps this page a Server Component.
 */
export function DesktopCardImage() {
  return (
    <div className={cn(SLOT, 'relative')}>
      <Image
        src="/media/showcase/kortix-showcase-poster.jpg"
        alt=""
        fill
        sizes="(min-width: 768px) 50vw, 100vw"
        className="object-cover dark:hidden"
        priority
      />
      <Image
        src="/media/showcase/kortix-showcase-dark-poster.jpg"
        alt=""
        fill
        sizes="(min-width: 768px) 50vw, 100vw"
        className="hidden object-cover dark:block"
        priority
      />
    </div>
  );
}

const MOBILE_SHOTS = [
  '/images/mobile-app/app-1.png',
  '/images/mobile-app/app-2.png',
  '/images/mobile-app/app-3.png',
];

/**
 * Three phones in the same 16:10 box the desktop poster occupies, so both cards'
 * headers are the same height and their first row seams line up.
 *
 * Each phone is HEIGHT-bound (`h-full w-auto` against the 1080x2337 ratio), not
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
            'border-border bg-background relative aspect-[1080/2337] h-full w-auto',
            'overflow-hidden rounded-md border',
            // The middle phone lifts, the outer two drop. Enough to read as a
            // deliberate arrangement, not enough to look scattered.
            i === 1 ? '-translate-y-2' : 'translate-y-2',
          )}
        >
          <Image src={src} alt="" fill sizes="(min-width: 768px) 12vw, 25vw" className="object-cover" />
        </div>
      ))}
    </div>
  );
}
