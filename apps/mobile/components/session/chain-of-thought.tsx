/**
 * ChainOfThought — a vertical list of steps, each opening independently.
 *
 * Mirrors apps/web `components/ui/chain-of-thought.tsx` and the animation of
 * `components/ui/disclosure.tsx`:
 * - `ChainOfThought`: `space-y-3` and nothing else — the gap sits BETWEEN rows.
 * - `ChainOfThoughtStep`: `relative`, plus a 1px rail (`bg-muted-foreground/15`,
 *   `left-2`, `top-[1.6rem]`, `bottom-0`) drawn ONLY while the step has open
 *   content. Web asks that twice — the step's own `data-state` and
 *   `has-[[data-state=open]]` on any descendant. React Native has no descendant
 *   selectors, so every disclosure inside a step reports its open state up
 *   through `useReportOpen`, and a step reports its own rail state to the step
 *   around it.
 * - `DisclosureContent`: height 0 → content height with opacity, then unmounts
 *   when closed (web `AnimatePresence initial={false}`: a row that mounts open
 *   does not animate). At rest open the body is never height-capped (web
 *   Motion ends on `height: auto`), so content that grows later is never clipped.
 * - `DisclosureCaret`: `CaretRight` rotating 90° when open (`transition-transform`).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { CaretRightIcon } from '@/lib/icons';
import { disclosureBodyMaxHeight } from '@/lib/session/activity';
import { MOTION } from '@/lib/utils/theme';
import { TURN_SPACE, useTurnPalette } from '@/components/session/tool/shared/styles';

// ─── Open-state reporting ────────────────────────────────────────────────────

type ReportOpen = (id: string, open: boolean) => void;

const ChainOpenContext = createContext<ReportOpen | null>(null);

/**
 * Tells the nearest `ChainOfThoughtStep` that this disclosure is open, so the
 * step draws its rail. A no-op outside a chain.
 */
export function useReportOpen(open: boolean) {
  const report = useContext(ChainOpenContext);
  const id = useId();
  useEffect(() => {
    report?.(id, open);
  }, [report, id, open]);
  useEffect(() => () => report?.(id, false), [report, id]);
}

// ─── Chain ───────────────────────────────────────────────────────────────────

export function ChainOfThought({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ rowGap: TURN_SPACE.gap3 }, style]}>{children}</View>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

export function ChainOfThoughtStep({ children }: { children: ReactNode }) {
  const palette = useTurnPalette();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  const report = useCallback<ReportOpen>((id, open) => {
    setOpenIds((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const active = openIds.size > 0;
  // A nested step is open content of the step around it.
  useReportOpen(active);

  return (
    <ChainOpenContext.Provider value={report}>
      <View style={{ position: 'relative' }}>
        {active && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: TURN_SPACE.railTop,
              bottom: 0,
              left: TURN_SPACE.railLeft,
              width: 1,
              backgroundColor: palette.rail,
            }}
          />
        )}
        {children}
      </View>
    </ChainOpenContext.Provider>
  );
}

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
