/**
 * sheet-push — a detail view inside a bottom sheet: the iOS push.
 *
 * A sheet that drills into a second view (the activity sheet's tool detail, a
 * secret's value form) swaps its content in place. The new view slides in from
 * the right (`PUSH_IN`); on Back the first view slides in from the left
 * (`POP_IN`). Strong ease-out, 250ms, no movement under reduced motion.
 *
 *   {detail ? (
 *     <Animated.View key={detail.key} entering={PUSH_IN} style={{ flex: 1 }}>…</Animated.View>
 *   ) : (
 *     <Animated.View key="list" entering={returning ? POP_IN : undefined} style={{ flex: 1 }}>…</Animated.View>
 *   )}
 *
 * The first view never animates on open: pass `POP_IN` only once the user has
 * come back from a detail. `SheetBackButton` is the pushed view's leading
 * control: `SheetTitleRow leading={<SheetBackButton onPress={back} />}`.
 */
import * as React from 'react';
import { Easing, ReduceMotion, SlideInLeft, SlideInRight } from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CaretLeftIcon } from '@/lib/icons';

const PUSH_MS = 250;
const PUSH_EASING = Easing.bezier(0.23, 1, 0.32, 1);

export const PUSH_IN = SlideInRight.duration(PUSH_MS).easing(PUSH_EASING).reduceMotion(ReduceMotion.System);
export const POP_IN = SlideInLeft.duration(PUSH_MS).easing(PUSH_EASING).reduceMotion(ReduceMotion.System);

export function SheetBackButton({ onPress }: { onPress: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="rounded-full"
      accessibilityLabel="Back"
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <Icon as={CaretLeftIcon} size={20} className="text-foreground" />
    </Button>
  );
}
