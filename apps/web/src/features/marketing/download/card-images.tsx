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

/** iOS App Store screenshots 01-03, exported from the Paper file at 640w. */
const MOBILE_SHOTS = [
  '/images/mobile-app/store-01.webp',
  '/images/mobile-app/store-02.webp',
  '/images/mobile-app/store-03.webp',
];

/**
 * Three phones in the same 16:10 box the desktop poster occupies, so both cards'
 * headers are the same height and their first row seams line up.
 *
 * Each phone is HEIGHT-bound (`h-full w-auto` against the 1284x2778 ratio), not
 * width-bound. At a third of the card's width a width-bound phone computes
 * taller than the slot and clips mid-screenshot. Height-bound shows every phone
 * whole.
 *
 * Borders, never shadows.
 */
export function MobileCardImage() {
  return (
    <div className={cn(SLOT, 'flex items-center justify-center gap-3 px-6 py-6')}>
      {MOBILE_SHOTS.map((src, i) => (
        <div
          key={src}
          className={cn(
            'border-border bg-background relative aspect-[1284/2778] h-full w-auto',
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
