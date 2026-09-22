/**
 * SessionTurnMeta — the ⋯ button under a finished turn and the bottom sheet
 * with the turn's numbers: when it finished, how long it took, what it cost,
 * how many tokens it used.
 *
 * Mirrors apps/web `features/session/session-turn-meta.tsx`. Web anchors a
 * popover to the button; a phone has no room for an anchored panel, so the
 * same label → value rows open in the app's bottom sheet. Rows come from
 * `turnMetaRows` (`lib/session/turn-meta.ts`), a port of web's
 * `sessionTurnMetaRows`.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { Sheet, SheetBody, type SheetRef } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { DotsThreeOutlineIcon } from '@/lib/icons';
import { turnMetaRows, type TurnMetaCost } from '@/lib/session/turn-meta';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** Web ticks the relative "Finished" row every 15s while the panel is open. */
const TICK_MS = 15_000;

/** Web `size-[1.05rem]` = 16.8px. */
export const TURN_ACTION_ICON_SIZE = 17;
/**
 * Turn action buttons are `Button size="icon-sm"` (28pt box). 8pt above and
 * below make the touch target 44pt tall; 4pt at the sides (36pt wide) stops
 * short of the neighbouring action, which sits 2pt away.
 */
export const TURN_ACTION_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 } as const;

/** Web `text-xs`: 13px / 16px. Mobile's stock `text-xs` is 12/16. */
const TEXT_XS = { fontSize: 13, lineHeight: 16 } as const;

export function SessionTurnMeta({
  endedAt,
  durationMs,
  cost,
}: {
  endedAt: number | null;
  durationMs: number | null;
  cost: TurnMetaCost | null | undefined;
}) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const sheetRef = React.useRef<SheetRef>(null);
  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState<number | null>(null);

  const handleOpen = React.useCallback(() => {
    // Read the clock on open, so the first visible frame is current.
    setNow(Date.now());
    setOpen(true);
    sheetRef.current?.open();
  }, []);

  const handleDismiss = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  // Closed, `now` is null; the fallback only decides whether the button exists.
  const rows = React.useMemo(
    () => turnMetaRows({ endedAt, now: now ?? endedAt ?? 0, durationMs, cost }),
    [endedAt, now, durationMs, cost],
  );

  // A ⋯ that opens onto an empty panel is worse than no ⋯ at all.
  if (rows.length === 0) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        hitSlop={TURN_ACTION_HIT_SLOP}
        onPress={handleOpen}
        accessibilityLabel="Turn details"
        testID="session-turn-meta-trigger">
        <Icon
          as={DotsThreeOutlineIcon}
          weight="fill"
          size={TURN_ACTION_ICON_SIZE}
          color={withAlpha(THEME[scheme].foreground, 0.7)}
        />
      </Button>
      <Sheet ref={sheetRef} enablePanDownToClose onDismiss={handleDismiss}>
        <SheetBody>
          <View className="gap-2" testID="session-turn-meta-panel">
            {rows.map((row) => (
              <View key={row.label} className="flex-row items-baseline justify-between gap-6">
                <Text variant="muted" style={TEXT_XS}>
                  {row.label}
                </Text>
                <Text style={[TEXT_XS, { fontVariant: ['tabular-nums'] }]}>{row.value}</Text>
              </View>
            ))}
          </View>
        </SheetBody>
      </Sheet>
    </>
  );
}
