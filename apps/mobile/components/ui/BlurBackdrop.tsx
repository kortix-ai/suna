import React from 'react';
import { StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Animated, { 
  useAnimatedStyle, 
  interpolate, 
  Extrapolate 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

/**
 * BlurBackdrop - Custom backdrop with blur effect
 * Used as a backdrop component for drawers throughout the app
 */
export function BlurBackdrop({ animatedIndex, style }: BottomSheetBackdropProps) {
  const { colorScheme } = useColorScheme();
  
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      animatedIndex.value,
      [-1, 0],
      [0, 1],
      Extrapolate.CLAMP
    ),
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, animatedStyle, style]}>
      <BlurView
        intensity={20}
        tint={colorScheme === 'dark' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

