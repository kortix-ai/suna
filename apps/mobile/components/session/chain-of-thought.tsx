/**
 * Disclosure primitives — the opening body and caret of a disclosure row.
 *
 * Mirrors apps/web `components/ui/chain-of-thought.tsx` and the animation of
 * `components/ui/disclosure.tsx`:
 * - `DisclosureContent`: height 0 → content height with opacity, then unmounts
 *   when closed (web `AnimatePresence initial={false}`: a row that mounts open
 *   does not animate). At rest open the body is never height-capped (web
 *   Motion ends on `height: auto`), so content that grows later is never clipped.
 * - `DisclosureCaret`: `CaretRight` rotating 90° when open (`transition-transform`).
 */

import { TURN_SPACE } from '@/components/session/tool/shared/styles';
import { CaretRightIcon } from '@/lib/icons';
import { disclosureBodyMaxHeight } from '@/lib/session/activity';
import { MOTION } from '@/lib/utils/theme';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// ─── Disclosure body ─────────────────────────────────────────────────────────

/**
 * Web Motion's default tween for `height`/`opacity` is 0.3s; the nearest
 * MOTION tokens are `slow` (300ms) on the `default` curve.
 */
const EXPAND_TIMING = {
  duration: MOTION.duration.slow,
  easing: Easing.bezier(...MOTION.easing.default),
};

export function DisclosureContent({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  // The wrapper's `maxHeight` is `content height × progress` while it moves and
  // uncapped at rest (`disclosureBodyMaxHeight`). The decision runs on the UI
  // thread from `progress` alone, so the body is uncapped on the very frame the
  // open animation lands — nested opens, streamed steps, and markdown re-layout
  // grow it without waiting on a JS round trip. Content height is re-measured on
  // every layout, so a close always starts from the current height.
  const [mounted, setMounted] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);
  const contentHeight = useSharedValue(0);
  const openRef = useRef(open);
  openRef.current = open;
  const firstRun = useRef(true);

  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) setMounted(true);
  }

  const unmountIfClosed = useCallback(() => {
    if (!openRef.current) setMounted(false);
  }, []);

  useEffect(() => {
    // A row that mounts open or closed does not animate (web `initial={false}`).
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    progress.value = withTiming(open ? 1 : 0, EXPAND_TIMING, (finished) => {
      if (finished && !open) runOnJS(unmountIfClosed)();
    });
  }, [open, progress, unmountIfClosed]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      contentHeight.value = event.nativeEvent.layout.height;
    },
    [contentHeight],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    maxHeight: disclosureBodyMaxHeight(progress.value, contentHeight.value),
    opacity: Math.min(1, Math.max(0, progress.value)),
  }));

  if (!mounted) return null;

  return (
    <Animated.View style={[{ overflow: 'hidden' }, animatedStyle]}>
      {/* `flexShrink: 0`: the capped wrapper clips this view, never squeezes it,
          so `onLayout` always reports the full content height. */}
      <View onLayout={onLayout} style={{ flexShrink: 0 }}>
        {children}
      </View>
    </Animated.View>
  );
}

// ─── Caret ───────────────────────────────────────────────────────────────────

/** Tailwind `transition-transform` default: 150ms, cubic-bezier(0.4, 0, 0.2, 1). */
const CARET_TIMING = {
  duration: MOTION.duration.normal,
  easing: Easing.bezier(...MOTION.easing.inOut),
};

export function DisclosureCaret({ open, color }: { open: boolean; color: string }) {
  const rotation = useSharedValue(open ? 90 : 0);
  useEffect(() => {
    rotation.value = withTiming(open ? 90 : 0, CARET_TIMING);
  }, [open, rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={[{ flexShrink: 0 }, style]}>
      <CaretRightIcon size={TURN_SPACE.caret} color={color} />
    </Animated.View>
  );
}
