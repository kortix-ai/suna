import { useCallback } from 'react';
import { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { MOTION } from '@/lib/utils/theme';

/**
 * Press feedback for a tappable surface that is not a `Button` (an attachment
 * tile, a mention chip): scale down while pressed, back on release. apps/web
 * gives the same surfaces `active:scale-[0.96]` / `active:scale-[0.97]`.
 */
export function usePressScale(pressedScale: number, duration: number = MOTION.duration.fast) {
  const pressed = useSharedValue(0);
  const easing = Easing.bezier(...MOTION.easing.default);

  const onPressIn = useCallback(() => {
    pressed.value = withTiming(1, { duration, easing });
    // `easing` is a worklet object rebuilt per render; the timing values are constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressed, duration]);

  const onPressOut = useCallback(() => {
    pressed.value = withTiming(0, { duration, easing });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressed, duration]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - pressedScale) * pressed.value }],
  }));

  return { onPressIn, onPressOut, animatedStyle, pressed };
}
