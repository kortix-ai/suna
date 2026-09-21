/**
 * ModelPickerSheet — the sheet behind the composer's model pill, on the
 * project home and in a thread.
 *
 * A `PickerSheet` of models (grouped by provider when the options carry one).
 * Choosing a model applies and the sheet stays open. `thinking` adds one stepped slider
 * above the list for the active model's thinking levels: Default, then each
 * level. A level applies on release and the sheet stays open. The project home
 * passes no `thinking`: its catalog has no levels.
 */
import * as React from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import type { SheetRef } from '@/components/kortix/sheet';
import { PickerSheet } from '@/components/session/PickerSheet';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import {
  nearestStop,
  stopOffset,
  variantDisplayName,
  type PickerOption,
} from '@/lib/session/composer-config';

/** React key of the "no level" (`null`) stop. */
const DEFAULT_LEVEL = '__default__';

export interface ModelThinking {
  /** The active model's levels. Empty hides the control. */
  levels: string[];
  selected: string | null;
  onSelect: (level: string | null) => void;
}

interface ModelPickerSheetProps {
  options: PickerOption[];
  /** The model a send would use now; its row carries the check. */
  activeKey: string | null;
  onSelect: (key: string) => void;
  thinking?: ModelThinking;
  /** "Connect provider" in the empty state: the project offers no model. */
  onConnect?: () => void;
}

export const ModelPickerSheet = React.forwardRef<SheetRef, ModelPickerSheetProps>(
  ({ options, activeKey, onSelect, thinking, onConnect }, ref) => (
    <PickerSheet
      ref={ref}
      title="Model"
      options={options}
      activeKey={activeKey}
      onSelect={onSelect}
      searchLabel="Search models"
      emptyLabel="No matching models"
      // Stays open after a pick (Jay, 2026-09-21): the check moves, the
      // Thinking slider switches to the new model's levels, and the user
      // closes the sheet with a swipe or a tap outside when done.
      closeOnSelect={false}
      // Web's copy (model-selector.tsx, the truly-empty state).
      empty={onConnect ? { title: 'No models available', actionLabel: 'Connect provider', onAction: onConnect } : undefined}>
      {thinking && thinking.levels.length > 0 ? <ThinkingControl {...thinking} /> : null}
    </PickerSheet>
  ),
);
ModelPickerSheet.displayName = 'ModelPickerSheet';

/** The track is a 44pt touch target; the thumb sits 4pt inside it. */
const TRACK_HEIGHT = 44;
const TRACK_PAD = 4;
const THUMB_SIZE = TRACK_HEIGHT - TRACK_PAD * 2;
/** Release and tap: a spring keeps the drag's velocity. No bounce: this is chrome. */
const SNAP_SPRING = { duration: 300, dampingRatio: 1 };

/**
 * A stepped slider: Default, then each level, left to right. The thumb follows
 * the finger 1:1, the header names the stop under it, and a release snaps to
 * the nearest stop and applies it. A tap on the track jumps there. Only
 * `transform` animates (thumb and fill). Reduced motion: the thumb snaps with
 * no spring. Vertical drags fail the pan, so the sheet still scrolls and closes.
 */
function ThinkingControl({ levels, selected, onSelect }: ModelThinking) {
  const stops = React.useMemo<(string | null)[]>(() => [null, ...levels], [levels]);
  const count = stops.length;
  const selectedIndex = Math.max(0, stops.indexOf(selected));
  const reducedMotion = useReducedMotion();

  const [trackWidth, setTrackWidth] = React.useState(0);
  const travel = Math.max(0, trackWidth - TRACK_PAD * 2 - THUMB_SIZE);
  // The stop under the thumb while dragging; the header reads it.
  const [liveIndex, setLiveIndex] = React.useState(selectedIndex);

  const offset = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const hoverIndex = useSharedValue(selectedIndex);

  // Follow the applied level: first layout, a new model, a pick made elsewhere.
  React.useEffect(() => {
    setLiveIndex(selectedIndex);
    hoverIndex.value = selectedIndex;
    offset.value = stopOffset(selectedIndex, travel, count);
  }, [selectedIndex, travel, count, offset, hoverIndex]);

  const hover = React.useCallback((index: number) => {
    haptics.selection();
    setLiveIndex(index);
  }, []);
  const commit = React.useCallback(
    (index: number) => {
      if (index !== selectedIndex) onSelect(stops[index] ?? null);
    },
    [selectedIndex, onSelect, stops],
  );

  const gesture = React.useMemo(() => {
    const settle = (index: number, velocity: number) => {
      'worklet';
      const target = stopOffset(index, travel, count);
      offset.value = reducedMotion ? target : withSpring(target, { ...SNAP_SPRING, velocity });
      if (index !== hoverIndex.value) {
        hoverIndex.value = index;
        runOnJS(hover)(index);
      }
      runOnJS(commit)(index);
    };
    const pan = Gesture.Pan()
      .activeOffsetX([-6, 6])
      .failOffsetY([-12, 12])
      .onStart(() => {
        dragStart.value = offset.value;
      })
      .onUpdate((e) => {
        offset.value = Math.min(travel, Math.max(0, dragStart.value + e.translationX));
        const index = nearestStop(offset.value, travel, count);
        if (index !== hoverIndex.value) {
          hoverIndex.value = index;
          runOnJS(hover)(index);
        }
      })
      .onEnd((e) => settle(nearestStop(offset.value, travel, count), e.velocityX));
    const tap = Gesture.Tap().onEnd((e) =>
      settle(nearestStop(e.x - TRACK_PAD - THUMB_SIZE / 2, travel, count), 0),
    );
    return Gesture.Exclusive(pan, tap);
  }, [travel, count, reducedMotion, offset, dragStart, hoverIndex, hover, commit]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  // Full-width fill, slid left so its right edge ends at the thumb's right edge.
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value + THUMB_SIZE + TRACK_PAD * 2 - trackWidth }],
  }));

  const step = (delta: number) => {
    const index = Math.min(count - 1, Math.max(0, selectedIndex + delta));
    if (index !== selectedIndex) {
      haptics.selection();
      onSelect(stops[index] ?? null);
    }
  };

  return (
    <View>
      <View className="mb-2 flex-row items-baseline justify-between px-2">
        <Text variant="muted">Thinking</Text>
        <Text variant="small">{variantDisplayName(stops[liveIndex] ?? null)}</Text>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          className="justify-center overflow-hidden rounded-full bg-secondary"
          style={{ height: TRACK_HEIGHT }}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Thinking"
          accessibilityValue={{ text: variantDisplayName(selected) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}>
          <Reanimated.View
            pointerEvents="none"
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/10"
            style={[{ width: trackWidth }, fillStyle]}
          />
          {stops.map((level, index) => (
            <View
              key={level ?? DEFAULT_LEVEL}
              pointerEvents="none"
              className="absolute size-1.5 rounded-full bg-muted-foreground/50"
              style={{ left: TRACK_PAD + THUMB_SIZE / 2 + stopOffset(index, travel, count) - 3 }}
            />
          ))}
          <Reanimated.View
            pointerEvents="none"
            className="absolute rounded-full bg-primary"
            style={[{ left: TRACK_PAD, width: THUMB_SIZE, height: THUMB_SIZE }, thumbStyle]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
