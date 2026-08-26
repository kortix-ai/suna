'use client';

import { useBranding } from '@/features/branding/branding-provider';
import { cn } from '@/lib/utils';
import type { ComponentPropsWithoutRef } from 'react';

export type KortixLogoVariant = 'icon' | 'brandmark';

interface KortixLogoProps
  extends Omit<ComponentPropsWithoutRef<'svg'>, 'width' | 'height' | 'viewBox'> {
  /** Pixel height. The brandmark scales its width to match; the icon is square. */
  size?: number;
  /** `icon` = the Kortix symbol alone; `brandmark` = symbol + wordmark lockup. */
  variant?: KortixLogoVariant;
  className?: string;
}

/**
 * The canonical Kortix logo. Renders in `currentColor` so it follows the
 * surrounding text color (`text-foreground` in app surfaces).
 *
 * Organization branding: when the active account carries its own marks
 * (`useBranding()` — Enterprise `branding` entitlement), the matching slot
 * renders that image instead: `brandmark` → `logo_url` (falling back to
 * `icon_url` so a square-only brand still replaces the wordmark), `icon` →
 * `icon_url`. Same box, same `size` semantics, so no call site changes.
 * A dark-scheme variant (`*_dark_url`), when set, is rendered as a second
 * `<img>` toggled by the theme class (`dark:` — the app theme is class-based,
 * `next-themes attribute="class"`), so the swap is hydration-safe and needs
 * no JS. Outside the provider — and for every unbranded account — this is
 * Kortix, which renders in `currentColor` and needs no variant.
 *
 * `@/components/sidebar/kortix-logo` re-exports this under its legacy
 * `symbol`/`logomark` variant names — new code should import from here.
 */
export function KortixLogo({
  size = 24,
  variant = 'brandmark',
  className,
  style,
  ...props
}: KortixLogoProps) {
  const branding = useBranding();
  // Light is the base; dark is an optional override. A square-only brand
  // stands in for the wordmark, per scheme: a dark icon is a better dark
  // brandmark than a light logo.
  const lightSrc =
    variant === 'icon' ? branding?.icon_url : (branding?.logo_url ?? branding?.icon_url);
  const darkSrc =
    variant === 'icon'
      ? branding?.icon_dark_url
      : (branding?.logo_dark_url ?? branding?.icon_dark_url);

  if (lightSrc) {
    const alt = 'Home';
    const imgStyle =
      variant === 'icon'
        ? { width: `${size}px`, height: `${size}px`, ...style }
        : { height: `${size}px`, width: 'auto', maxWidth: `${size * 8}px`, ...style };
    const imgProps = props as ComponentPropsWithoutRef<'img'>;
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={lightSrc}
          alt={alt}
          draggable={false}
          className={cn('shrink-0 select-none object-contain', darkSrc && 'dark:hidden', className)}
          style={imgStyle}
          {...imgProps}
        />
        {darkSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={darkSrc}
            alt={alt}
            draggable={false}
            className={cn('hidden shrink-0 select-none object-contain dark:block', className)}
            style={imgStyle}
            {...imgProps}
          />
        ) : null}
      </>
    );
  }

  if (variant === 'icon') {
    return (
      <svg
        width="30"
        height="25"
        viewBox="0 0 30 25"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={cn('shrink-0', className)}
        style={{ width: `${size}px`, height: `${size}px`, ...style }}
        {...props}
      >
        <path
          d="M25.56 24.916H29.83C29.83 19.63 26.94 15 22.62 12.46C26.94 9.91 29.83 5.29 29.83 0H25.56C25.56 5 21.89 9.19 17.07 10.17V0H12.8V10.17C7.95 9.2 4.3 5.02 4.3 0H0.04C0.04 5.29 2.93 9.91 7.25 12.46C2.93 15 0.04 19.63 0.04 24.916H4.3C4.3 19.9 7.95 15.71 12.8 14.75V24.92H17.07V14.75C21.91 15.71 25.56 19.9 25.56 24.916Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  return (
    <svg
      width="708"
      height="142"
      viewBox="0 0 708 142"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('shrink-0', className)}
      style={{ height: `${size}px`, width: 'auto', ...style }}
      {...props}
    >
      <path
        d="M139.522 139.53H162.84C162.84 109.932 147.046 84.02 123.427 69.77C147.046 55.52 162.839 29.61 162.839 0.01H139.522C139.522 28.02 119.455 51.45 93.08 56.94V0.01H69.76V56.94C43.26 51.54 23.32 28.1 23.32 0.01H0C0 29.61 15.79 55.52 39.41 69.77C15.79 84.02 0 109.932 0 139.53H23.32C23.32 111.434 43.26 87.996 69.76 82.6V139.556H93.08V82.598C119.579 88 139.522 111.434 139.522 139.53Z"
        fill="currentColor"
      />
      <path
        d="M379.024 141.074C348.339 141.074 326.422 119.156 326.422 89.27C326.422 59.38 348.339 37.46 379.024 37.46C409.509 37.46 431.426 59.38 431.426 89.27C431.426 119.156 409.509 141.074 379.024 141.074ZM379.024 119.953C395.561 119.953 406.719 107.4 406.719 89.27C406.719 71.14 395.561 58.58 379.024 58.58C362.287 58.58 351.129 71.14 351.129 89.27C351.129 107.4 362.287 119.953 379.024 119.953Z"
        fill="currentColor"
      />
      <path
        d="M500.433 59.58V39.06H492.199C475.462 39.06 441.988 49.1 441.988 89.27V139.48H466.496L467.243 89.27C467.243 70.14 472.673 59.58 488.214 59.58H500.433Z"
        fill="currentColor"
      />
      <path
        d="M255.933 0H231.24V139.452H255.933V82.59C282.273 88.1 302.057 111.452 302.057 139.426H325.358C325.358 109.848 309.576 83.96 285.972 69.713C309.575 55.47 325.358 29.58 325.358 0H302.056C302.056 27.89 282.15 51.23 255.933 56.832V0Z"
        fill="currentColor"
      />
      <path
        d="M509.742 8.77H534.25V39.06H568.298V59.58H534.25V103.415C534.25 113.577 539.629 118.758 548.795 118.758H568.298V139.48H546.006C524.088 139.48 509.742 126.728 509.742 104.412V8.77Z"
        fill="currentColor"
      />
      <path
        d="M578.743 13.12C578.762 5.87 584.644 0 591.893 0C599.17 0 605.063 5.91 605.044 13.19L605.042 13.72C605.023 20.97 599.141 26.84 591.892 26.84C584.615 26.84 578.722 20.93 578.741 13.654L578.743 13.12ZM579.774 139.48V39.06H604.282V139.48H579.774Z"
        fill="currentColor"
      />
      <path
        d="M638.582 139.42H616.248C616.248 118.788 626.473 100.544 642.133 89.479C626.474 78.41 616.249 60.17 616.249 39.54H638.583C638.583 55.39 648.093 69.02 661.718 75.03C675.342 69.02 684.852 55.39 684.852 39.54H707.187C707.187 60.17 696.961 78.41 681.302 89.479C696.962 100.544 707.188 118.788 707.188 139.42H684.853C684.853 123.571 675.343 109.943 661.718 103.93C648.092 109.943 638.582 123.571 638.582 139.42Z"
        fill="currentColor"
      />
    </svg>
  );
}
