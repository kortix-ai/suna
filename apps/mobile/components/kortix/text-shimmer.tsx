/**
 * TextShimmer — the "still going" label: a highlight band sweeping across text.
 *
 * Mirrors apps/web `components/ui/text-shimmer.tsx`:
 * - text painted in a base colour, a highlight band on top, clipped to the glyphs;
 * - background 250% of the text width, `background-position` 100% → 0% linear
 *   over `duration` (2s), then a 0.5s hold, looping;
 * - band half-width (`--spread`) = text length × `spread` px (2px);
 * - reduced motion: base colour only, no sweep.
 *
 * The text width is MEASURED (`onLayout` on the real label), never estimated
 * from the character count, so the sweep covers exactly the rendered glyphs,
 * including a truncated line.
 *
 * Tones:
 * - `default` — web's hard-coded ramp: light `#a1a1aa` → `#000`, dark
 *   `#71717a` → `#fff`. `#000` / `#fff` are the `foreground` tokens; the two
 *   zinc greys have no token and live ONLY in `SHIMMER_BASE` below.
 * - `muted` — the burst summary line: `muted-foreground` at 55% → `muted-foreground`.
 */

import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { SHIMMER, shimmerBandCenter, shimmerSpread } from '@/lib/session/activity';
import { THEME, withAlpha } from '@/lib/utils/theme';

/**
 * Web's shimmer base greys. No THEME token has these values (muted-foreground
 * is hsl(0 0% 40%) / hsl(0 0% 60%)), so they are named here, once.
 */
const SHIMMER_BASE = {
  light: 'hsl(240 5% 64.9%)', // hex-allowlist: web text-shimmer `#a1a1aa` (zinc-400) = hsl(240 5% 64.9%)
  dark: 'hsl(240 3.8% 46.1%)', // hex-allowlist: web text-shimmer `#71717a` (zinc-500) = hsl(240 3.8% 46.1%)
} as const;

export type TextShimmerTone = 'default' | 'muted';

type TextVariant = ComponentProps<typeof Text>['variant'];

export interface TextShimmerProps {
  children: string;
  /** The closest `Text` variant; `style` overrides size, leading, and weight. */
  variant?: TextVariant;
  /** Typography of the label. Same style is applied to the mask. */
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  tone?: TextShimmerTone;
  /** Sweep duration in seconds (web `duration`, default 2). */
  duration?: number;
  /** Band half-width per character in px (web `spread`, default 2). */
  spread?: number;
  /** Layout of the wrapper (flex, min width). */
  containerStyle?: StyleProp<ViewStyle>;
}

function shimmerColors(tone: TextShimmerTone, isDark: boolean) {
  const t = isDark ? THEME.dark : THEME.light;
  if (tone === 'muted') {
    return { base: withAlpha(t.mutedForeground, 0.55), highlight: t.mutedForeground };
  }
  return { base: isDark ? SHIMMER_BASE.dark : SHIMMER_BASE.light, highlight: t.foreground };
}

function TextShimmerImpl({
  children,
  variant,
  style,
  numberOfLines,
  tone = 'default',
  duration = SHIMMER.sweepMs / 1000,
  spread = SHIMMER.spreadPerChar,
  containerStyle,
}: TextShimmerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const reduceMotion = useReducedMotion();
  const { base, highlight } = useMemo(() => shimmerColors(tone, isDark), [tone, isDark]);
  const band = shimmerSpread(children, spread);

  const [measured, setMeasured] = useState(false);
  const width = useSharedValue(0);
  const progress = useSharedValue(0);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.value = event.nativeEvent.layout.width;
      if (!measured && event.nativeEvent.layout.width > 0) setMeasured(true);
    },
    [measured, width],
  );

  useEffect(() => {
    if (reduceMotion) return;
    const sweepMs = duration * 1000;
    progress.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 0 }),
        withTiming(1, { duration: sweepMs, easing: Easing.linear }),
        // web `kx-shimmer-sweep-hold`: the hold is 25% of the sweep (0.5s at 2s).
        withTiming(1, { duration: sweepMs * (SHIMMER.holdMs / SHIMMER.sweepMs) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [duration, progress, reduceMotion]);

  const bandStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerBandCenter(progress.value, width.value) - band }],
  }));

  const animate = measured && !reduceMotion;

  return (
    <View style={[styles.container, containerStyle]}>
      {/* The measuring label. It paints the base colour until the overlay has a
          width to draw into, then steps aside so glyph edges are drawn once. */}
      <Text
        variant={variant}
        style={[style, { color: animate ? 'transparent' : base }]}
        numberOfLines={numberOfLines}
        onLayout={onLayout}
      >
        {children}
      </Text>
      {animate && (
        <MaskedView
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          maskElement={
            // Only the mask's alpha is read, so any opaque token works.
            <Text variant={variant} style={[style, { color: THEME.light.foreground }]} numberOfLines={numberOfLines}>
              {children}
            </Text>
          }
        >
          <View style={[StyleSheet.absoluteFill, { backgroundColor: base }]} />
          <Animated.View style={[styles.band, { width: band * 2 }, bandStyle]}>
            <LinearGradient
              colors={[withAlpha(highlight, 0), highlight, withAlpha(highlight, 0)]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </MaskedView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexShrink: 1, minWidth: 0 },
  band: { position: 'absolute', top: 0, bottom: 0, left: 0 },
});

export const TextShimmer = memo(TextShimmerImpl);
TextShimmer.displayName = 'TextShimmer';
