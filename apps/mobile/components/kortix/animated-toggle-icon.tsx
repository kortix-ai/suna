/**
 * AnimatedToggleIcon — cross-fades + rotates between a base icon and an X
 * (or any close icon) based on an `open` flag. Used by page headers so the
 * left hamburger / right drawer icons flip to X when the drawer is open.
 *
 * Originally lived inline in SessionPage.tsx; extracted for reuse across
 * the unified PageHeader.
 */

import * as React from 'react';
import { useEffect } from 'react';
import { View } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import { XIcon, type AppIcon } from '@/lib/icons';
import { Icon } from '@/components/ui/icon';

export interface AnimatedToggleIconProps {
  /** True → rotates/fades to the close icon. */
  open: boolean;
  /** Base icon color. */
  color: string;
  /** The base icon, from `@/lib/icons`. */
  icon: AppIcon;
  /** Icon + container size. Defaults to 24. */
  size?: number;
}

export function AnimatedToggleIcon({
  open,
  color,
  icon,
  size = 24,
}: AnimatedToggleIconProps) {
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, { duration: 220 });
  }, [open, progress]);

  const baseStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    opacity: interpolate(progress.value, [0, 1], [1, 0]),
    transform: [{ rotate: `${interpolate(progress.value, [0, 1], [0, 90])}deg` }],
  }));

  const closeStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ rotate: `${interpolate(progress.value, [0, 1], [-90, 0])}deg` }],
  }));

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Reanimated.View style={baseStyle}>
        <Icon as={icon} size={size} color={color} />
      </Reanimated.View>
      <Reanimated.View style={closeStyle}>
        <Icon as={XIcon} size={size} color={color} />
      </Reanimated.View>
    </View>
  );
}
