/**
 * SessionDotMatrix — the busy indicator's glyph.
 *
 * Mirrors apps/web `components/ui/dot-matrix/session-dot-matrix.tsx`: the
 * session id hashes (FNV-1a) onto one of 52 dot-matrix animations, so each
 * session keeps one glyph for its whole life, the same one web shows. No
 * session id → `dotm-square-14`.
 *
 * The animations are pure functions of elapsed time (`lib/session/dot-matrix`).
 * A `requestAnimationFrame` loop computes each frame on the JS thread and
 * writes it into one shared value; every dot reads its own entry in a
 * `useAnimatedStyle`, so a frame costs no React render. Reduce Motion → web's
 * idle frame, no loop.
 */

import { memo, useEffect, useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { useTurnPalette } from '@/components/session/tool/shared/styles';
import { dotMatrixLayout, sessionDotMatrixVariant, type DotFrame } from '@/lib/session/dot-matrix';

import { useReduceMotion } from './use-reduce-motion';

export interface SessionDotMatrixProps {
  /** Picks the glyph. Absent → `dotm-square-14`. */
  sessionId?: string;
  /** Box size in px (web `size`). The busy indicator passes 14. */
  size?: number;
  /** Dot colour. Default: `muted-foreground` (web `currentColor` in the muted row). */
  color?: string;
  style?: StyleProp<ViewStyle>;
}

function toOpacities(frame: DotFrame): number[] {
  return frame.map((value) => value ?? 0);
}

function SessionDotMatrixImpl({ sessionId, size = 14, color, style }: SessionDotMatrixProps) {
  const palette = useTurnPalette();
  const still = useReduceMotion();
  const entry = useMemo(() => sessionDotMatrixVariant(sessionId), [sessionId]);
  const layout = dotMatrixLayout(entry, size);
  // Hidden cells are a fixed mask per glyph (pinned by dot-matrix.test.ts),
  // so they are simply not rendered.
  const visible = useMemo(() => entry.frame(0, true).map((value) => value !== null), [entry]);
  const frame = useSharedValue<number[]>(toOpacities(entry.frame(0, still)));

  useEffect(() => {
    frame.value = toOpacities(entry.frame(0, still));
    if (still) return;
    const start = performance.now();
    let handle = requestAnimationFrame(function tick(now) {
      frame.value = toOpacities(entry.frame(now - start, false));
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, [entry, frame, still]);

  const dotColor = color ?? palette.mutedForeground;
  const pitch = layout.track + layout.gap;

  return (
    <View
      style={[{ width: layout.span, height: layout.span, flexShrink: 0 }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {visible.map((show, index) =>
        show ? (
          <Dot
            key={index}
            index={index}
            frame={frame}
            left={(index % layout.grid) * pitch}
            top={Math.floor(index / layout.grid) * pitch}
            size={layout.dotSize}
            color={dotColor}
          />
        ) : null,
      )}
    </View>
  );
}

function Dot({
  index,
  frame,
  left,
  top,
  size,
  color,
}: {
  index: number;
  frame: SharedValue<number[]>;
  left: number;
  top: number;
  size: number;
  color: string;
}) {
  const animatedStyle = useAnimatedStyle(() => ({ opacity: frame.value[index] ?? 0 }));
  return (
    <Animated.View
      style={[
        { position: 'absolute', left, top, width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        animatedStyle,
      ]}
    />
  );
}

export const SessionDotMatrix = memo(SessionDotMatrixImpl);
SessionDotMatrix.displayName = 'SessionDotMatrix';
