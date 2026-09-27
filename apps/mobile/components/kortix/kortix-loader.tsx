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

// The shipped animation is white. Light mode needs a black loader, and
// lottie-react-native's colorFilters keypath matching is unreliable across
// platforms/versions (the loader rendered white-on-white in light mode), so
// recolor the animation data itself — deterministic on every renderer.
const WHITE_SOURCE = require('@/components/animations/loading.json');

function recolorLottie(source: unknown, rgb: [number, number, number]) {
  const clone = JSON.parse(JSON.stringify(source));
  const walk = (node: any) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      // 'fl' = fill, 'st' = stroke; static colors keep their alpha channel.
      if ((node.ty === 'fl' || node.ty === 'st') && Array.isArray(node.c?.k)) {
        node.c.k = node.c.k.length > 3 ? [...rgb, node.c.k[3]] : [...rgb];
      }
      Object.values(node).forEach(walk);
    }
  };
  walk(clone);
  return clone;
}

const BLACK_SOURCE = recolorLottie(WHITE_SOURCE, [0, 0, 0]);

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

  // Determine which theme to use: white loader on dark, black loader on light.
  const effectiveTheme = forceTheme || colorScheme;
  const source = effectiveTheme === 'dark' ? WHITE_SOURCE : BLACK_SOURCE;

  return (
    <View className={cn('items-center justify-center', className)} style={style}>
      <LottieView
        // Remount when the theme flips — LottieView doesn't reliably reload
        // a changed `source` in place.
        key={effectiveTheme}
        ref={lottieRef}
        source={source}
        style={{ width: loaderSize, height: loaderSize }}
        autoPlay={autoPlay}
        loop={loop}
        speed={speed}
      />
    </View>
  );
}

