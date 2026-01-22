import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, View, ViewStyle } from 'react-native';
import { easeGradient } from 'react-native-easing-gradient';
import { useColorScheme } from 'nativewind';
import { getBackgroundColor } from '@agentpress/shared';

interface BlurFadeHeaderProps {
  height?: number;
  intensity?: number;
  style?: ViewStyle;
  children?: React.ReactNode;
}

export function BlurFadeHeader({
  height = 120,
  intensity = 80,
  style,
  children,
}: BlurFadeHeaderProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';

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

  if (!isIOS) {
    return (
      <View style={[styles.container, { backgroundColor: getBackgroundColor(Platform.OS, colorScheme), height }, style]}>
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
