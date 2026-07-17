/**
 * FloatingTabBar — the root tab bar, in the dock's visual language.
 *
 * One floating capsule for both platforms (bg-card + border, h-12 — the
 * ProjectDock's exact geometry), centered above the home indicator, with a
 * thumb that slides behind the active tab. Replaces the default iOS bar and
 * the old hardcoded-color Android pill.
 *
 * Motion is deliberately minimal — tab switching is a high-frequency action:
 * a single 220ms ease-out-quint translateX on the thumb (transform-only,
 * interruptible; reduced motion snaps instead). Press feedback is a 0.96
 * scale driven by shared values — a function `style` on a classNamed
 * Pressable is silently dropped by css-interop, so it can't live there.
 * Slides down behind the keyboard, same as the dock.
 *
 * Screens under this bar are full-height; pad their scroll content with
 * `useTabBarClearance()` so the last rows never sit under the capsule.
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';

import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';

type TabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

/** h-12 — must stay equal to the dock's pill/circle height. */
const BAR_HEIGHT = 48;
/** Gap between the capsule and the home indicator — matches the dock. */
const BAR_GAP = 8;

// House motion tokens: the dock's ease-out-quint family, shortened for a
// small on-screen move; press curves are the dock circle's exact values.
const SLIDE = { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const PRESS_IN = { duration: 90, easing: Easing.out(Easing.quad) };
const PRESS_OUT = { duration: 140, easing: Easing.out(Easing.quad) };

/** Bottom padding for scroll content on tab screens, so lists clear the bar. */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + BAR_GAP + BAR_HEIGHT + 24;
}

function TabItem({
  label,
  icon,
  focused,
  reduced,
  onPress,
  onLongPress,
}: {
  label: string;
  icon: React.ReactNode;
  focused: boolean;
  reduced: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const scale = useSharedValue(1);
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePressIn = React.useCallback(() => {
    if (reduced) return;
    scale.value = withTiming(0.96, PRESS_IN);
  }, [scale, reduced]);

  const handlePressOut = React.useCallback(() => {
    if (reduced) return;
    scale.value = withTiming(1, PRESS_OUT);
  }, [scale, reduced]);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      hitSlop={{ top: 8, bottom: 8 }}
      className="h-full w-28 items-center justify-center rounded-full">
      <Reanimated.View style={contentStyle} className="flex-row items-center justify-center gap-1.5">
        {icon}
        <Text variant="small" className={focused ? 'text-foreground' : 'text-muted-foreground'}>
          {label}
        </Text>
      </Reanimated.View>
    </Pressable>
  );
}

export function FloatingTabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();

  const [segmentWidth, setSegmentWidth] = React.useState(0);
  const thumbX = useSharedValue(0);
  const settled = React.useRef(false);

  // Same trick as the dock: RNKC's height animates 0 → -keyboardHeight, so
  // negating it slides the bar DOWN behind the keyboard while it fades.
  const { height: kbHeight, progress: kbProgress } = useReanimatedKeyboardAnimation();

  React.useEffect(() => {
    if (segmentWidth <= 0) return;
    const target = state.index * segmentWidth;
    if (!settled.current || reduced) {
      thumbX.value = target;
      settled.current = true;
    } else {
      thumbX.value = withTiming(target, SLIDE);
    }
  }, [state.index, segmentWidth, reduced, thumbX]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: thumbX.value }] }));
  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -kbHeight.value }],
    opacity: 1 - kbProgress.value,
  }));

  return (
    <Reanimated.View
      pointerEvents="box-none"
      style={[barStyle, { bottom: insets.bottom + BAR_GAP }]}
      className="absolute inset-x-0 items-center">
      <View className="h-12 rounded-full border border-border bg-card p-1">
        <View
          className="relative h-full flex-row"
          onLayout={(e) => setSegmentWidth(e.nativeEvent.layout.width / state.routes.length)}>
          {segmentWidth > 0 ? (
            <Reanimated.View
              style={[thumbStyle, { width: segmentWidth }]}
              className="absolute bottom-0 left-0 top-0 rounded-full border border-border/70 bg-background dark:bg-secondary"
            />
          ) : null}

          {state.routes.map((route, index) => {
            const { options } = descriptors[route.key];
            const focused = state.index === index;
            const label = options.title ?? route.name;

            const onPress = () => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                haptics.selection();
                navigation.navigate(route.name, route.params);
              }
            };

            const onLongPress = () => {
              navigation.emit({ type: 'tabLongPress', target: route.key });
            };

            return (
              <TabItem
                key={route.key}
                label={label}
                icon={options.tabBarIcon?.({ focused, color: '', size: 17 })}
                focused={focused}
                reduced={reduced}
                onPress={onPress}
                onLongPress={onLongPress}
              />
            );
          })}
        </View>
      </View>
    </Reanimated.View>
  );
}
