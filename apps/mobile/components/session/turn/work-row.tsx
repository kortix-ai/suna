/**
 * A settled turn's work, behind one "Worked for 2m 14s" row (KRTX-2113).
 *
 * The row reads like a burst summary (apps/web `turn/turn-work-accordion.tsx`
 * and mobile `ActivityBurst`: `text-sm text-muted-foreground/70`, `gap-2`,
 * trailing caret `size-3.5 text-muted-foreground/40`).
 *
 * A tap opens the work inline, the way web and Codex read it: the agent's
 * interim text in full, and between two sentences one burst line named by what
 * it did ("Ran 9 commands, read 2 files"). That line still opens the activity
 * sheet on its steps. `SessionTurn` renders the work as siblings under this row
 * while `open`; the row only owns the toggle. Instant, no fold animation.
 *
 * `SessionTurn` mounts this only once the turn has settled; while the turn
 * works the segments stream as the plain list.
 */

import { Pressable } from 'react-native';
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
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={onToggle}
      style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}
    >
      <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, TABULAR, { flexShrink: 1, color: palette.muted70 }]}>
        {workedForLabel(durationMs)}
      </Text>
      <Caret size={TURN_SPACE.caret} color={palette.muted40} />
    </Pressable>
  );
}

const TABULAR = { fontVariant: ['tabular-nums' as const] };
