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
  const lottieRef = React.useRef<any>(null);
  
  // Determine which theme to use
  const effectiveTheme = forceTheme || resolvedTheme;

  // Ensure animation starts from beginning
  React.useEffect(() => {
    if (lottieRef.current) {
      lottieRef.current.goToAndPlay(0, true);
    }
  }, []);

  return (
    <div className={cn('flex items-center justify-center', className)} style={style}>
      <Lottie
        lottieRef={lottieRef}
        animationData={animationData}
        loop={loop}
        autoplay={autoPlay}
        style={{ 
          width: loaderSize, 
          height: loaderSize,
          // Default animation is white, so we use brightness(0) to make it black in light mode
          // In dark mode, we keep it white (no filter)
          filter: effectiveTheme === 'dark' ? 'none' : 'brightness(0)'
        }}
      />
    </div>
  );
}

