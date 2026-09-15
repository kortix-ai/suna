/**
 * ShimmerText — gradient sweep shimmer effect on text.
 * Used for status indicators while AI is working.
 */

import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, interpolate } from 'react-native-reanimated';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { THEME, withAlpha } from '@/lib/utils/theme';

const ReAnimated = Animated;

interface ShimmerTextProps {
  text: string;
  size?: 'sm' | 'xs';
}

export function ShimmerText({ text, size = 'sm' }: ShimmerTextProps) {
  const shimmerPosition = useSharedValue(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  useEffect(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, { duration: 2000, easing: Easing.linear }),
      -1,
      false,
    );
  }, []);

  const animatedGradientStyle = useAnimatedStyle(() => {
    const translateX = interpolate(shimmerPosition.value, [0, 1], [-200, 200]);
    return { transform: [{ translateX }] };
  });

  const textColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  // The sweep is a WHITE highlight in BOTH themes -- deliberate, not a theme bug.
  // `THEME.light.background` is the only token that is exactly `hsl(0 0% 100%)`,
  // so it is the white base here; the two alpha steps are unchanged.
  const shimmerColor = withAlpha(THEME.light.background, isDark ? 0.2 : 0.35);
  const fontSize = size === 'xs' ? 12 : 14;
  const lineHeight = size === 'xs' ? 16 : 20;

  return (
    <View style={{ justifyContent: 'center' }}>
      <MaskedView
        maskElement={
          <Text
            style={{
              fontSize,
              lineHeight,
              fontFamily: 'Roobert',
              color: '#000', // hex-allowlist: MaskedView stencil, never rendered -- only the mask's alpha channel is read, so any opaque value works.
            }}
          >
            {text}
          </Text>
        }
      >
        <View style={{ width: Math.max(text.length * (fontSize * 0.6), 80), height: lineHeight }}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: textColor }]} />
          <ReAnimated.View style={[StyleSheet.absoluteFill, { width: 200 }, animatedGradientStyle]}>
            <LinearGradient
              colors={[textColor, shimmerColor, textColor]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{ flex: 1, width: 200 }}
            />
          </ReAnimated.View>
        </View>
      </MaskedView>
    </View>
  );
}
