import { useEffect } from 'react';
import {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  interpolate,
  Easing,
} from 'react-native-reanimated';

interface BackgroundScaleConfig {
  scaleValue?: number;
  borderRadius?: number;
  enableShadow?: boolean;
}

export function useBackgroundScale(
  isOpen: boolean,
  config: BackgroundScaleConfig = {}
) {
  const {
    scaleValue = 0.95,
    borderRadius = 24,
    enableShadow = true,
  } = config;

  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(isOpen ? 1 : 0, {
      duration: 250,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
  }, [isOpen, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(progress.value, [0, 1], [1, scaleValue]);
    const borderRadiusValue = interpolate(progress.value, [0, 1], [0, borderRadius]);
    const opacity = interpolate(progress.value, [0, 1], [1, 0.97]);
    
    return {
      transform: [{ scale }],
      borderRadius: borderRadiusValue,
      opacity,
      overflow: 'hidden',
      ...(enableShadow && {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: interpolate(progress.value, [0, 1], [0, 0.3]),
        shadowRadius: interpolate(progress.value, [0, 1], [0, 20]),
        elevation: interpolate(progress.value, [0, 1], [0, 10]),
      }),
    };
  });

  const containerAnimatedStyle = useAnimatedStyle(() => {
    // Use a slight exponential curve for smoother fade
    const opacity = interpolate(
      progress.value, 
      [0, 0.3, 1], 
      [0, 0.15, 0.4]
    );
    return {
      backgroundColor: `rgba(0, 0, 0, ${opacity})`,
    };
  });

  return {
    animatedStyle,
    containerAnimatedStyle,
    progress,
  };
}
