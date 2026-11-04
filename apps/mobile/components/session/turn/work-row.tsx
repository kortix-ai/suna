/**
 * The "Worked for 2m 14s" row over a settled turn's work (KRTX-2113).
 *
 * Same shape as web `packages/ui/src/session/turn/turn-work-accordion.tsx`:
 * the label (`text-sm text-muted-foreground/70`), a trailing caret
 * (`size-3.5 text-muted-foreground/40`). While the row is open, a full-width
 * hairline under it marks where the work starts; a closed row has no line.
 *
 * The row owns only the toggle. `SessionTurn` keeps every segment in one keyed
 * list and hides the work in place while the row is closed, so an opened row
 * reads in call order and nothing remounts. Instant, no fold animation.
 */

import { Pressable, StyleSheet } from 'react-native';
import { workedForLabel } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { CaretDownIcon, CaretRightIcon } from '@/lib/icons';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';

export function WorkRow({
  durationMs,
  open,
  onToggle,
}: {
  /** `turnDurationMs(turn)`; `null` reads "Worked". */
  durationMs: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const palette = useTurnPalette();
  const Caret = open ? CaretDownIcon : CaretRightIcon;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      hitSlop={{ top: 6 }}
      onPress={onToggle}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: TURN_SPACE.gap2,
        ...(open && {
          paddingBottom: TURN_SPACE.gap2,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: palette.border,
        }),
      }}
    >
      <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, TABULAR, { flexShrink: 1, color: palette.muted70 }]}>
        {workedForLabel(durationMs)}
      </Text>
      <Caret size={TURN_SPACE.caret} color={palette.muted40} />
    </Pressable>
  );
}

const TABULAR = { fontVariant: ['tabular-nums' as const] };
