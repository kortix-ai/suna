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
 *
 * Drag (iOS tab-bar style): press and slide horizontally anywhere on the
 * capsule and the thumb lifts (1.12 scale), follows the finger, ticks a
 * selection haptic on each segment it crosses, and on release springs to the
 * nearest segment with the finger's velocity, then selects it. Vertical
 * movement fails the pan, so a sheet's own drag still wins; a tap never
 * reaches it (6pt slop) and stays with the item's Pressable.
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useColorScheme } from 'nativewind';

import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { FLOATING_BAR_HEIGHT } from '@/components/navigation/tab-bar-layout';
import {
  LIQUID_GLASS_AVAILABLE,
  LiquidGlassCapsule,
} from '@/components/kortix/liquid-glass-capsule';

// House motion tokens: the house ease-out-quint family, shortened for a
// small on-screen move; press curves match the house press-scale values.
const SLIDE = { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const PRESS_IN = { duration: 90, easing: Easing.out(Easing.quad) };
const PRESS_OUT = { duration: 140, easing: Easing.out(Easing.quad) };
// Drag: the thumb settles with no overshoot (same spring as the thinking
// slider in ModelPickerSheet); the lift has a little give, like a lens.
const SNAP_SPRING = { duration: 300, dampingRatio: 1 };
const LIFT_SPRING = { duration: 260, dampingRatio: 0.8 };
const LIFT_SCALE = 1.12;

/** Soft shadow for a light floating surface, from the foreground token. The
 * composer does not use it (design.md §5). */
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
 *
 * `glass` (KRTX-2928): on iOS 26+ the capsule is Liquid Glass
 * (`LiquidGlassCapsule`) instead of the opaque `background`/`card` fill, its
 * shadow and its border. Android and older iOS keep the opaque capsule. The
 * switcher sheets (account/project, agent/model) and Review's segment bar pass it.
 */
export function FloatingTabCapsule({
  items,
  activeIndex,
  onSelect,
  onLongPress,
  glass = false,
}: {
  items: FloatingTabItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onLongPress?: (index: number) => void;
  /** Liquid Glass capsule where the platform supports it. */
  glass?: boolean;
}) {
  const reduced = useReducedMotion();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [segmentWidth, setSegmentWidth] = React.useState(0);
  const thumbX = useSharedValue(0);
  const lift = useSharedValue(0);
  const grab = useSharedValue(0);
  const hoverIndex = useSharedValue(activeIndex);
  const settled = React.useRef(false);
  // Index a drag just released onto: the thumb is already springing there
  // with the finger's velocity, so the activeIndex effect must not restart it.
  const draggedTo = React.useRef<number | null>(null);

  const commit = React.useCallback(
    (index: number) => {
      draggedTo.current = index;
      onSelect(index);
    },
    [onSelect]
  );

  React.useEffect(() => {
    if (segmentWidth <= 0) return;
    const target = activeIndex * segmentWidth;
    if (draggedTo.current === activeIndex) {
      draggedTo.current = null;
      return;
    }
    draggedTo.current = null;
    if (!settled.current || reduced) {
      thumbX.value = target;
      settled.current = true;
    } else {
      thumbX.value = withTiming(target, SLIDE);
    }
  }, [activeIndex, segmentWidth, reduced, thumbX]);

  const count = items.length;
  const pan = React.useMemo(() => {
    const max = Math.max(0, (count - 1) * segmentWidth);
    const nearest = (x: number) => {
      'worklet';
      return segmentWidth > 0 ? Math.min(count - 1, Math.max(0, Math.round(x / segmentWidth))) : 0;
    };
    return Gesture.Pan()
      .enabled(segmentWidth > 0 && count > 1)
      .activeOffsetX([-6, 6])
      .failOffsetY([-12, 12])
      .onStart((e) => {
        // Grabbing the thumb keeps the finger where it touched it; grabbing
        // elsewhere centres the thumb under the finger.
        const onThumb = e.x >= thumbX.value && e.x <= thumbX.value + segmentWidth;
        grab.value = onThumb ? e.x - thumbX.value : segmentWidth / 2;
        hoverIndex.value = nearest(thumbX.value);
        if (!reduced) lift.value = withSpring(1, LIFT_SPRING);
      })
      .onUpdate((e) => {
        thumbX.value = Math.min(max, Math.max(0, e.x - grab.value));
        const index = nearest(thumbX.value);
        if (index !== hoverIndex.value) {
          hoverIndex.value = index;
          scheduleOnRN(haptics.selection);
        }
      })
      .onFinalize((e, success) => {
        const index = nearest(thumbX.value);
        const target = index * segmentWidth;
        thumbX.value = reduced
          ? target
          : withSpring(target, { ...SNAP_SPRING, velocity: e.velocityX });
        lift.value = reduced ? 0 : withSpring(0, LIFT_SPRING);
        if (success && index !== activeIndex) scheduleOnRN(commit, index);
      });
  }, [count, segmentWidth, reduced, activeIndex, commit, thumbX, lift, grab, hoverIndex]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value }, { scale: 1 + (LIFT_SCALE - 1) * lift.value }],
  }));

  const glassy = glass && LIQUID_GLASS_AVAILABLE;
  const surface = glassy ? '' : isDark ? 'border border-border bg-card' : 'bg-background';
  return (
    <View
      className={`rounded-full p-1 ${surface}`}
      style={{
        height: FLOATING_BAR_HEIGHT,
        boxShadow: glassy || isDark ? undefined : LIGHT_SHADOW,
      }}>
      {glassy ? <LiquidGlassCapsule /> : null}
      <GestureDetector gesture={pan}>
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
      </GestureDetector>
    </View>
  );
}
