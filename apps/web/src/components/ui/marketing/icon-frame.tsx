import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type IconFrameProps = {
  className?: string;
  children: ReactNode;
};

/**
 * iOS app-icon corner radius is ~22.37% of the canvas.
 * `corner-shape: squircle` upgrades that to a superellipse where supported.
 * Size comes from the parent or `className` (`size-10`, `size-full`, …).
 * The child SVG/img always fills 54% of that canvas.
 */
const SQUIRCLE = 'rounded-[22.37%] [corner-shape:squircle]';

export function IconFrame({ className, children }: IconFrameProps) {
  return (
    <div
      className={cn(
        '@container relative isolate aspect-square size-full shrink-0 text-background',
        SQUIRCLE,
        'shadow-[0_8cqw_22cqw_rgb(0_0_0/0.28),0_2cqw_6cqw_rgb(0_0_0/0.16)]',
        'contrast-more:outline-1 contrast-more:outline-foreground',
        className,
      )}
    >
      <div
        className={cn(
          'absolute inset-0 overflow-hidden',
          SQUIRCLE,
          'bg-[linear-gradient(112deg,var(--foreground)_0%,color-mix(in_oklab,var(--foreground)_70%,var(--background))_48%,color-mix(in_oklab,var(--foreground)_35%,var(--background))_100%)]',
        )}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute top-[-10%] right-[-20%] h-[125%] w-[82%] rounded-[100%] bg-[radial-gradient(ellipse_at_42%_40%,color-mix(in_oklab,var(--background)_42%,transparent)_0%,transparent_70%)] opacity-90 blur-[4cqw] dark:bg-[radial-gradient(ellipse_at_42%_40%,color-mix(in_oklab,var(--foreground)_42%,transparent)_0%,transparent_70%)] [@media(prefers-reduced-transparency:reduce)]:blur-none [@media(prefers-reduced-transparency:reduce)]:opacity-50"
        />

        <span
          aria-hidden
          className="pointer-events-none absolute bottom-[-32%] left-[-26%] h-[72%] w-[72%] rounded-full bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--background)_28%,transparent),transparent_64%)] blur-[5.5cqw] dark:bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--foreground)_28%,transparent),transparent_64%)] [@media(prefers-reduced-transparency:reduce)]:hidden"
        />

        <span className="relative z-1 grid size-full place-items-center">
          <span
            className={cn(
              'grid size-[54%] aspect-square place-items-center',
              'drop-shadow-[0_1.8cqw_2.8cqw_rgb(0_0_0/0.22)]',
              '*:size-full *:max-h-full *:max-w-full *:object-contain',
              '[&>svg]:size-full! [&>img]:size-full!',
            )}
          >
            {children}
          </span>
        </span>

        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-2 bg-[linear-gradient(128deg,color-mix(in_oklab,var(--background)_48%,transparent)_0%,color-mix(in_oklab,var(--background)_18%,transparent)_36%,transparent_42%)] dark:bg-[linear-gradient(128deg,color-mix(in_oklab,var(--foreground)_48%,transparent)_0%,color-mix(in_oklab,var(--foreground)_18%,transparent)_36%,transparent_42%)] [@media(prefers-reduced-transparency:reduce)]:opacity-35"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-[-22%] right-[-30%] z-2 h-[88%] w-[92%] rounded-full bg-[radial-gradient(circle_at_38%_28%,color-mix(in_oklab,var(--background)_70%,transparent)_0%,transparent_56%)] opacity-55 blur-[5cqw] mix-blend-soft-light motion-reduce:mix-blend-normal dark:bg-[radial-gradient(circle_at_38%_28%,color-mix(in_oklab,var(--foreground)_70%,transparent)_0%,transparent_56%)] [@media(prefers-reduced-transparency:reduce)]:hidden"
        />

        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 z-3',
            SQUIRCLE,
            'shadow-[inset_0_1px_0_rgb(255_255_255/0.58),inset_0_-1px_0_rgb(0_0_0/0.24),inset_0_0_0_1px_rgb(255_255_255/0.28),inset_0_7cqw_10cqw_rgb(0_0_0/0.14)]',
          )}
        />
      </div>
    </div>
  );
}
