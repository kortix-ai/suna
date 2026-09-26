/**
 * useTiltMotion — the phone's movement as two UI-thread values every logo
 * shader reads: `sweep` (0 at rest, 1 fully moved) and `angle` (the direction
 * of the move, degrees). One hook, so the heatmap, liquid-metal and dither
 * styles move the same way.
 *
 * It moves only while the phone moves, and costs nothing at rest:
 *  - There is no frame loop. Reanimated's rotation sensor (built in; not
 *    `expo-sensors`) feeds a reaction that retargets a spring only when the
 *    target changes. When the spring settles, no value changes and Skia draws
 *    nothing.
 *  - Movement is measured against a baseline that follows the phone with a 1.5 s
 *    time constant, so holding the phone upright (about 60 degrees from flat)
 *    is rest, and a quick move away from that pose is the input. Held still,
 *    the values ease back to rest.
 *
 * `running` false (Reduce Motion, another screen, the app in the background)
 * eases the sweep back to 0 and slows the sensor to 1 Hz.
 */
import * as React from 'react';
import {
  SensorType,
  useAnimatedReaction,
  useAnimatedSensor,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';

import { shortestAngleDelta, tiltToHeat } from '@/lib/effects/heat-tilt';

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

export function useTiltMotion(running: boolean): { sweep: SharedValue<number>; angle: SharedValue<number> } {
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

  // Not running: the reaction above is off, so ease back to the rest frame
  // instead of freezing mid-move.
  React.useEffect(() => {
    if (running) return;
    sweepTarget.value = 0;
    sweep.value = withSpring(0, SPRING);
  }, [running, sweep, sweepTarget]);

  return { sweep, angle };
}
