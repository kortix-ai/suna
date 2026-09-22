/**
 * Todo status glyphs.
 *
 * Mirrors apps/web `tool/shared/todo-helpers.tsx` on the shared
 * `STATUS_RING` geometry (16-unit box, r 6.3, stroke 1.5): 
 * - completed — a `text-kortix-green` disc with the check KNOCKED OUT
 *   (`M4.4 8.3 L6.9 10.8 L11.6 5.2`, stroke 1.75, lifted 0.25);
 * - cancelled — a `text-muted-foreground/40` disc with the 45° bar knocked out;
 * - pending — a dashed ring (`3 3.4`) in `text-muted-foreground`;
 * - in_progress — web `Loading variant="ring"`: a 25% track with an arc that
 *   orbits, in `text-kortix-orange`. The arc keeps a fixed length (web's arc
 *   also breathes via `stroke-dashoffset`).
 *
 * `size` replaces web's `className` size override (`size-4` default).
 */

import { useEffect, useId } from 'react';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, cancelAnimation } from 'react-native-reanimated';
import Svg, { Circle, Defs, Mask, Path } from 'react-native-svg';
import { TURN_SPACE, useTurnPalette } from './styles';

export { parseTodos, type TodoItem } from '@/lib/session/tool-output-parsers';
import type { TodoItem } from '@/lib/session/tool-output-parsers';

export const STATUS_RING = { BOX: 16, CENTER: 8, RADIUS: 6.3, STROKE: 1.5, DASH: 3, GAP: 3.4 } as const;
export const STATUS_RING_OUTER_RADIUS = STATUS_RING.RADIUS + STATUS_RING.STROKE / 2;

const MARK_STROKE = 1.75;
const CHECK_PATH = 'M4.4 8.3 L6.9 10.8 L11.6 5.2';
const CHECK_OPTICAL_LIFT = 'translate(0 -0.25)';
const CANCEL_PATH = 'M5.1 10.9 L10.9 5.1';
/** `animate-spinner-orbit` period. */
const ORBIT_MS = 1000;

function KnockoutDisc({ path, transform, color, size, maskId }: { path: string; transform?: string; color: string; size: number; maskId: string }) {
  const box = `0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}`;
  return (
    <Svg width={size} height={size} viewBox={box}>
      <Defs>
        <Mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={STATUS_RING.BOX} height={STATUS_RING.BOX}>
          {/* hex-allowlist: mask luminance values — white keeps, black cuts; never painted. */}
          <Circle cx={STATUS_RING.CENTER} cy={STATUS_RING.CENTER} r={STATUS_RING_OUTER_RADIUS} fill="white" />
          <Path d={path} transform={transform} stroke="black" strokeWidth={MARK_STROKE} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </Mask>
      </Defs>
      <Circle cx={STATUS_RING.CENTER} cy={STATUS_RING.CENTER} r={STATUS_RING_OUTER_RADIUS} fill={color} mask={`url(#${maskId})`} />
    </Svg>
  );
}

function OrbitRing({ color, size }: { color: string; size: number }) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: ORBIT_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rotation);
  }, [rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  const circumference = 2 * Math.PI * STATUS_RING.RADIUS;
  return (
    <Animated.View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox={`0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}`}>
        <Circle cx={STATUS_RING.CENTER} cy={STATUS_RING.CENTER} r={STATUS_RING.RADIUS} stroke={color} strokeOpacity={0.25} strokeWidth={STATUS_RING.STROKE} fill="none" />
        <Circle
          cx={STATUS_RING.CENTER}
          cy={STATUS_RING.CENTER}
          r={STATUS_RING.RADIUS}
          stroke={color}
          strokeWidth={STATUS_RING.STROKE}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.3} ${circumference}`}
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}

export function TodoStatusIcon({ status, size = TURN_SPACE.icon, color }: { status: TodoItem['status']; size?: number; color?: string }) {
  const palette = useTurnPalette();
  const maskId = `todo-glyph-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  switch (status) {
    case 'completed':
      return <KnockoutDisc maskId={maskId} path={CHECK_PATH} transform={CHECK_OPTICAL_LIFT} color={color ?? palette.kortixGreen} size={size} />;
    case 'in_progress':
      return <OrbitRing color={color ?? palette.kortixOrange} size={size} />;
    case 'cancelled':
      return <KnockoutDisc maskId={maskId} path={CANCEL_PATH} color={color ?? palette.muted40} size={size} />;
    case 'pending':
      return (
        <Svg width={size} height={size} viewBox={`0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}`}>
          <Circle
            cx={STATUS_RING.CENTER}
            cy={STATUS_RING.CENTER}
            r={STATUS_RING.RADIUS}
            stroke={color ?? palette.mutedForeground}
            fill="none"
            strokeWidth={STATUS_RING.STROKE}
            strokeDasharray={`${STATUS_RING.DASH} ${STATUS_RING.GAP}`}
          />
        </Svg>
      );
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
