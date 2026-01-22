import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, View, ViewStyle } from 'react-native';
import { easeGradient } from 'react-native-easing-gradient';
import { useColorScheme } from 'nativewind';
import { getBackgroundColor } from '@agentpress/shared';

interface BlurFooterProps {
  height?: number;
  intensity?: number;
  style?: ViewStyle;
  children?: React.ReactNode;
}

/**
 * BlurFooter - A reusable footer component with progressive blur fade effect
 * 
 * REVERSED gradient: transparent (top) → solid (bottom)
 * Opposite of BlurFadeHeader
 * 
 * iOS: Uses MaskedView + BlurView for native blur with gradient fade
 * Android: Uses LinearGradient fallback (BlurView doesn't work well on Android)
 * 
 * @param height - Height of the footer (default: 100)
 * @param intensity - Blur intensity for iOS (default: 80)
 * @param style - Additional styles to apply to the container
 * @param children - Content to render inside the footer
 */
export function BlurFooter({
  height = 100,
  intensity = 80,
  style,
  children,
}: BlurFooterProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  // Get platform-specific background color
  const bgColor = React.useMemo(
    () => getBackgroundColor(Platform.OS, colorScheme),
    [colorScheme]
  );

  // Extract RGB values from hex color for gradient
  const getRGBA = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // REVERSED gradient: transparent at top (0) → solid at bottom (1)
  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: 'transparent' },           // Top: transparent
      0.02: { color: getRGBA(bgColor, 0.15) },
      0.05: { color: getRGBA(bgColor, 0.3) },
      0.08: { color: getRGBA(bgColor, 0.5) },
      0.12: { color: getRGBA(bgColor, 0.7) },
      0.18: { color: getRGBA(bgColor, 0.9) },
      0.25: { color: getRGBA(bgColor, 1) },  // Solid starts here
      1: { color: getRGBA(bgColor, 1) },     // Bottom: solid
    },
  });

  if (Platform.OS !== 'ios') {
    // Android fallback with reversed gradient using platform colors
    return (
      <View style={[styles.container, { height }, style]}>
        <LinearGradient
          colors={[
            getRGBA(bgColor, 0),
            getRGBA(bgColor, 0.3),
            getRGBA(bgColor, 0.85),
            getRGBA(bgColor, 0.98),
          ]}
          locations={[0, 0.15, 0.4, 1]}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </View>
    );
  }

  // iOS with MaskedView + BlurView
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
        <View 
          style={[
            StyleSheet.absoluteFill, 
            { backgroundColor: bgColor, opacity: 0.85 } 
          ]} 
        />
      </MaskedView>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,  // Position at bottom instead of top
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
});
