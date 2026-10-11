/**
 * A settled turn's work, behind one "Worked for 2m 14s" row (KRTX-2113).
 *
 * The row reads like a burst summary (apps/web `turn/turn-work-accordion.tsx`
 * and mobile `ActivityBurst`: `text-sm text-muted-foreground/70`, `gap-2`,
 * trailing caret `size-3.5 text-muted-foreground/40`).
 *
 * Mobile departs from web on purpose: the work never expands inline. Tapping
 * the row opens the activity sheet (`useActivitySheetStore`, shown by
 * `ActivitySheetHost`) on every step of the turn's work — the same sheet a
 * burst row opens, over all of the turn's bursts and standalone calls
 * (`workParts`). Interim text is not a step and stays out of it.
 *
 * `SessionTurn` mounts this only once the turn has settled; while the turn
 * works the segments stream as the plain list.
 */

import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { workedForLabel, type Part } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { CaretRightIcon } from '@/lib/icons';
import { burstView } from '@/lib/session/activity';
import { useActivitySheetStore, type ActivityContextValue } from '@/lib/session/activity-sheet-store';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';

export function WorkRow({
  durationMs,
  parts,
  context,
}: {
  /** `turnDurationMs(turn)`; `null` reads "Worked". */
  durationMs: number | null;
  /** Every call of the turn's work (`workParts`). */
  parts: ReadonlyArray<Part>;
  context: ActivityContextValue;
}) {
  const palette = useTurnPalette();
  // The sheet's view is built on tap, not on mount: every settled turn in the
  // transcript mounts this row, and merging a long turn's steps is wasted work
  // for every row nobody opens.
  const openSheet = useCallback(
    () => useActivitySheetStore.getState().show(parts, burstView(parts, false), context),
    [parts, context],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the activity"
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={openSheet}
      style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}
    >
      <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, TABULAR, { flexShrink: 1, color: palette.muted70 }]}>
        {workedForLabel(durationMs)}
      </Text>
      <CaretRightIcon size={TURN_SPACE.caret} color={palette.muted40} />
    </Pressable>
  );
}

const TABULAR = { fontVariant: ['tabular-nums' as const] };
