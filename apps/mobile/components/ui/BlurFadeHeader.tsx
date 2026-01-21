import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, View, ViewStyle } from 'react-native';
import { easeGradient } from 'react-native-easing-gradient';
import { useColorScheme } from 'nativewind';

interface BlurFadeHeaderProps {
  height?: number;
  intensity?: number;
  style?: ViewStyle;
  children?: React.ReactNode;
}

/**
 * BlurFadeHeader - A reusable header component with progressive blur fade effect
 * 
 * iOS: Uses MaskedView + BlurView for native blur with gradient fade
 * Android: Uses LinearGradient fallback (BlurView doesn't work well on Android)
 * 
 * @param height - Height of the header (default: 120)
 * @param intensity - Blur intensity for iOS (default: 15)
 * @param style - Additional styles to apply to the container
 * @param children - Content to render inside the header
 */
export function BlurFadeHeader({
  height = 120,
  intensity = 80,
  style,
  children,
}: BlurFadeHeaderProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: 'rgba(255, 255, 255, 1)' },
      0.75: { color: 'rgba(255, 255, 255, 1)' },
      0.82: { color: 'rgba(255, 255, 255, 0.9)' },
      0.88: { color: 'rgba(255, 255, 255, 0.7)' },
      0.92: { color: 'rgba(255, 255, 255, 0.5)' },
      0.95: { color: 'rgba(255, 255, 255, 0.3)' },
      0.98: { color: 'rgba(255, 255, 255, 0.15)' },
      1: { color: 'transparent' },
    },
  });

  if (Platform.OS !== 'ios') {
    return (
      <View style={[styles.container, { height }, style]}>
        <LinearGradient
          colors={
            isDark
              ? ['rgba(18, 18, 21, 0.98)', 'rgba(18, 18, 21, 0.85)', 'rgba(18, 18, 21, 0.3)', 'rgba(18, 18, 21, 0)']
              : ['rgba(248, 248, 248, 0.98)', 'rgba(248, 248, 248, 0.85)', 'rgba(248, 248, 248, 0.3)', 'rgba(248, 248, 248, 0)']
          }
          locations={[0, 0.6, 0.85, 1]}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }, style]}>
      <MaskedView
        maskElement={
          <LinearGradient
            locations={locations as number[]}
            colors={colors as string[]}
            style={StyleSheet.absoluteFill}
          />
        }
        style={StyleSheet.absoluteFill}
      >
        <BlurView
          intensity={intensity}
          tint={isDark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
      </MaskedView>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
});
