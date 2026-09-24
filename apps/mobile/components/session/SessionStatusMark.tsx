/**
 * SessionStatusMark — the status mark before a session title, in the project
 * sidebar and on the Sessions page. One mark per display status; each differs
 * in shape as well as colour, so colour is never the only cue:
 *
 *   running   filled green dot
 *   stopped   hollow muted ring (also completed sessions)
 *   starting  pulsing yellow ring with a centre dot (static under reduced motion)
 *   failed    red diamond
 *   needs-you blue dot inside a soft blue halo
 *
 * A session is `needs-you` while the review inbox holds a pending item from
 * it (`lib/session/needs-you`): the drawer's Needs you group and the Sessions
 * page pass that count to `sessionDisplayStatus`.
 *
 * The mark is hidden from screen readers: the row's label speaks the status
 * (`sessionStatusLabel`).
 */

import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { SessionDisplayStatus } from '@/lib/session/session-list';

/** Yellow ring with a centre dot, pulsing. Static under reduced motion. */
function StartingMark() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  React.useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withTiming(0.35, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    return () => cancelAnimation(opacity);
  }, [reducedMotion, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={style}>
      <View className="size-2.5 items-center justify-center rounded-full border-[1.5px] border-kortix-yellow">
        <View className="size-1 rounded-full bg-kortix-yellow" />
      </View>
    </Animated.View>
  );
}

/** A 20pt slot (`h-5 min-w-5`) holding the mark for `status`. */
export function SessionStatusMark({ status }: { status: SessionDisplayStatus }) {
  let mark: React.ReactNode;
  switch (status) {
    case 'running':
      mark = <View className="size-2.5 rounded-full bg-kortix-green" />;
      break;
    case 'starting':
      mark = <StartingMark />;
      break;
    case 'failed':
      mark = <View className="size-2 rotate-45 rounded-[1px] bg-destructive" />;
      break;
    case 'needs-you':
      mark = (
        <View className="size-4 items-center justify-center rounded-full bg-kortix-blue/20">
          <View className="size-2 rounded-full bg-kortix-blue" />
        </View>
      );
      break;
    case 'stopped':
    default:
      mark = <View className="size-2.5 rounded-full border-[1.5px] border-muted-foreground" />;
      break;
  }
  return (
    <View
      className="h-5 min-w-5 items-center justify-center"
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      {mark}
    </View>
  );
}
