/**
 * SessionDotMatrix — the busy indicator's glyph.
 *
 * Mirrors apps/web `components/ui/dot-matrix/session-dot-matrix.tsx`: the
 * session id hashes (FNV-1a) onto one of 52 dot-matrix animations, so each
 * session keeps one glyph for its whole life, the same one web shows. No
 * session id → `dotm-square-14`.
 *
 * The animations are pure functions of elapsed time (`lib/session/dot-matrix`),
 * which cannot run as worklets (they close over Maps, Sets and helper
 * functions). So the JS thread samples the glyph once per mount into a track,
 * and a `useFrameCallback` on the UI thread only advances a sample index;
 * every dot reads its own cell in a `useAnimatedStyle`. No per-frame JS work,
 * no React render. Reduce Motion → web's idle frame, no loop.
 * `LoopMotionContext` false → the glyph holds its current frame.
 */

import { memo, useContext, useEffect, useMemo, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { LoopMotionContext } from '@/components/kortix/text-shimmer';
import { useTurnPalette } from '@/components/session/tool/shared/styles';
import {
  dotMatrixTrack,
  dotMatrixLayout,
  sessionDotMatrixVariant,
  trackSampleIndex,
  type DotMatrixTrack,
} from '@/lib/session/dot-matrix';

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

function SessionDotMatrixImpl({ sessionId, size = 14, color, style }: SessionDotMatrixProps) {
  const palette = useTurnPalette();
  const still = useReduceMotion();
  const loopMotion = useContext(LoopMotionContext);
  const looping = !still && loopMotion;
  const entry = useMemo(() => sessionDotMatrixVariant(sessionId), [sessionId]);
  const layout = dotMatrixLayout(entry, size);
  // Hidden cells are a fixed mask per glyph (pinned by dot-matrix.test.ts),
  // so they are simply not rendered.
  const visible = useMemo(() => entry.frame(0, true).map((value) => value !== null), [entry]);
  const built = dotMatrixTrack(entry, still);
  const track = useSharedValue<DotMatrixTrack>(built);
  const sample = useSharedValue(0);
  const clock = useSharedValue(0);

  // The initial value covers the first render; hand the UI thread a new table
  // only when the glyph or Reduce Motion changes.
  const synced = useRef(built);
  useEffect(() => {
    if (synced.current === built) return;
    synced.current = built;
    track.value = built;
    sample.value = 0;
    clock.value = 0;
  }, [built, track, sample, clock]);

  const loop = useFrameCallback((info) => {
    'worklet';
    clock.value += info.timeSincePreviousFrame ?? 0;
    const next = trackSampleIndex(track.value.periodMs, clock.value);
    if (next !== sample.value) sample.value = next;
  }, looping);
  useEffect(() => {
    loop.setActive(looping);
  }, [loop, looping]);

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
            track={track}
            sample={sample}
            cells={layout.grid * layout.grid}
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
  track,
  sample,
  cells: expectedCells,
  left,
  top,
  size,
  color,
}: {
  index: number;
  track: SharedValue<DotMatrixTrack>;
  sample: SharedValue<number>;
  cells: number;
  left: number;
  top: number;
  size: number;
  color: string;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const { data, cells } = track.value;
    // The table lags one frame behind a glyph change; hide rather than misindex.
    return { opacity: cells === expectedCells ? (data[sample.value * cells + index] ?? 0) : 0 };
  });
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
