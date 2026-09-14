/**
 * FloatingTabBar — the Android and web root tab bar. iOS uses the system tab
 * bar instead (see `app/(tabs)/_layout.tsx`); this bar mirrors its look.
 *
 * One floating capsule (60pt, `FLOATING_BAR_HEIGHT`), centred above the home
 * indicator. Each tab stacks its icon over its label, and a pill thumb
 * slides behind the active tab. The light capsule is `bg-background` with a
 * soft shadow; the dark one is `bg-card` with a border, because a shadow does
 * not read on a dark ground. Both tabs keep foreground icons and labels; the
 * thumb alone marks the selection, as on iOS.
 *
 * Motion is deliberately minimal — tab switching is a high-frequency action:
 * a single 220ms ease-out-quint translateX on the thumb (transform-only,
 * interruptible; reduced motion snaps instead). Press feedback is a 0.96
 * scale driven by shared values — a function `style` on a classNamed
 * Pressable is silently dropped by css-interop, so it can't live there.
 * Slides down behind the keyboard, same as the dock.
 *
 * Screens under this bar are full-height; pad their scroll content with
 * `useTabBarClearance()` from `tab-bar-layout` so the last rows never sit
 * under the capsule.
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
import { useColorScheme } from 'nativewind';

import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { FLOATING_BAR_GAP, FLOATING_BAR_HEIGHT } from '@/components/navigation/tab-bar-layout';

type TabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

// House motion tokens: the dock's ease-out-quint family, shortened for a
// small on-screen move; press curves are the dock circle's exact values.
const SLIDE = { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const PRESS_IN = { duration: 90, easing: Easing.out(Easing.quad) };
const PRESS_OUT = { duration: 140, easing: Easing.out(Easing.quad) };

/** Soft lift for the light capsule, from the foreground token. */
const LIGHT_SHADOW = `0px 6px 24px ${withAlpha(THEME.light.foreground, 0.12)}`;

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
      className="h-full w-24 items-center justify-center rounded-full">
      <Reanimated.View style={contentStyle} className="items-center justify-center gap-0.5">
        {icon}
        {/* 12px label, like the iOS tab bar. leading-4 (16px) stays above
            Roobert's natural 1.264em line box (15.2px at 12px); below it iOS
            keeps the descender and pushes the glyphs up, so the label drifts
            off the icon's centre line. */}
        <Text variant="small" className="text-xs leading-4 text-foreground">
          {label}
        </Text>
      </Reanimated.View>
    </Pressable>
  );
}

export function FloatingTabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

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
      style={[barStyle, { bottom: insets.bottom + FLOATING_BAR_GAP }]}
      className="absolute inset-x-0 items-center">
      <View
        className={`rounded-full p-1 ${isDark ? 'border border-border bg-card' : 'bg-background'}`}
        style={{ height: FLOATING_BAR_HEIGHT, boxShadow: isDark ? undefined : LIGHT_SHADOW }}>
        <View
          className="relative h-full flex-row"
          onLayout={(e) => setSegmentWidth(e.nativeEvent.layout.width / state.routes.length)}>
          {segmentWidth > 0 ? (
            <Reanimated.View
              style={[thumbStyle, { width: segmentWidth }]}
              className="absolute bottom-0 left-0 top-0 rounded-full bg-secondary"
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
                icon={options.tabBarIcon?.({ focused, color: '', size: 20 })}
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
