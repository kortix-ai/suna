'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

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
  medium: 40,
  large: 80,
  xlarge: 120,
} as const;

/**
 * KortixLoader - A unified loading animation component
 * 
 * Uses separate Lottie animations (white and black) that dynamically load
 * based on the current theme or can be explicitly set.
 * 
 * **Automatic Behavior:**
 * - Light mode → Black loader (for white backgrounds)
 * - Dark mode → White loader (for dark backgrounds)
 * 
 * **Manual Override (for special cases):**
 * Use the `variant` prop when the background doesn't match the theme.
 * For example, a dark button in light mode needs `variant="white"`.
 * 
 * **Files:**
 * - loading-white.json: White loader (for dark backgrounds)
 * - loading-black.json: Black loader (for light backgrounds)
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
  const { resolvedTheme } = useTheme();
  const loaderSize = customSize || SIZE_MAP[size];
  
  // Track mounted state to prevent hydration mismatch
  const [mounted, setMounted] = React.useState(false);

  // Set mounted on client
  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Determine which variant to use
  let effectiveVariant: 'white' | 'black';
  
  if (variant !== 'auto') {
    // Explicit variant set
    effectiveVariant = variant;
  } else if (forceTheme) {
    // Backwards compatibility with forceTheme
    effectiveVariant = forceTheme === 'dark' ? 'white' : 'black';
  } else {
    // Auto-detect from theme
    const isDark = (resolvedTheme || 'dark') === 'dark';
    effectiveVariant = isDark ? 'white' : 'black';
  }

  // Don't render Lottie during SSR - render a simple placeholder instead
  // This prevents any hydration mismatches
  if (!mounted) {
    return (
      <div 
        className={cn('flex items-center justify-center', className)} 
        style={style}
      >
        <div 
          style={{ 
            width: loaderSize, 
            height: loaderSize 
          }} 
        />
      </div>
    );
  }

  // Dynamically import Lottie only on client-side
  return (
    <div className={cn('flex items-center justify-center', className)} style={style}>
      <LottieAnimation
        loaderSize={loaderSize}
        loop={loop}
        autoPlay={autoPlay}
        variant={effectiveVariant}
        speed={speed}
      />
    </div>
  );
}

// Separate client-only Lottie component
function LottieAnimation({
  loaderSize,
  loop,
  autoPlay,
  variant,
  speed,
}: {
  loaderSize: number;
  loop: boolean;
  autoPlay: boolean;
  variant: 'white' | 'black';
  speed: number;
}) {
  const lottieRef = React.useRef<any>(null);
  const [Lottie, setLottie] = React.useState<any>(null);
  const [animationData, setAnimationData] = React.useState<any>(null);

  // Dynamically import Lottie and correct animation based on variant
  React.useEffect(() => {
    // Reset animation data when variant changes
    setAnimationData(null);
    
    Promise.all([
      import('lottie-react'),
      variant === 'white'
        ? import('@/assets/animations/loading-white.json')
        : import('@/assets/animations/loading-black.json')
    ]).then(([lottieModule, animData]) => {
      setLottie(() => lottieModule.default);
      setAnimationData(animData.default);
    });
  }, [variant]); // Reload when variant changes

  // Ensure animation starts from beginning when loaded
  React.useEffect(() => {
    if (lottieRef.current) {
      lottieRef.current.goToAndPlay(0, true);
      lottieRef.current.setSpeed(speed);
    }
  }, [animationData, speed]);

  // Show placeholder while loading
  if (!Lottie || !animationData) {
    return (
      <div 
        style={{ 
          width: loaderSize, 
          height: loaderSize 
        }} 
      />
    );
  }

  return (
    <Lottie
      lottieRef={lottieRef}
      animationData={animationData}
      loop={loop}
      autoplay={autoPlay}
      style={{ 
        width: loaderSize, 
        height: loaderSize
      }}
    />
  );
}

