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
export function BlurFooter({
  height = 100,
  intensity = 80,
  style,
  children,
}: BlurFooterProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';
  
  const bgColor = React.useMemo(
    () => getBackgroundColor(Platform.OS, colorScheme),
    [colorScheme]
  );

  const getRGBA = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: 'transparent' },
      0.01: { color: getRGBA(bgColor, 0.2) },
      0.03: { color: getRGBA(bgColor, 0.4) },
      0.06: { color: getRGBA(bgColor, 0.65) },
      0.1: { color: getRGBA(bgColor, 0.85) },
      0.15: { color: getRGBA(bgColor, 0.95) },
      0.2: { color: getRGBA(bgColor, 1) },
      1: { color: getRGBA(bgColor, 1) },
    },
  });

  if (!isIOS) {
    return (
      <View style={[styles.container, { height }, style]}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: getBackgroundColor(Platform.OS, colorScheme) }]} />
        {children}
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }, style]}>
      <MaskedView
        maskElement={
          <LinearGradient
            locations={locations as unknown as [number, number, number]}
            colors={colors as [string, string, string]}
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
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
});
