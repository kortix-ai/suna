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
 * Hides while the keyboard is up (150ms fade + slide down, 200ms back). Driven by
 * React Native `Keyboard` events, not react-native-keyboard-controller: its
 * `useReanimatedKeyboardAnimation` can report an open keyboard while it is
 * closed on some Android devices (upstream #864), which faded this bar to 0
 * and slid it off-screen on one test phone.
 *
 * A scroll-edge fade sits behind the capsule, like the iOS 26 tab bar: the
 * theme background from transparent (36pt above the capsule) to opaque at
 * the screen edge. Content fades out instead of stopping at a hard line, and
 * the system navigation area blends into the same colour (3-button phones
 * draw a contrast scrim there).
 *
 * Screens under this bar are full-height; pad their scroll content with
 * `useTabBarClearance()` from `tab-bar-layout` so the last rows never sit
 * under the capsule.
 */
import * as React from 'react';
import { Keyboard, Pressable, StyleSheet, View } from 'react-native';
import type { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';

import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { FLOATING_BAR_GAP, FLOATING_BAR_HEIGHT } from '@/components/navigation/tab-bar-layout';

type TabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

// House motion tokens: the house ease-out-quint family, shortened for a
// small on-screen move; press curves match the house press-scale values.
const SLIDE = { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const PRESS_IN = { duration: 90, easing: Easing.out(Easing.quad) };
const PRESS_OUT = { duration: 140, easing: Easing.out(Easing.quad) };
// Hide faster than it returns: the keyboard is already covering the bar.
const KEYBOARD_HIDE = { duration: 150, easing: Easing.out(Easing.quad) };
const KEYBOARD_SHOW = { duration: 200, easing: Easing.bezier(0.23, 1, 0.32, 1) };

/** Soft lift for the light capsule, from the foreground token. */
/** Soft shadow for a light floating surface. The composer does not use it (design.md §5). */
export const LIGHT_SHADOW = `0px 6px 24px ${withAlpha(THEME.light.foreground, 0.12)}`;

/** How far the scroll-edge fade reaches above the capsule. */
const FADE_ABOVE_BAR = 36;

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

/** One tab of a `FloatingTabCapsule`: icon over label. */
export interface FloatingTabItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * FloatingTabCapsule — the tab bar's capsule on its own: 60pt, a pill thumb
 * sliding behind the active tab, icon over a 12px label. The root tab bar
 * draws it, and so does any sheet that switches between views the same way
 * (the project/account switcher, Jay 2026-09-23) — one look for both.
 */
export function FloatingTabCapsule({
  items,
  activeIndex,
  onSelect,
  onLongPress,
}: {
  items: FloatingTabItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onLongPress?: (index: number) => void;
}) {
  const reduced = useReducedMotion();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [segmentWidth, setSegmentWidth] = React.useState(0);
  const thumbX = useSharedValue(0);
  const settled = React.useRef(false);

  React.useEffect(() => {
    if (segmentWidth <= 0) return;
    const target = activeIndex * segmentWidth;
    if (!settled.current || reduced) {
      thumbX.value = target;
      settled.current = true;
    } else {
      thumbX.value = withTiming(target, SLIDE);
    }
  }, [activeIndex, segmentWidth, reduced, thumbX]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: thumbX.value }] }));

  return (
    <View
      className={`rounded-full p-1 ${isDark ? 'border border-border bg-card' : 'bg-background'}`}
      style={{ height: FLOATING_BAR_HEIGHT, boxShadow: isDark ? undefined : LIGHT_SHADOW }}>
      <View
        className="relative h-full flex-row"
        onLayout={(e) => setSegmentWidth(e.nativeEvent.layout.width / Math.max(items.length, 1))}>
        {segmentWidth > 0 ? (
          <Reanimated.View
            style={[thumbStyle, { width: segmentWidth }]}
            className="absolute bottom-0 left-0 top-0 rounded-full bg-secondary"
          />
        ) : null}
        {items.map((item, index) => (
          <TabItem
            key={item.key}
            label={item.label}
            icon={item.icon}
            focused={index === activeIndex}
            reduced={reduced}
            onPress={() => onSelect(index)}
            onLongPress={() => onLongPress?.(index)}
          />
        ))}
      </View>
    </View>
  );
}

export function FloatingTabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // 0 = keyboard closed, 1 = open. See the header comment for why this uses
  // React Native Keyboard events.
  const keyboardShown = useSharedValue(0);
  React.useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      keyboardShown.value = withTiming(1, KEYBOARD_HIDE);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardShown.value = withTiming(0, KEYBOARD_SHOW);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [keyboardShown]);
  const hiddenOffset = insets.bottom + FLOATING_BAR_GAP + FLOATING_BAR_HEIGHT;

  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: keyboardShown.value * hiddenOffset }],
    opacity: 1 - keyboardShown.value,
  }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: 1 - keyboardShown.value }));

  const background = isDark ? THEME.dark.background : THEME.light.background;
  const fadeColors = [
    withAlpha(background, 0),
    withAlpha(background, 0.85),
    withAlpha(background, 1),
  ] as const;
  const fadeHeight = insets.bottom + FLOATING_BAR_GAP + FLOATING_BAR_HEIGHT + FADE_ABOVE_BAR;

  const items: FloatingTabItem[] = state.routes.map((route, index) => {
    const { options } = descriptors[route.key];
    return {
      key: route.key,
      label: options.title ?? route.name,
      icon: options.tabBarIcon?.({ focused: state.index === index, color: '', size: 20 }),
    };
  });

  const onSelect = (index: number) => {
    const route = state.routes[index];
    const focused = state.index === index;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) {
      haptics.selection();
      navigation.navigate(route.name, route.params);
    }
  };

  const onLongPress = (index: number) => {
    navigation.emit({ type: 'tabLongPress', target: state.routes[index].key });
  };

  return (
    <>
      {/* Scroll-edge fade behind the capsule (see header comment). */}
      <Reanimated.View
        pointerEvents="none"
        style={[fadeStyle, { height: fadeHeight }]}
        className="absolute inset-x-0 bottom-0">
        <LinearGradient colors={fadeColors} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
      </Reanimated.View>

      <Reanimated.View
        pointerEvents="box-none"
        style={[barStyle, { bottom: insets.bottom + FLOATING_BAR_GAP }]}
        className="absolute inset-x-0 items-center">
        <FloatingTabCapsule items={items} activeIndex={state.index} onSelect={onSelect} onLongPress={onLongPress} />
      </Reanimated.View>
    </>
  );
}
