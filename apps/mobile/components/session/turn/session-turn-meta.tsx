/**
 * SessionTurnMeta — the ⋯ button under a finished turn and the popover card
 * anchored to it with the turn's numbers: when it finished, how long it took,
 * what it cost, how many tokens it used.
 *
 * Mirrors apps/web `features/session/session-turn-meta.tsx`: the same
 * `Popover`, aligned to the button's start, `min-w-52 p-3` (Jay,
 * 2026-09-23: a popover card, not a bottom sheet). It opens 6pt ABOVE the
 * button (Jay, 2026-09-23), not below it like web. Rows come from
 * `turnMetaRows` (`lib/session/turn-meta.ts`), a port of web's
 * `sessionTurnMetaRows`. Tapping outside the card closes it.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Text } from '@/components/ui/text';
import { DotsThreeIcon } from '@/lib/icons';
import { turnMetaRows, type TurnMetaCost } from '@/lib/session/turn-meta';
import { OVERLAY_PORTAL_HOST } from '@/lib/ui/portal-hosts';
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

/** The card keeps 12pt clear of the screen edges and the safe area. */
const EDGE_GAP = 12;

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
  const insets = useSafeAreaInsets();
  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState<number | null>(null);

  // The native popover root is uncontrolled; it reports open and close here.
  const handleOpenChange = React.useCallback((next: boolean) => {
    // Read the clock on open, so the first visible frame is current.
    if (next) setNow(Date.now());
    setOpen(next);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  // Closed, `now` is null; the fallback only decides whether the button exists.
  const rows = React.useMemo(
    () => turnMetaRows({ endedAt, now: now ?? endedAt ?? 0, durationMs, cost }),
    [endedAt, now, durationMs, cost]
  );

  // A ⋯ that opens onto an empty panel is worse than no ⋯ at all.
  if (rows.length === 0) return null;

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          hitSlop={TURN_ACTION_HIT_SLOP}
          accessibilityLabel="Turn details"
          testID="session-turn-meta-trigger">
          <Icon
            as={DotsThreeIcon}
            weight="bold"
            size={TURN_ACTION_ICON_SIZE}
            color={withAlpha(THEME[scheme].foreground, 0.7)}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        portalHost={OVERLAY_PORTAL_HOST}
        insets={{
          top: insets.top + EDGE_GAP,
          bottom: insets.bottom + EDGE_GAP,
          left: insets.left + EDGE_GAP,
          right: insets.right + EDGE_GAP,
        }}
        className="w-auto min-w-52 p-3"
        testID="session-turn-meta-panel">
        <View className="gap-2">
          {rows.map((row) => (
            <View key={row.label} className="flex-row items-baseline justify-between gap-6">
              {/* `PopoverContent`'s TextClassContext (`text-popover-foreground`)
                  merges after the variant, so the muted colour is restated
                  by class to win. */}
              <Text variant="muted" className="text-muted-foreground" style={TEXT_XS}>
                {row.label}
              </Text>
              <Text style={[TEXT_XS, { fontVariant: ['tabular-nums'] }]}>{row.value}</Text>
            </View>
          ))}
        </View>
      </PopoverContent>
    </Popover>
  );
}
