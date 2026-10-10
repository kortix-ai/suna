/**
 * One collapsible section: a title row with a caret, and its content below
 * while open. Items open independently (web's `type="multiple"`).
 *
 * Motion: the caret turns 180° in 200 ms on a strong ease-out (the curve of
 * `sheet-push.tsx`); Reduce Motion snaps it. The content appears without a
 * height animation: height is a layout property, and the row is tapped often.
 */
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CaretDownIcon } from '@/lib/icons';

/** 200 ms is `MOTION.duration.moderate`; `lib/utils/theme` is not imported, it loads expo-router. */
const CARET_TURN = { duration: 200, easing: Easing.bezier(0.23, 1, 0.32, 1) };

export function AccordionItem({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const reducedMotion = useReducedMotion();
  const turn = useSharedValue(defaultOpen ? 180 : 0);
  const caret = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    turn.value = reducedMotion ? (next ? 180 : 0) : withTiming(next ? 180 : 0, CARET_TURN);
  };

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      >
        <Text className="flex-1">{title}</Text>
        <Animated.View style={caret}>
          <Icon as={CaretDownIcon} size={16} className="text-muted-foreground" />
        </Animated.View>
      </Pressable>
      {open ? <View className="gap-3 px-4 pb-4">{children}</View> : null}
    </View>
  );
}
