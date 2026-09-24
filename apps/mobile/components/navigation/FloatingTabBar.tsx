/**
 * FloatingTabCapsule — the floating capsule of the old Android/web root tab
 * bar, kept as the app's segmented switcher for sheets and pages (the
 * project/account switcher, the model picker, Review). The root tab bar
 * itself is gone (COR-161): the project drawer's switcher is the one
 * navigation between accounts and projects.
 *
 * One capsule (60pt, `FLOATING_BAR_HEIGHT`). Each item stacks its icon over
 * its label, and a pill thumb slides behind the active item. The light
 * capsule is `bg-background` with a soft shadow; the dark one is `bg-card`
 * with a border, because a shadow does not read on a dark ground.
 *
 * Motion is deliberately minimal — switching is a high-frequency action: a
 * single 220ms ease-out-quint translateX on the thumb (transform-only,
 * interruptible; reduced motion snaps instead). Press feedback is a 0.96
 * scale driven by shared values — a function `style` on a classNamed
 * Pressable is silently dropped by css-interop, so it can't live there.
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { FLOATING_BAR_HEIGHT } from '@/components/navigation/tab-bar-layout';

// House motion tokens: the house ease-out-quint family, shortened for a
// small on-screen move; press curves match the house press-scale values.
const SLIDE = { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const PRESS_IN = { duration: 90, easing: Easing.out(Easing.quad) };
const PRESS_OUT = { duration: 140, easing: Easing.out(Easing.quad) };

/** Soft lift for the light capsule, from the foreground token. */
/** Soft shadow for a light floating surface. The composer does not use it (design.md §5). */
export const LIGHT_SHADOW = `0px 6px 24px ${withAlpha(THEME.light.foreground, 0.12)}`;

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
 * sliding behind the active tab, icon over a 12px label. Any sheet or page
 * that switches between views draws it (the project/account switcher, Jay
 * 2026-09-23) — one look everywhere.
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
