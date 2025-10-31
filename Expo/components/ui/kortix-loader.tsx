import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import LottieView from 'lottie-react-native';
import { useColorScheme } from 'nativewind';
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
  style?: ViewStyle;
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
   * Ref to control the Lottie animation
   */
  lottieRef?: React.RefObject<LottieView>;
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
 * Can be used as a replacement for ActivityIndicator with better visual appeal.
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
 * // With ref for manual control
 * const lottieRef = useRef<LottieView>(null);
 * <KortixLoader lottieRef={lottieRef} autoPlay={false} />
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
  lottieRef,
  forceTheme,
}: KortixLoaderProps) {
  const { colorScheme } = useColorScheme();
  const loaderSize = customSize || SIZE_MAP[size];
  
  // Determine which theme to use
  const effectiveTheme = forceTheme || colorScheme;
  
  // Apply color filter based on theme
  // The Lottie is originally white, we invert for light mode
  const colorFilters = effectiveTheme === 'dark' 
    ? undefined // Keep white for dark mode
    : [
        {
          keypath: 'Shape Layer 1',
          color: '#000000', // Black for light mode
        },
        {
          keypath: 'Shape Layer 2',
          color: '#000000',
        },
        {
          keypath: 'Shape Layer 3',
          color: '#000000',
        },
        {
          keypath: 'Shape Layer 4',
          color: '#000000',
        },
      ];

  return (
    <View className={cn('items-center justify-center', className)} style={style}>
      <LottieView
        ref={lottieRef}
        source={require('@/components/animations/loading.json')}
        style={{ width: loaderSize, height: loaderSize }}
        autoPlay={autoPlay}
        loop={loop}
        speed={speed}
        colorFilters={colorFilters}
      />
    </View>
  );
}

