/**
 * scroll-fade — the page background fading in over the two ends of a scroll
 * view, so rows leave the screen softly instead of being cut by an edge. The
 * project drawer's fades, as components (Jay, 2026-09-21/22).
 *
 *   const { onScroll, topFadeStyle } = useScrollFade();
 *   <View className="flex-1">
 *     <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} … />
 *     <TopFade style={topFadeStyle} />
 *     <BottomFade />
 *   </View>
 *
 * - `BottomFade` is always there: the last `BOTTOM_FADE_HEIGHT` plus the
 *   safe-area inset. Pad the scroll content by that much, so the last row can
 *   rest above it.
 * - `TopFade` is invisible while the list rests at its top, where nothing is
 *   behind the header to fade. It comes in over the first `TOP_FADE_HEIGHT` of
 *   scroll, so a row passing under the search field dissolves instead of being
 *   cut. Overscroll (a negative offset, iOS bounce) keeps it hidden.
 *
 * Both take no touches. The gradient runs from the background at full alpha to
 * the SAME colour at zero alpha. Never fade to `transparent`: that is black at
 * zero alpha, and Android draws a grey band through the middle of the gradient.
 */
import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { THEME, withAlpha } from '@/lib/utils/theme';

/** The bottom gradient's height above the safe-area inset. */
export const BOTTOM_FADE_HEIGHT = 56;
/** The top gradient's height, and the scroll distance over which it comes in. */
export const TOP_FADE_HEIGHT = 24;

function usePageBackground(): string {
  const { colorScheme } = useColorScheme();
  return colorScheme === 'dark' ? THEME.dark.background : THEME.light.background;
}

/** The scroll handler for an `Animated.ScrollView`, and the top fade's style. */
export function useScrollFade() {
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const topFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, TOP_FADE_HEIGHT], [0, 1], Extrapolation.CLAMP),
  }));
  return { onScroll, topFadeStyle };
}

export function TopFade({ style }: { style: StyleProp<AnimatedStyle<StyleProp<ViewStyle>>> }) {
  const background = usePageBackground();
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: TOP_FADE_HEIGHT }, style]}>
      <LinearGradient
        colors={[withAlpha(background, 1), withAlpha(background, 0)]}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

export function BottomFade() {
  const insets = useSafeAreaInsets();
  const background = usePageBackground();
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-0 bottom-0"
      style={{ height: BOTTOM_FADE_HEIGHT + insets.bottom }}>
      <LinearGradient
        colors={[withAlpha(background, 0), withAlpha(background, 0.9), withAlpha(background, 1)]}
        locations={[0, 0.6, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
