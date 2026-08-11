import { cn } from '@/lib/utils';
import type { ComponentPropsWithoutRef } from 'react';

export type KortixLogoVariant = 'icon' | 'brandmark';

interface KortixLogoProps
  extends Omit<ComponentPropsWithoutRef<'svg'>, 'width' | 'height' | 'viewBox'> {
  /** Pixel height. The brandmark scales its width to match; the icon is square. */
  size?: number;
  /** `icon` = the dosco fire-katana symbol alone; `brandmark` = symbol + wordmark lockup. */
  variant?: KortixLogoVariant;
  className?: string;
}

const iconViewBox = '0 0 30 25';
const brandmarkViewBox = '0 0 230 60';

const iconPaths = (
  <>
    <path d="M14 1.5 L16 1.5 L15.4 11.2 L14.6 11.2 Z" fill="currentColor" />
    <rect x="14.6" y="11.2" width="0.8" height="6.6" fill="currentColor" />
    <rect x="12.2" y="17.8" width="5.6" height="1.2" rx="0.4" fill="currentColor" />
    <rect x="14.3" y="19" width="1.4" height="4.6" fill="currentColor" />
    <rect x="13.5" y="23.4" width="3" height="1.4" rx="0.3" fill="currentColor" />
    <path
      d="M11.6 20.4 Q12.4 19.2 11.6 17.6 Q12.6 18.6 12.6 19.6 Q12.6 18 13.4 17.2 Q13 19.2 12.6 20.4 Z"
      fill="#f97316"
    />
    <path
      d="M18.4 20.4 Q17.6 19.2 18.4 17.6 Q17.4 18.6 17.4 19.6 Q17.4 18 16.6 17.2 Q17 19.2 17.4 20.4 Z"
      fill="#f97316"
    />
    <path
      d="M15 16.6 Q14.4 15.2 14.2 13.6 Q15 14.4 15.4 15.4 Q15.6 14 16.4 13.2 Q16.2 15 15.6 16.6 Z"
      fill="#f97316"
    />
  </>
);

/**
 * Canonical dosco logo (rebranded from dosco). The component keeps the
 * `kortix-logo.tsx` filename as a back-compat alias so every importing surface
 * stays untouched; only the rendered mark is new.
 *
 * `icon`     — the fire-katana symbol on its own (square 30x25).
 * `brandmark` — the symbol + the wordmark "dosco", in a wide lockup.
 *
 * Both render in `currentColor` for the blade/guard/hilt and accent with the
 * dosco flame orange — so the surrounding text colour drives the metal tone
 * while the flame stays on brand. `@/components/sidebar/kortix-logo`
 * re-exports this under the legacy `symbol`/`logomark` variant names so
 * imports keep working.
 */
export function KortixLogo({
  size = 24,
  variant = 'brandmark',
  className,
  style,
  ...props
}: KortixLogoProps) {
  if (variant === 'icon') {
    return (
      <svg
        width="30"
        height="25"
        viewBox={iconViewBox}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={cn('shrink-0', className)}
        style={{ width: `${size}px`, height: `${size}px`, ...style }}
        {...props}
      >
        {iconPaths}
      </svg>
    );
  }

  return (
    <svg
      width="230"
      height="60"
      viewBox={brandmarkViewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('shrink-0', className)}
      style={{ height: `${size}px`, width: 'auto', ...style }}
      {...props}
    >
      <g transform="translate(0 12) scale(1.5)">
        {iconPaths}
      </g>
      <text
        x="60"
        y="42"
        fill="currentColor"
        fontFamily="Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="36"
        fontWeight="800"
        letterSpacing="-2"
      >
        dosco
      </text>
      <rect x="60" y="48" width="22" height="2" fill="#f97316" />
    </svg>
  );
}
