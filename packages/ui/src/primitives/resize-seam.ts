import { cn } from '../lib/utils';

/**
 * The resize seam: a 2px `kortix-base` line on a drag edge, tapered at both
 * ends and faded top and bottom, so it reads as a seam, not a border. Drawn by
 * `before:`, so a caller keeps `after:` for its hit strip. Hidden at rest; the
 * caller reveals it (`before:opacity-100`) on hover, focus and drag. Opacity
 * only: a width or position transition would animate layout on hover.
 *
 * The sidebar rail (`sidebar-panel.tsx`) and every `ResizableHandle` draw it,
 * so every drag-to-resize edge in the app looks the same.
 */
export const RESIZE_SEAM_CLASS = cn(
  'before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:z-10 before:w-[2px] before:-translate-x-1/2 before:opacity-0',
  'before:bg-kortix-base before:transition-opacity before:duration-fast before:ease-out',
  'before:[clip-path:polygon(calc(50%-0.0625rem)_0%,calc(50%+0.0625rem)_0%,calc(50%+0.125rem)_50%,calc(50%+0.0625rem)_100%,calc(50%-0.0625rem)_100%,calc(50%-0.125rem)_50%)]',
  'before:[mask-image:linear-gradient(to_bottom,transparent,black_15%,black_85%,transparent)]',
  'motion-reduce:before:transition-none',
);
