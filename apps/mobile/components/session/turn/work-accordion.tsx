/**
 * A settled turn's work, folded behind one "Worked for 2m 14s" row (KRTX-2113).
 *
 * Mirrors apps/web `turn/turn-work-accordion.tsx` once the turn settles: the
 * row reads like a burst summary (`text-sm text-muted-foreground/70`, `gap-2`,
 * caret `size-3.5 text-muted-foreground/40`), and tapping it opens the work
 * inline with the `DisclosureContent` fold.
 *
 * Mobile departs from web on purpose: `SessionTurn` mounts this only when the
 * turn has settled, never while it works. Wrapping the live stream would put
 * it inside the fold's `overflow: hidden` view (clipping permission prompts
 * and card shadows) and would remount the reply of a turn that ends with no
 * work — the live view is the most-seen state, so it stays the plain list.
 * The cost: at settle the work collapses at once instead of folding.
 *
 * It always mounts closed, so a historical turn paints collapsed with no
 * animation (`DisclosureContent` skips its first run). The reader's choice
 * sticks while the turn is mounted.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { workedForLabel } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { DisclosureCaret, DisclosureContent } from '@/components/session/chain-of-thought';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import { WorkFoldContext } from './work-fold-context';

export function WorkAccordion({
  durationMs,
  gap,
  children,
}: {
  /** `turnDurationMs(turn)`; `null` reads "Worked". */
  durationMs: number | null;
  /** The segment stack gap: under the row and between the folded segments. */
  gap: number;
  children: ReactNode;
}) {
  const palette = useTurnPalette();
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 6, bottom: 6 }}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}
      >
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, TABULAR, { flexShrink: 1, color: palette.muted70 }]}>
          {workedForLabel(durationMs)}
        </Text>
        <DisclosureCaret open={open} color={palette.muted40} />
      </Pressable>
      <DisclosureContent open={open}>
        {/* The body mounts only while open, so every burst in it is under an opened row. */}
        <WorkFoldContext.Provider value>
          <View style={{ paddingTop: gap, gap }}>{children}</View>
        </WorkFoldContext.Provider>
      </DisclosureContent>
    </View>
  );
}

const TABULAR = { fontVariant: ['tabular-nums' as const] };
