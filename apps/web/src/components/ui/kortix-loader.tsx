'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface KortixLoaderProps {
  /**
   * Size preset for the loader
   * @default 'medium'
   */
  size?: 'small' | 'medium' | 'large' | 'xlarge';
  /**
   * Animation speed multiplier (affects spin duration)
   * @default 1.2
   */
  speed?: number;
  /**
   * Custom size in pixels (overrides size preset)
   */
  customSize?: number;
  /**
   * Additional className for the container
   */
  className?: string;
  /**
   * Additional style for the container
   */
  style?: React.CSSProperties;
  /**
   * Whether the animation should autoPlay
   * @default true
   */
  autoPlay?: boolean;
  /**
   * Whether the animation should loop
   * @default true
   */
  loop?: boolean;
  /**
   * Force a specific loader variant (overrides auto-detection)
   * - 'white': White loader (for dark backgrounds)
   * - 'black': Black loader (for light backgrounds)
   * - 'auto': Auto-detect based on theme (default)
   */
  variant?: 'white' | 'black' | 'auto';
  /**
   * @deprecated Use 'variant' instead
   */
  forceTheme?: 'light' | 'dark';
}

const SIZE_MAP = {
  small: 20,
  medium: 24,
  large: 32,
  xlarge: 40,
} as const;

/**
 * KortixLoader - A unified circular loading animation component
 *
 * Uses a CSS-based circular spinner that adapts to light/dark themes.
 *
 * **Automatic Behavior:**
 * - Light mode → Black loader (for white backgrounds)
 * - Dark mode → White loader (for dark backgrounds)
 *
 * **Manual Override (for special cases):**
 * Use the `variant` prop when the background doesn't match the theme.
 * For example, a dark button in light mode needs `variant="white"`.
 *
 * @example
 * ```tsx
 * // Auto-themed (default)
 * <KortixLoader />
 *
 * // Always white (for dark backgrounds in any theme)
 * <KortixLoader variant="white" />
 *
 * // Always black (for light backgrounds in any theme)
 * <KortixLoader variant="black" />
 *
 * // Custom size
 * <KortixLoader size="large" />
 * ```
 */
export function KortixLoader({
  size = 'medium',
  speed = 1.2,
  customSize,
  className,
  style,
  autoPlay = true,
  loop = true,
  variant = 'auto',
  forceTheme, // deprecated, but kept for backwards compatibility
}: KortixLoaderProps) {
  const loaderSize = customSize || SIZE_MAP[size];

  // Explicit variant (or the deprecated forceTheme) pins the colors; otherwise
  // the theme decides — via the `.dark` CSS class next-themes sets before first
  // paint, so the loader renders on the server and hydrates without the old
  // mounted-gate flicker (SSR used to paint an empty box for one frame).
  let forcedVariant: 'white' | 'black' | null = null;
  if (variant !== 'auto') {
    forcedVariant = variant;
  } else if (forceTheme) {
    forcedVariant = forceTheme === 'dark' ? 'white' : 'black';
  }

  // Calculate border width based on size (roughly 1/16 of the size, min 2px)
  const borderWidth = Math.max(2, Math.round(loaderSize / 16));

  // Calculate animation duration based on speed (lower = faster)
  const animationDuration = 0.8 / speed;

  return (
    <div
      className={cn('flex items-center justify-center', className)}
      style={style}
    >
      <div
        className={
          forcedVariant === null
            ? 'border-[rgba(0,0,0,0.1)] border-t-[#000000] dark:border-[rgba(255,255,255,0.15)] dark:border-t-[#ffffff]'
            : undefined
        }
        style={{
          width: loaderSize,
          height: loaderSize,
          borderStyle: 'solid',
          borderWidth,
          ...(forcedVariant !== null && {
            borderColor:
              forcedVariant === 'white'
                ? 'rgba(255, 255, 255, 0.15)'
                : 'rgba(0, 0, 0, 0.1)',
            borderTopColor: forcedVariant === 'white' ? '#ffffff' : '#000000',
          }),
          borderRadius: '50%',
          animation:
            autoPlay && loop
              ? `kortix-spin ${animationDuration}s linear infinite`
              : autoPlay
                ? `kortix-spin ${animationDuration}s linear`
                : 'none',
        }}
      />
    </div>
  );
}
