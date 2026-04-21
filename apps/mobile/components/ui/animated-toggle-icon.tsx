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
import { Ionicons } from '@expo/vector-icons';
import { Menu as MenuIcon, X as CloseIcon } from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';

export type AnimatedToggleIconName = keyof typeof Ionicons.glyphMap | 'menu-lucide';

export interface AnimatedToggleIconProps {
  /** True → rotates/fades to the close icon. */
  open: boolean;
  /** Base icon color. */
  color: string;
  /** Which base icon to render. 'menu-lucide' uses the lucide Menu + X pair;
   *  any other value is passed to Ionicons. */
  icon: AnimatedToggleIconName;
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

  const renderBase = () => {
    if (icon === 'menu-lucide') {
      return <Icon as={MenuIcon} size={size} color={color} strokeWidth={2} />;
    }
    return <Ionicons name={icon} size={size} color={color} />;
  };

  const renderClose = () => {
    if (icon === 'menu-lucide') {
      return <Icon as={CloseIcon} size={size} color={color} strokeWidth={2} />;
    }
    return <Ionicons name="close" size={size} color={color} />;
  };

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Reanimated.View style={baseStyle}>{renderBase()}</Reanimated.View>
      <Reanimated.View style={closeStyle}>{renderClose()}</Reanimated.View>
    </View>
  );
}
