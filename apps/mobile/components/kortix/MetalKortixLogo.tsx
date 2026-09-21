/**
 * MetalKortixLogo — the Kortix symbol as liquid metal that catches the light
 * when the phone moves (Jay, 2026-09-21).
 *
 * Paper's `Heatmap` shader, ported to SkSL (`lib/effects/heatmap-sksl.ts`) and
 * drawn by Skia, so one code path serves iOS and Android. Paper's own build is
 * WebGL and cannot run in React Native. Dark is Paper's design exactly as
 * exported (`Heatmap`, contour 1, inner glow 0.89, white and near-black,
 * transparent back). Light is its own palette on the same shader, not a copy of
 * dark, because Paper's white vanishes on a white page.
 *
 * It moves only while the phone moves, and costs nothing at rest:
 *  - There is no frame loop. Reanimated's rotation sensor (built in; not
 *    `expo-sensors`) feeds a reaction that retargets a spring only when the
 *    target changes. When the spring settles, no value changes and Skia draws
 *    nothing.
 *  - Movement is measured against a baseline that follows the phone with a 1.5 s
 *    time constant, so holding the phone upright (about 60 degrees from flat)
 *    is rest, and a quick move away from that pose is the input. Held still,
 *    the highlight eases back to Paper's exported frame.
 *
 * The layout box is `size` x `size`, the same as `KortixLogo`. The canvas is
 * larger and centred on it. Until the texture and shader are ready, or if the
 * device cannot compile the shader, the flat `KortixLogo` renders in the same
 * box.
 *
 * Reduce Motion, an unfocused screen and a backgrounded app draw the rest
 * frame and slow the sensor to 1 Hz.
 */
import * as React from 'react';
import { AccessibilityInfo, AppState, View } from 'react-native';
import {
  Canvas,
  FilterMode,
  Fill,
  ImageShader,
  MipmapMode,
  Shader,
  Skia,
  useImage,
} from '@shopify/react-native-skia';
import { useIsFocused } from 'expo-router';
import {
  SensorType,
  useAnimatedReaction,
  useAnimatedSensor,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { KortixLogo } from '@/components/kortix/KortixLogo';
import { shortestAngleDelta, smooth, tiltToHeat } from '@/lib/effects/heat-tilt';
import {
  HEATMAP_REST_TIME,
  HEATMAP_SKSL,
  HEATMAP_SWEEP_SECONDS,
  PAPER_HEATMAP_PARAMS as P,
  type HeatmapUniforms,
} from '@/lib/effects/heatmap-sksl';

type Tone = 'light' | 'dark';
type Rgba = [number, number, number, number];

/** Time constant of the baseline that tilt is measured against, seconds. */
const BASELINE_TAU = 1.5;
/**
 * Critically damped spring (damping ratio 1.01, about 1 s to settle). A spring
 * keeps its velocity when the target changes, so 25 sensor readings a second
 * make one continuous motion. A fresh timed ease per reading restarts at zero
 * velocity each time and looks like a stutter.
 */
const SPRING = { stiffness: 35, damping: 12, mass: 1, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.001 };
/** A target closer than this to the last one is not re-animated. */
const SWEEP_EPSILON = 0.01;
/** Below this sweep the direction is noise, so the angle holds its last value. */
const DIRECTION_MIN_SWEEP = 0.1;
const SENSOR_ACTIVE_MS = 40;
const SENSOR_IDLE_MS = 1000;

// Paper's `colors[0]` (outline and streaks) and `colors[1]` (body). Fixed
// brand-metal values, not themed UI surfaces. Dark is Paper's export. The
// shader maps low heat to transparent, so white vanishes on a white page and
// light is designed separately, not inverted.
// hex-allowlist: dark = white #FFFFFF and near-black #242424 (Paper's export); light = near-black #242424 and light gray #E6E6E6
const PALETTE: Record<Tone, { first: Rgba; second: Rgba }> = {
  dark: { first: [1, 1, 1, 1], second: [0.141, 0.141, 0.141, 1] },
  light: { first: [0.141, 0.141, 0.141, 1], second: [0.9, 0.9, 0.9, 1] },
};
const TRANSPARENT: Rgba = [0, 0, 0, 0];

const TEXTURE = require('@/assets/brand/kortix-heatmap.png');
const SAMPLING = { filter: FilterMode.Linear, mipmap: MipmapMode.None };

interface MetalKortixLogoProps {
  /** Side of the layout box, in points. Same meaning as `KortixLogo.size`. */
  size: number;
  tone: Tone;
}

export function MetalKortixLogo({ size, tone }: MetalKortixLogoProps) {
  const image = useImage(TEXTURE);
  const effect = React.useMemo(() => {
    const made = Skia.RuntimeEffect.Make(HEATMAP_SKSL);
    if (!made && __DEV__) console.warn('MetalKortixLogo: the heatmap shader did not compile');
    return made;
  }, []);

  const flat = <KortixLogo size={size} color={tone} />;
  if (!image || !effect) return flat;

  return <MetalCanvas size={size} tone={tone} image={image} effect={effect} />;
}

function MetalCanvas({
  size,
  tone,
  image,
  effect,
}: MetalKortixLogoProps & {
  image: NonNullable<ReturnType<typeof useImage>>;
  effect: NonNullable<ReturnType<typeof Skia.RuntimeEffect.Make>>;
}) {
  const reduceMotion = useReduceMotion();
  const isFocused = useIsFocused();
  const appActive = useAppActive();
  const running = isFocused && appActive && !reduceMotion;

  const rotation = useAnimatedSensor(SensorType.ROTATION, {
    interval: running ? SENSOR_ACTIVE_MS : SENSOR_IDLE_MS,
  });

  const sweep = useSharedValue(0);
  const angle = useSharedValue(0);
  const sweepTarget = useSharedValue(0);
  const angleTarget = useSharedValue(0);
  const baseline = useSharedValue({ pitch: 0, roll: 0, at: 0, seeded: false });

  useAnimatedReaction(
    () => rotation.sensor.value,
    (v) => {
      'worklet';
      if (!running) return;
      const now = Date.now();
      const b = baseline.value;
      if (!b.seeded) {
        baseline.value = { pitch: v.pitch, roll: v.roll, at: now, seeded: true };
        return;
      }
      const tilt = tiltToHeat(v.pitch - b.pitch, v.roll - b.roll);
      const k = 1 - Math.exp(-((now - b.at) / 1000) / BASELINE_TAU);
      baseline.value = {
        pitch: b.pitch + (v.pitch - b.pitch) * k,
        roll: b.roll + (v.roll - b.roll) * k,
        at: now,
        seeded: true,
      };

      if (Math.abs(tilt.sweep - sweepTarget.value) >= SWEEP_EPSILON) {
        sweepTarget.value = tilt.sweep;
        sweep.value = withSpring(tilt.sweep, SPRING);
      }
      if (tilt.sweep > DIRECTION_MIN_SWEEP) {
        // Turn the short way round: the angle never spins across the 180 line.
        const next = angleTarget.value + shortestAngleDelta(angleTarget.value, tilt.angleDeg);
        if (Math.abs(next - angleTarget.value) >= 1) {
          angleTarget.value = next;
          angle.value = withSpring(next, SPRING);
        }
      }
    },
    [running],
  );

  // Not running (Reduce Motion, another screen, the app in the background): the
  // reaction above is off, so ease back to the rest frame instead of freezing
  // mid-band.
  React.useEffect(() => {
    if (running) return;
    sweepTarget.value = 0;
    sweep.value = withSpring(0, SPRING);
  }, [running, sweep, sweepTarget]);

  const canvasSize = size / P.scale;
  const colors = PALETTE[tone];
  // Plain numbers, so the worklet below captures no Skia object.
  const imageWidth = image.width();
  const imageHeight = image.height();

  const uniforms = useDerivedValue<HeatmapUniforms>(() => ({
    u_resolution: [canvasSize, canvasSize],
    u_imageSize: [imageWidth, imageHeight],
    u_time: HEATMAP_REST_TIME + sweep.value * HEATMAP_SWEEP_SECONDS,
    u_scale: P.scale,
    u_angle: P.angle + angle.value,
    u_contour: P.contour,
    u_innerGlow: P.innerGlow,
    u_outerGlow: P.outerGlow,
    u_noise: P.noise,
    u_color0: colors.first,
    u_color1: colors.second,
    u_colorBack: TRANSPARENT,
  }));

  const offset = -(canvasSize - size) / 2;
  return (
    <View style={{ width: size, height: size, flexShrink: 0 }} pointerEvents="none">
      <Canvas style={{ position: 'absolute', left: offset, top: offset, width: canvasSize, height: canvasSize }}>
        <Fill>
          <Shader source={effect} uniforms={uniforms}>
            <ImageShader
              image={image}
              fit="fill"
              x={0}
              y={0}
              width={imageWidth}
              height={imageHeight}
              tx="clamp"
              ty="clamp"
              sampling={SAMPLING}
            />
          </Shader>
        </Fill>
      </Canvas>
    </View>
  );
}

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (alive) setReduceMotion(enabled);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduceMotion;
}

function useAppActive(): boolean {
  const [active, setActive] = React.useState(AppState.currentState === 'active');
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}
