import { KortixLogo } from '@/components/ui/kortix-logo';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { cn } from '@/lib/utils';
import Image from 'next/image';

const SLOT = 'aspect-[16/10] w-full overflow-hidden border-b bg-muted';

/**
 * The desktop app's art: the same light-beam shader as the "Connect your
 * computer" modal, with the Kortix brandmark on it. Dark in both themes, so the
 * slot resolves its tokens under `dark` and the mark renders white. It rounds
 * its own top corners: the card's `overflow-hidden` does not clip the shader's
 * WebGL canvas.
 */
export function DesktopCardImage() {
  return (
    <div
      className={cn(
        SLOT,
        'dark bg-background relative isolate flex items-center justify-center rounded-t-md',
      )}
    >
      <BeamsShader />
      <KortixLogo variant="brandmark" size={28} className="text-foreground relative" />
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
