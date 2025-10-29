'use client';

import * as React from 'react';
import Lottie from 'lottie-react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import animationData from '@/assets/animations/loading.json';

interface KortixLoaderProps {
  /**
   * Size preset for the loader
   * @default 'medium'
   */
  size?: 'small' | 'medium' | 'large' | 'xlarge';
  /**
   * Animation speed multiplier
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
   * Force a specific color (overrides theme)
   * Use 'light' or 'dark' to force a specific theme color
   */
  forceTheme?: 'light' | 'dark';
}

const SIZE_MAP = {
  small: 20,
  medium: 40,
  large: 80,
  xlarge: 120,
} as const;

/**
 * KortixLoader - A unified loading animation component
 * 
 * Uses the Lottie animation for consistent loading indicators across the app.
 * Automatically adapts to light/dark mode with appropriate colors.
 * Can be used as a replacement for Loader2 with better visual appeal.
 * 
 * **Theme Support:**
 * - Light mode: Black loader
 * - Dark mode: White loader
 * 
 * @example
 * ```tsx
 * // Simple usage (auto-themed)
 * <KortixLoader />
 * 
 * // Custom size
 * <KortixLoader size="large" />
 * 
 * // Force dark theme (white loader)
 * <KortixLoader forceTheme="dark" />
 * 
 * // With custom styling
 * <KortixLoader className="my-4" customSize={60} />
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
  forceTheme,
}: KortixLoaderProps) {
  const { resolvedTheme } = useTheme();
  const loaderSize = customSize || SIZE_MAP[size];
  
  // Determine which theme to use
  const effectiveTheme = forceTheme || resolvedTheme;
  
  // Create color filter based on theme
  // The Lottie is originally white, we invert for light mode
  const colorFilter = React.useMemo(() => {
    if (effectiveTheme === 'dark') {
      // Keep white for dark mode
      return undefined;
    }
    // Black for light mode
    return 'invert(1)';
  }, [effectiveTheme]);

  return (
    <div className={cn('flex items-center justify-center', className)} style={style}>
      <div style={{ width: loaderSize, height: loaderSize, filter: colorFilter, opacity: 1 }}>
        <Lottie
          animationData={animationData}
          loop={loop}
          autoplay={autoPlay}
          style={{ width: loaderSize, height: loaderSize, opacity: 1 }}
        />
      </div>
    </div>
  );
}

